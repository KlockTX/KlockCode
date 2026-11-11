/**
 * run_code 的**子进程宿主**：用户代码与 vm context 只存在于这里。
 *
 * 为什么不在宿主进程里 `vm.runInContext`：`node:vm` 不是安全边界，它只是
 * "另一个 realm"。同一进程内一次逃逸（原型链、引擎漏洞、vm 自身的洞）拿到的
 * 是宿主进程——也就是整个 agent（工具、审批、密钥、会话）。搬到子进程之后，
 * 同样的逃逸拿到的只是一个普通 node 进程，另外三件事同时成立：
 *  - 死循环/异步挂起可以由父进程直接 kill，不靠 Promise.race 假装超时；
 *  - 内存有上限（--max-old-space-size），写爆了死的是沙箱，不是应用；
 *  - CPU 密集的脚本不再和 UI/事件循环抢线程。
 *
 * 边界怎么划的：
 *  - 这里**只**跑 vm 与用户代码，不碰文件系统；
 *  - 所有能力（read/grep/write/run…）都是往父进程发一条 JSON 消息、
 *    等一条 JSON 回包——路径守卫、审批、读取登记全部留在父进程，不复制规则；
 *  - 跨边界只传字符串，宿主函数与对象从不进入 vm realm。
 *
 * 协议（父 ↔ 子，全部 JSON）：
 *   父 → 子  { type: "run", code, budgetMs }
 *   父 → 子  { type: "reply", id, payload }
 *   子 → 父  { type: "call", id, payload }
 *   子 → 父  { type: "log", line }
 *   子 → 父  { type: "done", ok: true, value } | { type: "done", ok: false, error }
 *
 * 这个文件必须只依赖 node 内置模块：它要在最小环境里能起来，也不该为了
 * 一行工具函数把整棵依赖树拉进沙箱进程。
 */
import vm from "node:vm";
import { serializeResultValue } from "./code-mode-serialize.js";

type ParentMessage =
  | { type: "run"; code: string; budgetMs: number }
  | { type: "reply"; id: number; payload: string };

/**
 * 沙箱内的桥/console 工厂：必须在 vm realm 里创建宿主函数的包装器。
 * 直接把宿主函数挂进 context 会被 `fn.constructor("return process")()` 逃逸；
 * 这里宿主函数只存在于闭包里，跨边界只传 JSON 字符串。
 */
const SANDBOX_FACTORY_SOURCE = `(hostCall, hostLog) => {
  "use strict";
  const requirePayload = (raw) => {
    const result = JSON.parse(raw);
    if (!result || result.ok !== true) {
      throw new Error(result && result.error ? String(result.error) : "meow: host call failed");
    }
    return result.value;
  };
  const call = (method) => async (...args) => {
    let payload;
    try {
      payload = JSON.stringify({ method, args });
    } catch {
      throw new Error("meow: arguments are not JSON-serializable.");
    }
    return requirePayload(await hostCall(payload));
  };
  const meow = Object.create(null);
  for (const name of ["read", "readMany", "grep", "glob", "listDir", "write", "edit", "multiEdit", "run"]) {
    meow[name] = call(name);
  }
  const log = (prefix) => (...args) => {
    const parts = [];
    for (const item of args) {
      try {
        if (typeof item === "string") {
          parts.push(item.slice(0, 500));
        } else {
          const text = JSON.stringify(item);
          parts.push(text === undefined ? String(item) : text.slice(0, 500));
        }
      } catch {
        parts.push("[unprintable]");
      }
    }
    hostLog(prefix + parts.join(" ").slice(0, 4000));
  };
  const contextConsole = Object.create(null);
  contextConsole.log = log("console: ");
  contextConsole.info = log("console: ");
  contextConsole.warn = log("console.warn: ");
  contextConsole.error = log("console.error: ");
  return { meow, console: contextConsole };
}`;
const sandboxFactoryScript = new vm.Script(SANDBOX_FACTORY_SOURCE, {
  filename: "run_code_bridge.js",
});

/** 待回包的宿主调用。父进程被 kill 时直接丢弃，不需要 reject——进程都没了。 */
const pendingCalls = new Map<number, (payload: string) => void>();
let callSeq = 0;

function send(message: unknown, onSent?: () => void): void {
  if (process.send === undefined) {
    onSent?.();
    return;
  }
  process.send(message, () => onSent?.());
}

function hostCall(payload: string): Promise<string> {
  callSeq += 1;
  const id = callSeq;
  return new Promise<string>((resolve) => {
    pendingCalls.set(id, resolve);
    send({ type: "call", id, payload });
  });
}

function hostLog(line: string): void {
  if (typeof line === "string") send({ type: "log", line });
}

async function execute(code: string, budgetMs: number): Promise<unknown> {
  // Object.create(null) 做载体：contextify 的全局代理会把属性查找回落到载体对象
  // 的原型链上，普通对象会把宿主 realm 的 Object/Function 构造器泄漏进沙箱。
  // 空原型载体只放原始值与 context realm 内创建的桥/console；codegen（字符串
  // 与 wasm）在 context 内禁用，`fn.constructor("return process")()` 无法再编译。
  const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  sandbox.process = undefined;
  sandbox.require = undefined;
  sandbox.module = undefined;
  sandbox.exports = undefined;
  sandbox.global = undefined;
  sandbox.globalThis = undefined;
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  const sandboxRuntime = sandboxFactoryScript.runInContext(context) as (
    hostCall: (payload: string) => Promise<string>,
    hostLog: (line: string) => void,
  ) => { meow: Record<string, unknown>; console: Record<string, unknown> };
  const runtimeGlobals = sandboxRuntime(hostCall, hostLog);
  sandbox.meow = runtimeGlobals.meow;
  sandbox.console = runtimeGlobals.console;

  const script = new vm.Script(`(async () => {\n${code}\n})()`, {
    filename: "run_code.js",
  });
  // vm timeout 只管同步执行（死循环在这里抛）；异步挂起由父进程的墙钟 kill 兜底
  return script.runInContext(context, {
    timeout: budgetMs,
    breakOnSigint: true,
  }) as Promise<unknown>;
}

process.on("message", (raw: unknown) => {
  const message = raw as ParentMessage | undefined;
  if (message?.type === "reply") {
    const resolve = pendingCalls.get(message.id);
    pendingCalls.delete(message.id);
    resolve?.(message.payload);
    return;
  }
  if (message?.type !== "run") return;
  void (async () => {
    let outcome: { type: "done"; ok: true; value: string } | { type: "done"; ok: false; error: string };
    try {
      const value = await execute(message.code, message.budgetMs);
      outcome = { type: "done", ok: true, value: serializeResultValue(value) };
    } catch (error) {
      outcome = {
        type: "done",
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
    // 结果发出后再退出：不然 channel 还排着队，父进程只会看到一个空退出
    send(outcome, () => process.exit(0));
  })();
});
