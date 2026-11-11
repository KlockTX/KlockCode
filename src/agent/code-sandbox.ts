/**
 * run_code 沙箱子进程的**父侧客户端**：负责起进程、泵消息、收结果、必要时杀掉。
 *
 * 协议与边界见 code-host.ts。这里只做三件事：
 *  - 找到一个能跑的沙箱入口（生产是 dist 里的 .js；源码直跑时交给 tsx）；
 *  - 把子进程发来的 host call 交给 code-mode 的 dispatcher（路径守卫/审批在那里）；
 *  - 超时与中止**直接 kill 进程**，而不是拒绝一个还在跑的 Promise——
 *    `Promise.race` 只是让调用方不再等，那个死循环还在烧 CPU。
 */
import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 子进程堆上限。run_code 的输入侧有 CODE_MODE_MAX_READ_CHARS × CODE_MODE_MAX_CALLS
 * 的天花板，正常分析远到不了这里；设上限是为了让"写爆内存"死的是沙箱而不是应用。
 */
const SANDBOX_HEAP_MB = 512;

export type SandboxOutcome =
  | { ok: true; value: string }
  | { ok: false; error: string };

type ChildMessage =
  | { type: "call"; id: number; payload: string }
  | { type: "log"; line: string }
  | { type: "done"; ok: true; value: string }
  | { type: "done"; ok: false; error: string };

/**
 * 沙箱入口解析：dist 里是编译产物，源码直跑（vitest / tsx）时没有 .js，
 * 交给 tsx 直接跑 .ts。两条路径都必须是**真实文件**，绝不回退到进程内 vm——
 * 回退就等于"隔离失败时静默降级成没有隔离"。
 */
function sandboxEntry(): { file: string; execArgv: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(here, "code-host.js");
  if (existsSync(compiled)) return { file: compiled, execArgv: [] };
  const source = path.join(here, "code-host.ts");
  if (existsSync(source)) return { file: source, execArgv: ["--import", "tsx"] };
  throw new Error(
    `run_code sandbox entry is missing (looked for ${compiled} and ${source}); run pnpm build:agent`,
  );
}

export function spawnSandboxHost(): ChildProcess {
  const entry = sandboxEntry();
  return fork(entry.file, [], {
    // 桌面端 process.execPath 是 KlockCode.exe；没有它 fork 会再弹一个应用窗口
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    execArgv: [...entry.execArgv, `--max-old-space-size=${SANDBOX_HEAP_MB}`],
    // stdout 不用（协议走 IPC）；stderr 收进来，OOM / abort 的原始信息能进日志尾巴
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
}

export function killChild(child: ChildProcess | null | undefined): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // 已经退出：无事可做
  }
}

/** 预算的人类可读形式：不足 1s 时按毫秒写，别把 400ms 说成 "0s"。 */
export function budgetLabel(budgetMs: number): string {
  return budgetMs >= 1000 ? `${Math.round(budgetMs / 1000)}s` : `${Math.round(budgetMs)}ms`;
}

/** 跑一段代码，返回最终值或错误。超时/中止都以 kill 子进程收场。 */
export function runInSandboxHost(
  child: ChildProcess,
  options: {
    code: string;
    budgetMs: number;
    dispatch: (payload: string) => Promise<string>;
    log: (line: string) => void;
    signal?: AbortSignal;
  },
): Promise<SandboxOutcome> {
  return new Promise<SandboxOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: SandboxOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const onAbort = (): void => {
      killChild(child);
      finish({ ok: false, error: "run_code aborted." });
    };
    const timer = setTimeout(() => {
      // 墙钟到点就是到点：杀掉进程，剩下的地址空间不会继续跑
      killChild(child);
      finish({
        ok: false,
        error: `run_code exceeded the ${budgetLabel(options.budgetMs)} limit`,
      });
    }, options.budgetMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    const reply = (id: number, payload: string): void => {
      if (!child.connected) return;
      try {
        child.send({ type: "reply", id, payload });
      } catch {
        // 通道已关：子进程正在退出，结果无所谓
      }
    };

    child.on("message", (raw: unknown) => {
      const message = raw as ChildMessage | undefined;
      if (message === undefined || typeof message !== "object") return;
      if (message.type === "call") {
        const id = message.id;
        const payload = message.payload;
        void Promise.resolve(options.dispatch(payload)).then(
          (response) => reply(id, response),
          (error: unknown) =>
            reply(
              id,
              JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
        );
        return;
      }
      if (message.type === "log") {
        if (typeof message.line === "string") options.log(message.line);
        return;
      }
      if (message.type === "done") {
        finish(
          message.ok === true
            ? { ok: true, value: String(message.value) }
            : { ok: false, error: String(message.error) },
        );
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) options.log(`sandbox stderr: ${text.slice(0, 2000)}`);
    });

    child.on("error", (error: Error) => {
      finish({ ok: false, error: `sandbox process error: ${error.message}` });
    });
    child.on("exit", (code, signal) => {
      finish({
        ok: false,
        error:
          `sandbox process exited (code ${code ?? "null"}` +
          `${signal ? `, signal ${signal}` : ""}) before returning a value`,
      });
    });

    if (!child.connected) {
      finish({ ok: false, error: "sandbox process has no IPC channel" });
      return;
    }
    try {
      child.send({ type: "run", code: options.code, budgetMs: options.budgetMs });
    } catch (error) {
      finish({
        ok: false,
        error: `sandbox process is not reachable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}
