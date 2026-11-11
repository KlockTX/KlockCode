/**
 * PTC 式 code mode（run_code）：模型写一段异步 JS，在**独立子进程**的 Node vm realm
 * 里执行，代码内部通过 `meow.*` 桥调用宿主工具。
 *
 * 省 Token 语义（参考 deepseek-harness 的 PTC，"only the outer curated result enters
 * model history"）：子工具调用的中间结果只留在沙箱内存和执行日志里，**绝不进模型上下文**；
 * 只有最终 return 值（截断后）进入对话。N 轮「grep → 读 → 再 grep」的往返合并成 1 轮，
 * 每一轮的全上下文重发随之消失。
 *
 * 桥分两级：
 *  - 只读（read / readMany / grep / glob / listDir）：沙箱自己实现，零审批；
 *  - 宿主工具（write / edit / multiEdit / run）：交给 runtime 注入的 hostToolBridge，
 *    走与普通工具调用完全相同的路径守卫与审批（AllAgent 的 call_tool 同款语义：
 *    "Each operation retains its permissions, tool budget and trace"）。没有注入
 *    桥时（例如只读子 Agent）这四个方法直接报错，不静默降级。
 *
 * 安全边界：vm 只是"另一个 realm"，不是边界。用户代码跑在独立子进程里
 * （见 code-host.ts / code-sandbox.ts）：一次逃逸拿到的是那个进程，而不是 agent
 * 进程；死循环/异步挂起由父侧墙钟直接 kill（不是 Promise.race 假装超时）；内存有
 * --max-old-space-size 上限，写爆了死的是沙箱。子进程里没有 require / process /
 * fetch / import，只暴露 meow 桥和受限 console；只读桥是白名单，写操作一律经过
 * 宿主审批。同步死循环另有 vm 自身的 timeout 兜一层。
 */

import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { budgetLabel, killChild, runInSandboxHost, spawnSandboxHost, type SandboxOutcome } from "./code-sandbox.js";
import { serializeResultValue } from "./code-mode-serialize.js";
import { readTextFile } from "./edit-content.js";
import { canonicalPathSync, IGNORED_ENTRY_NAMES, resolveToolPath } from "./paths.js";
import { recordRead } from "./read-state.js";
import { globPaths, grepMatches } from "./search.js";
import { sweepToolOutput } from "./tool-output.js";

export const CODE_MODE_TIMEOUT_MS = 30_000;
/** 最终返回值进入对话的上限；超出截断（完整值在日志里，可按需续读）。 */
export const CODE_MODE_MAX_RESULT_CHARS = 12_000;
/** 沙箱内单文件读取上限：够分析用，又不至于让一段代码把巨型文件拖进内存。 */
export const CODE_MODE_MAX_READ_CHARS = 200_000;
/** 内部工具调用次数上限：防失控循环刷桥。 */
export const CODE_MODE_MAX_CALLS = 200;
const CODE_MODE_MAX_LOG_CHARS = 40_000;
const CONSOLE_TAIL_LINES = 8;

const CODE_MODE_LOG_DIR = path.join(".klockcode", "tool-output");

export type CodeModeResult = { output: string; ok: boolean };

/** 宿主工具执行结果：与普通工具调用同一套 ok/output 语义。 */
export type HostToolResult = { ok: boolean; output: string };

/**
 * 宿主工具桥：runtime 注入，负责路径守卫、审批与真实执行。
 * tool 取值固定为 write_file / edit_file / multi_edit / run_command。
 */
export type HostToolBridge = (
  tool: "write_file" | "edit_file" | "multi_edit" | "run_command",
  args: Record<string, unknown>,
) => Promise<HostToolResult>;

type SandboxBridge = {
  read: (target: string) => Promise<string>;
  readMany: (targets: string[]) => Promise<Array<{ path: string; content?: string; error?: string }>>;
  grep: (
    pattern: string,
    options?: { fixed?: boolean; caseSensitive?: boolean; maxResults?: number; path?: string },
  ) => Promise<Array<{ path: string; line: number; text: string }>>;
  glob: (pattern: string, options?: { path?: string; maxResults?: number }) => Promise<string[]>;
  listDir: (target?: string) => Promise<Array<{ name: string; type: "dir" | "file" }>>;
  write: (target: string, content: string, options?: { force?: boolean }) => Promise<HostToolResult>;
  edit: (
    target: string,
    oldString: string,
    newString: string,
    options?: { replaceAll?: boolean },
  ) => Promise<HostToolResult>;
  multiEdit: (edits: Array<Record<string, unknown>>) => Promise<HostToolResult>;
  run: (command: string) => Promise<HostToolResult>;
};

