import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeowEvent } from "./types";

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
type Runtime = InstanceType<typeof AgentRuntime>;

/**
 * 工具调用准入：**只读并行路径**（executeReadOnlyToolCall）与**写路径**（executeToolCall）
 * 必须是同一套判定。
 *
 * 两条路径历史上是两份实现：并行路径只做裸 JSON.parse，解析失败退化成 {} 直接交给执行器，
 * 也不经过策略面。今天它没造成越权（并行集合里只有只读工具，策略硬规则也只覆盖写类/命令），
 * 但那意味着「同一次调用会因为落在哪个批次而得到不同结果」——这类漂移是这套 harness
 * 反复踩的坑，所以要有一条断言把两条路径绑死。
 */

function makeRuntime(sessionsDir: string): Runtime {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
    homeDir: sessionsDir,
  });
}

async function workspacePair(): Promise<{ sessions: string; workspace: string }> {
  return {
    sessions: await mkdtemp(path.join(tmpdir(), "klockcode-admission-rt-")),
    workspace: await mkdtemp(path.join(tmpdir(), "klockcode-admission-ws-")),
  };
}

/** 一个带一次工具调用的助手回合，随后收尾。参数串故意可以是坏 JSON。 */
function toolCallTurn(name: string, rawArguments: string) {
  return {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        { id: `call-${name}`, type: "function" as const, function: { name, arguments: rawArguments } },
      ],
    },
  };
}

const done = { message: { role: "assistant" as const, content: "done" } };

async function runOnce(
  name: string,
  rawArguments: string,
): Promise<{ runtime: Runtime; events: MeowEvent[]; toolText: string }> {
  const { sessions, workspace } = await workspacePair();
  await writeFile(path.join(workspace, "a.txt"), "alpha\n", "utf8");
  const runtime = makeRuntime(sessions);
  await runtime.newSession(workspace);
  const events: MeowEvent[] = [];
  runtime.onEvent((event) => {
    events.push(event);
    if (event.type === "approval_required") {
      runtime.respondToApproval(event.callId, { approved: true });
    }
  });
  streamMock.mockResolvedValueOnce(toolCallTurn(name, rawArguments)).mockResolvedValueOnce(done);
  await runtime.prompt("做一件事");
  const toolMessages = runtime.current!.messages.filter((message) => message.role === "tool");
  return { runtime, events, toolText: String(toolMessages[0]?.content ?? "") };
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("工具调用准入：只读路径与写路径同一套判定", () => {
  it("坏 JSON 的 read_file 被拒，且没有被当成空参数执行", async () => {
    const { events, toolText } = await runOnce("read_file", '{"path":');

    expect(toolText).toBe("Tool call rejected: tool arguments are not valid JSON.");
    // 关键：不是「执行了但失败」，而是根本没进执行器 —— 没有成功的 tool_finished
    expect(events.some((event) => event.type === "tool_finished" && event.ok)).toBe(false);
    expect(events.some((event) => event.type === "tool_output")).toBe(true);
  });

  it("空 path：读写两条路径给出同一条错误文案", async () => {
    const read = await runOnce("read_file", JSON.stringify({ path: "  " }));
    const write = await runOnce("write_file", JSON.stringify({ path: "  ", content: "x" }));

    expect(read.toolText).toBe('Tool call rejected: argument "path" must not be empty.');
    expect(write.toolText).toBe(read.toolText);
  });

  it("缺参数：读写两条路径同样拒绝，且都不落盘", async () => {
    const read = await runOnce("read_file", "{}");
    const write = await runOnce("write_file", JSON.stringify({ content: "x" }));

    expect(read.toolText).toBe('Tool call rejected: missing required string argument "path".');
    expect(write.toolText).toBe(read.toolText);
  });

  it("通过校验的只读调用照常执行（校验没有误伤正常路径）", async () => {
    const { events, toolText } = await runOnce("read_file", JSON.stringify({ path: "a.txt" }));

    expect(toolText).toContain("alpha");
    expect(events.some((event) => event.type === "tool_finished" && event.ok)).toBe(true);
  });

  it("同一个坏调用在「纯读批」与「混合批」里给出同一条拒绝", async () => {
    // 纯读批：整批并行安全 → 只读路径（本批修复的正是这条）
    const pure = await runOnce("read_file", '{"path":');

    // 混合批：批里混了写操作 → 整批退化成串行 → read_file 走写路径
    const { sessions, workspace } = await workspacePair();
    await writeFile(path.join(workspace, "a.txt"), "alpha\n", "utf8");
    const runtime = makeRuntime(sessions);
    await runtime.newSession(workspace);
    runtime.onEvent((event) => {
      if (event.type === "approval_required") {
        runtime.respondToApproval(event.callId, { approved: true });
      }
    });
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "bad", type: "function", function: { name: "read_file", arguments: '{"path":' } },
            {
              id: "write",
              type: "function",
              function: { name: "write_file", arguments: JSON.stringify({ path: "b.txt", content: "b\n" }) },
            },
          ],
        },
      })
      .mockResolvedValueOnce(done);
    await runtime.prompt("读一个坏的，写一个好的");
    const mixedTools = runtime.current!.messages.filter((message) => message.role === "tool");
    const mixedText = String(mixedTools[0]?.content ?? "");

    // 证明这一批确实走了串行写路径：写操作真的落地了
    expect(await readFile(path.join(workspace, "b.txt"), "utf8")).toBe("b\n");
    expect(mixedTools).toHaveLength(2);
    expect(mixedText).toBe(pure.toolText);
  });
});
