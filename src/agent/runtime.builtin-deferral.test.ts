import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
  utilityProvider: (provider: Record<string, unknown>, maxTokens: number) => ({
    ...provider,
    maxTokens,
    reasoningEffort: undefined,
  }),
}));
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Test title"),
}));

const { AgentRuntime } = await import("./runtime.js");
const { DEFERRED_BUILTIN_TOOLS } = await import("./tools.js");

type Runtime = InstanceType<typeof AgentRuntime>;

/**
 * 内置工具延迟加载（会话级）。
 *
 * 三条契约，缺一条这条路就不成立：
 *  1. **只改广告，不改能力** —— 被延迟的工具按名直接调用照样执行。它不是「不可用」，
 *     是「没广告」。任何把它做成「删掉」的实现都会让模型在失败里反复试错。
 *  2. **提升必须缓存安全** —— 召回后 schema 只能追加到目录末尾，前面的工具逐字不动；
 *     否则一次 tool_search 就把整段 tools 断点作废，省下来的远比丢掉的多。
 *  3. **按会话重置** —— 上一个会话召回过的工具，不该让下一个会话继续为它付费。
 */

function makeRuntime(sessionsDir: string): Runtime {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
    homeDir: sessionsDir,
  });
}

type RequestPayload = { tools?: Array<{ function: { name: string } }> };

/** 广告清单快照：拷出名字字符串，避免拿到之后被就地改写的数组。 */
function toolNamesOf(payload: RequestPayload): string[] {
  return (payload.tools ?? []).map((tool) => tool.function.name);
}

function toolCallTurn(name: string, args: Record<string, unknown> = {}) {
  return {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        { id: `call-${name}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } },
      ],
    },
  };
}

const done = { message: { role: "assistant" as const, content: "done" } };

async function boot(): Promise<{ runtime: Runtime; workspace: string; seen: string[][] }> {
  const sessions = await mkdtemp(path.join(tmpdir(), "klockcode-deferral-rt-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "klockcode-deferral-ws-"));
  const runtime = makeRuntime(sessions);
  await runtime.newSession(workspace);
  runtime.onEvent((event) => {
    if (event.type === "approval_required") runtime.respondToApproval(event.callId, { approved: true });
  });
  const seen: string[][] = [];
  return { runtime, workspace, seen };
}

/** 让下一次模型响应先记下这次请求的广告清单，再返回给定回合。 */
function answer(turn: unknown, seen: string[][]) {
  return async (payload: RequestPayload) => {
    seen.push(toolNamesOf(payload));
    return turn;
  };
}

function toolMessagesOf(runtime: Runtime): string[] {
  return runtime.current!.messages
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content ?? ""));
}

afterEach(() => {
  delete process.env.KLOCKCODE_DEFER_BUILTIN_TOOLS;
});

beforeEach(() => {
  streamMock.mockReset();
  delete process.env.KLOCKCODE_DEFER_BUILTIN_TOOLS;
});

describe("内置工具延迟加载", () => {
  it("默认不广告，但按名直接调用照样执行（延迟不是删掉）", async () => {
    const { runtime, seen } = await boot();
    streamMock
      .mockImplementationOnce(answer(toolCallTurn("context_status"), seen))
      .mockImplementationOnce(answer(done, seen));

    await runtime.prompt("看一下上下文用量");

    for (const name of DEFERRED_BUILTIN_TOOLS) {
      expect(seen[0], `${name} 不该被广告出去`).not.toContain(name);
    }
    // context_status 是 runtime 的虚拟工具，调用被正常拦截作答 —— 证明能力没被削减
    const messages = toolMessagesOf(runtime);
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain("not available");
    expect(messages[0]).toContain("Context usage");
  });

  it("tool_search 召回后只追加到目录末尾，前面的广告逐字不动（缓存安全）", async () => {
    const { runtime, seen } = await boot();
    streamMock
      .mockImplementationOnce(answer(toolCallTurn("tool_search", { query: "list dir" }), seen))
      .mockImplementationOnce(answer(done, seen));

    await runtime.prompt("看看有没有列目录的工具");

    const before = seen[0];
    const after = seen[1];
    expect(before).not.toContain("list_dir");
    expect(after).toContain("list_dir");
    // 前缀逐字不动 = 工具段缓存断点没被重写；新增部分只能是延迟集里的工具。
    // 一次 tool_search 可能同时召回多个（"list" 也会命中 job 的描述），这里不钉数量。
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(0, before.length)).toEqual(before);
    const appended = after.slice(before.length);
    expect(appended).toContain("list_dir");
    for (const name of appended) {
      expect(DEFERRED_BUILTIN_TOOLS.has(name), `${name} 不是延迟集里的工具，不该被追加`).toBe(true);
    }
  });

  it("KLOCKCODE_DEFER_BUILTIN_TOOLS=0 时全部常驻，回到全量广告", async () => {
    process.env.KLOCKCODE_DEFER_BUILTIN_TOOLS = "0";
    const { runtime, seen } = await boot();
    streamMock.mockImplementationOnce(answer(done, seen));

    await runtime.prompt("hello");

    for (const name of DEFERRED_BUILTIN_TOOLS) {
      expect(seen[0], `${name} 应该常驻`).toContain(name);
    }
  });

  it("新会话重新开始延迟：上一个会话召回过的工具不该让新会话继续付费", async () => {
    const { runtime, seen, workspace } = await boot();
    streamMock
      .mockImplementationOnce(answer(toolCallTurn("tool_search", { query: "list dir" }), seen))
      .mockImplementationOnce(answer(done, seen));
    await runtime.prompt("看看有没有列目录的工具");
    expect(seen[1]).toContain("list_dir");

    // 换一个会话：目录本来就是冷的，延迟集合一并回到初始状态
    await runtime.newSession(workspace);
    streamMock.mockImplementationOnce(answer(done, seen));
    await runtime.prompt("hello");

    expect(seen[2]).not.toContain("list_dir");
  });
});