export async function runCodeInSandbox(input: {
  workspace: string;
  code: string;
  allowOutsideWorkspace?: boolean;
  signal?: AbortSignal;
  /** 宿主写/命令桥；缺省时 meow.write/edit/multiEdit/run 直接报错（只读上下文） */
  hostToolBridge?: HostToolBridge;
  /** 测试覆盖用：默认 CODE_MODE_TIMEOUT_MS */
  timeoutMs?: number;
}): Promise<CodeModeResult> {
  const { workspace } = input;
  const allowOutside = Boolean(input.allowOutsideWorkspace);
  const budgetMs = input.timeoutMs ?? CODE_MODE_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onOuterAbort, { once: true });

  const logLines: string[] = [];
  const pushLog = (line: string): void => {
    if (logLines.length < 400) logLines.push(line);
  };
  let calls = 0;

  /** 每次桥调用前的预算闸：外部中止 / 墙钟超限 / 调用数超限都会抛进沙箱代码。 */
  const assertBudget = (): void => {
    if (input.signal?.aborted) throw new Error("run_code aborted.");
    if (Date.now() >= deadline) {
      throw new Error(`run_code ${budgetLabel(budgetMs)} time budget exhausted.`);
    }
    calls += 1;
    if (calls > CODE_MODE_MAX_CALLS) {
      throw new Error(`run_code internal call cap (${CODE_MODE_MAX_CALLS}) reached.`);
    }
  };

  const requireString = (value: unknown, label: string): string => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`meow: ${label} expects a non-empty string.`);
    }
    return value;
  };

  const describeReadFailure = (
    target: unknown,
    outcome: Extract<Awaited<ReturnType<typeof readTextFile>>, { ok: false }>,
  ): string => {
    const name = String(target);
    switch (outcome.reason) {
      case "missing":
        return `meow.read: file not found: ${name}`;
      case "directory":
        return `meow.read: ${name} is a directory, not a file.`;
      case "binary":
        return `meow.read: ${name} looks like a binary file; only UTF-8 text is supported.`;
      case "not-utf8":
        return `meow.read: ${name} is not valid UTF-8 text.`;
      case "too-large":
        return `meow.read: ${name} is ${outcome.size} bytes, above the text reader limit.`;
    }
  };

  const readOne = async (target: string): Promise<string> => {
    const file = await resolveToolPath(workspace, target, allowOutside);
    const outcome = await readTextFile(file, { headOnly: true });
    if (!outcome.ok) throw new Error(describeReadFailure(target, outcome));
    let { content } = outcome.file;
    if (content.length > CODE_MODE_MAX_READ_CHARS) {
      content = `${content.slice(0, CODE_MODE_MAX_READ_CHARS)}\n... [truncated at ${CODE_MODE_MAX_READ_CHARS} chars]`;
    }
    // 与 read_file 同口径登记读取：沙箱看过这一版，后续 edit 的过期检查才有基准
    await recordRead(file).catch(() => undefined);
    return content;
  };

  /**
   * 转发一次宿主写/命令调用：预算照常扣、日志照常记，但执行权在 runtime
   * （路径守卫、只读/计划模式拦截、审批弹窗、审阅记录都在那边，沙箱不复制这些规则）。
   */
  const runHost = async (
    label: string,
    tool: "write_file" | "edit_file" | "multi_edit" | "run_command",
    args: Record<string, unknown>,
  ): Promise<HostToolResult> => {
    assertBudget();
    const host = input.hostToolBridge;
    if (!host) {
      throw new Error(
        `meow.${label}: host write/command tools are unavailable in this context (read-only run_code).`,
      );
    }
    const result = await host(tool, args);
    pushLog(`${label}(${String(args.path ?? args.command ?? "")}) -> ${result.ok ? "ok" : "failed"}`);
    return { ok: result.ok, output: result.output };
  };

  const bridge: SandboxBridge = {
    read: async (target: unknown) => {
      assertBudget();
      const path0 = requireString(target, "read(path)");
      const content = await readOne(path0);
      pushLog(`read(${path0}) -> ${content.length} chars`);
      return content;
    },
    readMany: async (targets: unknown) => {
      assertBudget();
      if (!Array.isArray(targets)) {
        throw new Error("meow.readMany expects an array of path strings.");
      }
      const list = targets.slice(0, 50).map((item) => String(item));
      const results = await Promise.all(
        list.map(async (target) => {
          try {
            const content = await readOne(target);
            pushLog(`readMany -> ${target}: ${content.length} chars`);
            return { path: target, content };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            pushLog(`readMany -> ${target}: ERROR ${message}`);
            return { path: target, error: message };
          }
        }),
      );
      return results;
    },
    grep: async (pattern: unknown, options?: unknown) => {
      assertBudget();
      const opts = (options ?? {}) as Record<string, unknown>;
      const matches = await grepMatches(
        workspace,
        typeof opts.path === "string" && opts.path.trim() ? opts.path : ".",
        requireString(pattern, "grep(pattern)"),
        {
          fixed: opts.fixed === true,
          caseSensitive: opts.caseSensitive !== false,
          maxResults: typeof opts.maxResults === "number" ? opts.maxResults : undefined,
        },
        controller.signal,
        allowOutside,
      );
      pushLog(
        `grep(${JSON.stringify(pattern).slice(0, 120)}) -> ${matches.length} matches`,
      );
      return matches;
    },
    glob: async (pattern: unknown, options?: unknown) => {
      assertBudget();
      const opts = (options ?? {}) as Record<string, unknown>;
      const files = await globPaths(
        workspace,
        typeof opts.path === "string" && opts.path.trim() ? opts.path : ".",
        requireString(pattern, "glob(pattern)"),
        typeof opts.maxResults === "number" ? opts.maxResults : undefined,
        controller.signal,
        allowOutside,
      );
      pushLog(`glob(${JSON.stringify(pattern).slice(0, 120)}) -> ${files.length} paths`);
      return files;
    },
    listDir: async (target?: unknown) => {
      assertBudget();
      const dir = await resolveToolPath(
        workspace,
        typeof target === "string" && target.trim() ? target : ".",
        allowOutside,
      );
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const visible = entries
        .filter((entry) => !IGNORED_ENTRY_NAMES.has(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
        .map((entry) => ({
          name: entry.name,
          type: (entry.isDirectory() ? "dir" : "file") as "dir" | "file",
        }));
      pushLog(`listDir(${String(target ?? ".")}) -> ${visible.length} entries`);
      return visible;
    },
    // ---- 宿主写/命令桥：路径守卫与审批都在 runtime，沙箱只负责转发 ----
    write: async (target: unknown, content: unknown, options?: unknown) => {
      const opts = (options ?? {}) as Record<string, unknown>;
      return runHost("write", "write_file", {
        path: requireString(target, "write(path)"),
        content: typeof content === "string" ? content : String(content ?? ""),
        ...(opts.force === true ? { force: true } : {}),
      });
    },
    edit: async (target: unknown, oldString: unknown, newString: unknown, options?: unknown) => {
      const opts = (options ?? {}) as Record<string, unknown>;
      return runHost("edit", "edit_file", {
        path: requireString(target, "edit(path)"),
        oldString: requireString(oldString, "edit(oldString)"),
        newString: typeof newString === "string" ? newString : String(newString ?? ""),
        ...(opts.replaceAll === true ? { replaceAll: true } : {}),
      });
    },
    multiEdit: async (edits: unknown) => {
      if (!Array.isArray(edits) || !edits.length) {
        throw new Error("meow.multiEdit expects a non-empty array of { path, oldString, newString }.");
      }
      return runHost("multiEdit", "multi_edit", {
        edits: edits.slice(0, 50).map((item) => ({ ...(item as Record<string, unknown>) })),
      });
    },
    run: async (command: unknown) =>
      runHost("run", "run_command", {
        command: requireString(command, "run(command)"),
      }),
  };

  /** 宿主 dispatcher：只接受/返回 JSON 字符串，宿主函数与对象完全不进入 vm realm。 */
  const dispatchHostCall = async (payload: unknown): Promise<string> => {
    try {
      if (typeof payload !== "string") throw new Error("meow: invalid call payload.");
      const request = JSON.parse(payload) as { method?: unknown; args?: unknown };
      const method = typeof request.method === "string" ? request.method : "";
      const args = Array.isArray(request.args) ? (request.args as unknown[]) : [];
      const fn = (bridge as unknown as Record<string, (...values: unknown[]) => unknown>)[method];
      if (typeof fn !== "function") throw new Error(`meow: unknown method ${method}.`);
      const value = await fn(...args);
      return JSON.stringify({ ok: true, value });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ ok: false, error: message });
    }
  };

  // 用户代码不在这里跑：vm 在同进程里不是边界，一次逃逸拿到的就是整个宿主。
  // 这里只起一个子进程并泵消息，桥、路径守卫、审批、读取登记全部留在本进程。
  const seconds = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

  let child: ChildProcess | null = null;

  const finishError = async (error: unknown): Promise<CodeModeResult> => {
    input.signal?.removeEventListener("abort", onOuterAbort);
    controller.abort(); // 让仍在跑的 rg / 读取尽快退出
    killChild(child);
    child = null;
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const logPath = await persistLog(workspace, logLines);
    const tail = logLines.slice(-CONSOLE_TAIL_LINES).join("\n");
    return {
      ok: false,
      output:
        `[run_code] failed after ${calls} internal call(s) in ${seconds()}: ${message}` +
        (tail ? `\nRecent sandbox output:\n${tail}` : "") +
        (logPath ? `\nFull log: ${logPath}` : ""),
    };
  };

  // 启动前就已被中止：不必再起一个进程
  if (input.signal?.aborted) return finishError(new Error("run_code aborted."));

  let outcome: SandboxOutcome;
  try {
    child = spawnSandboxHost();
  } catch (error) {
    return finishError(error);
  }
  const active = child;
  try {
    outcome = await runInSandboxHost(active, {
      code: input.code,
      budgetMs,
      dispatch: dispatchHostCall,
      log: pushLog,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } finally {
    killChild(active);
    child = null;
    input.signal?.removeEventListener("abort", onOuterAbort);
  }
  if (!outcome.ok) return finishError(new Error(outcome.error));
  const value: unknown = outcome.value;

  const logPath = await persistLog(workspace, logLines);
  const serialized = serializeResultValue(value);
  const clamped =
    serialized.length > CODE_MODE_MAX_RESULT_CHARS
      ? `${serialized.slice(0, CODE_MODE_MAX_RESULT_CHARS)}\n... [returned value truncated at ${CODE_MODE_MAX_RESULT_CHARS} chars${logPath ? `; full log: ${logPath}` : ""}]`
      : serialized;
  return {
    ok: true,
    output:
      `[run_code] ${calls} internal call(s) in ${seconds()}; internal outputs stayed out of context` +
      (logPath ? `; log: ${logPath}` : "") +
      `\n${clamped}`,
  };
}

/** 执行日志落盘到与工具输出同一目录；失败不影响主结果（返回 null 表示无日志可提）。 */
async function persistLog(workspace: string, lines: string[]): Promise<string | null> {
  try {
    if (!lines.length) return null;
    let text = lines.join("\n");
    if (text.length > CODE_MODE_MAX_LOG_CHARS) {
      text = `${text.slice(0, CODE_MODE_MAX_LOG_CHARS)}\n... [log truncated]`;
    }
    const dir = await resolveToolPath(workspace, CODE_MODE_LOG_DIR);
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `run_code-${stamp}-${randomUUID().slice(0, 8)}.log`);
    await fs.writeFile(file, text, "utf8");
    // 与其它工具输出共用 7 天保留策略：日志目录会随长会话无限增长
    await sweepToolOutput(workspace);
    return path.relative(canonicalPathSync(workspace), file).split(path.sep).join("/");
  } catch {
    return null;
  }
}
