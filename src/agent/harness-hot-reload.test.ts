import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
const { builtinHarnessSeed, harnessFilePath } = await import("./harness-document.js");
type Runtime = InstanceType<typeof AgentRuntime>;
type HarnessDocument = ReturnType<typeof builtinHarnessSeed>;

function makeRuntime(sessionsDir: string): Runtime {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
    homeDir: sessionsDir,
  });
}

/** 造一份「图里的主 Agent 节点写了提示词」的合法文档 */
function harnessWith(prompt: string): HarnessDocument {
  const doc = builtinHarnessSeed("standard");
  const main = doc.nodes.find((node) => node.id === "main")!;
  main.data = { ...main.data, systemPrompt: prompt };
  return doc;
}

async function writeHarness(workspace: string, doc: unknown): Promise<string> {
  const filePath = harnessFilePath(workspace, "standard");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(doc), "utf8");
  return filePath;
}

function systemPromptOf(call: number): string {
  const messages = streamMock.mock.calls[call][0].messages as Array<{
    role: string;
    content: unknown;
  }>;
  const system = messages.find((message) => message.role === "system");
  return typeof system?.content === "string" ? system.content : "";
}

function toolNamesOf(call: number): string[] {
  const tools = streamMock.mock.calls[call][0].tools as
    | Array<{ function: { name: string } }>
    | undefined;
  return (tools ?? []).map((tool) => tool.function.name);
}

const done = { message: { role: "assistant", content: "done" } };

function toolTurn(name: string, args: Record<string, unknown> = {}) {
  return {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: `call-${name}`,
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
  };
}

function harnessEvents(events: MeowEvent[]) {
  return events.filter(
    (event): event is Extract<MeowEvent, { type: "harness_reloaded" }> =>
      event.type === "harness_reloaded",
  );
}

async function workspacePair(): Promise<{ sessions: string; workspace: string }> {
  return {
    sessions: await mkdtemp(path.join(tmpdir(), "klockcode-harness-rt-")),
    workspace: await mkdtemp(path.join(tmpdir(), "klockcode-harness-ws-")),
  };
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("架构图热重载：回合边界落地", () => {
  it("首次回合装载磁盘上的图，请求里的主提示词就是图里那份", async () => {
    const { sessions, workspace } = await workspacePair();
    await writeHarness(workspace, harnessWith("HARNESS-MARK-1"));
    const runtime = makeRuntime(sessions);
    await runtime.newSession(workspace);
    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    streamMock.mockResolvedValueOnce(done);

    await runtime.prompt("hello");

    expect(systemPromptOf(0)).toContain("HARNESS-MARK-1");
    const [reloaded] = harnessEvents(events);
    expect(reloaded).toMatchObject({
      type: "harness_reloaded",
      architecture: "standard",
      source: "session",
      applied: true,
    });
    expect(reloaded.path).toBe(harnessFilePath(workspace, "standard"));
    expect(runtime.getHarnessSnapshot().signature).toContain("standard.json");
  });

  it("手改磁盘文件在下一回合生效，并往历史补一条 in-history 说明", async () => {
    const { sessions, workspace } = await workspacePair();
    const filePath = await writeHarness(workspace, harnessWith("HARNESS-MARK-1"));
    const runtime = makeRuntime(sessions);
    await runtime.newSession(workspace);
    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    streamMock.mockResolvedValueOnce(done);
    await runtime.prompt("first");

    // 手改：内容变了（mtime + size 都变）
    await writeHarness(workspace, harnessWith("HARNESS-MARK-2-longer-prompt"));

    streamMock.mockResolvedValueOnce(done);
    await runtime.prompt("second");

    expect(systemPromptOf(1)).toContain("HARNESS-MARK-2-longer-prompt");
    const fileEvent = harnessEvents(events).find((event) => event.source === "file");
    expect(fileEvent).toMatchObject({ applied: true, path: filePath });
    // 模型侧同步被告知：改动不悄悄换前缀
    const messages = streamMock.mock.calls[1][0].messages as Array<{
      role: string;
      content: unknown;
    }>;
    const notes = messages.filter(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("harness architecture document was updated"),
    );
    expect(notes.length).toBeGreaterThan(0);
  });

  it("同一回合内文件被改也不换图（快照冻结到回合结束）", async () => {
    const { sessions, workspace } = await workspacePair();
    await writeHarness(workspace, harnessWith("HARNESS-MARK-1"));
    const runtime = makeRuntime(sessions);
    await runtime.newSession(workspace);

    // 第一次请求返回工具调用，返回前把文件改掉：本回合后续请求仍用旧图
    streamMock
      .mockImplementationOnce(async () => {
        await writeHarness(workspace, harnessWith("HARNESS-MARK-2-turned-mid-turn"));
        return toolTurn("read_file", { path: "nothing.txt" });
      })
      .mockResolvedValueOnce(done)
      .mockResolvedValueOnce(done);

    await runtime.prompt("first");
    expect(streamMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(systemPromptOf(1)).toContain("HARNESS-MARK-1");
    expect(systemPromptOf(1)).not.toContain("HARNESS-MARK-2-turned-mid-turn");

    // 下一回合才换
    await runtime.prompt("second");
    const last = streamMock.mock.calls.length - 1;
    expect(systemPromptOf(last)).toContain("HARNESS-MARK-2-turned-mid-turn");
  });

  it("手改成非法 JSON 时保留正在用的图，并给出 invalid-document", async () => {
    const { sessions, workspace } = await workspacePair();
    await writeHarness(workspace, harnessWith("HARNESS-MARK-1"));
    const runtime = makeRuntime(sessions);
    await runtime.newSession(workspace);
    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    streamMock.mockResolvedValueOnce(done);
    await runtime.prompt("first");

    const filePath = harnessFilePath(workspace, "standard");
    await writeFile(filePath, "{ broken", "utf8");

    streamMock.mockResolvedValueOnce(done);
    await runtime.prompt("second");

    // 没被悄悄换成内置种子：提示词仍是原来那份
    expect(systemPromptOf(1)).toContain("HARNESS-MARK-1");
    const rejected = harnessEvents(events).find((event) => event.source === "file");
    expect(rejected).toMatchObject({ applied: false, reason: "invalid-document" });

    // 修好之后照常重载（坏文件的签名只吃掉这一次，不会每回合重读）
    await writeHarness(workspace, harnessWith("HARNESS-MARK-3-fixed"));
    streamMock.mockResolvedValueOnce(done);
    await runtime.prompt("third");
    expect(systemPromptOf(2)).toContain("HARNESS-MARK-3-fixed");
  });

  it("图里的主 Agent 工具白名单在重载后立刻生效", async () => {
    const { sessions, workspace } = await workspacePair();
    const doc = harnessWith("HARNESS-TOOLS");
    const main = doc.nodes.find((node) => node.id === "main")!;
    main.data = { ...main.data, tools: ["read_file"] };
    await writeHarness(workspace, doc);

    const runtime = makeRuntime(sessions);
    await runtime.newSession(workspace);
    streamMock.mockResolvedValueOnce(done);
    await runtime.prompt("first");
    expect(toolNamesOf(0)).toContain("read_file");
    expect(toolNamesOf(0)).not.toContain("write_file");

    // 放开白名单：缓存键必须跟着变，否则模型还对着旧清单挑工具
    const widened = harnessWith("HARNESS-TOOLS-2");
    const main2 = widened.nodes.find((node) => node.id === "main")!;
    main2.data = { ...main2.data, tools: ["read_file", "write_file"] };
    await writeHarness(workspace, widened);

    streamMock.mockResolvedValueOnce(done);
    await runtime.prompt("second");
    expect(toolNamesOf(1)).toContain("write_file");
  });

  it("治理 run 活跃时保存被延后到回合边界，且界面上能看到 pending", async () => {
    const { sessions, workspace } = await workspacePair();
    await writeHarness(workspace, harnessWith("HARNESS-MARK-1"));
    const runtime = makeRuntime(sessions);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("auto");
    await runtime.setSessionMode("goal");
    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    let pendingDuringRun = false;
    streamMock
      // 第一轮：admit 打开一个治理 run
      .mockImplementationOnce(() => toolTurn("admit", { tier: "T1", task_shape: "echo hi" }))
      // 第二轮：run 正活跃时保存新图 —— 只能登记，不能中途换图
      .mockImplementationOnce(async () => {
        await writeHarness(workspace, harnessWith("HARNESS-MARK-DEFERRED"));
        runtime.refreshHarness(true);
        pendingDuringRun = runtime.getHarnessSnapshot().pendingReload;
        return done;
      })
      .mockResolvedValue(done);

    await runtime.prompt("admit and save");

    expect(pendingDuringRun).toBe(true);
    expect(runtime.getHarnessSnapshot().pendingReload).toBe(true);
    const deferred = harnessEvents(events).find((event) => event.applied === false);
    expect(deferred).toMatchObject({ source: "save", reason: "active-run" });
    // 本回合仍用旧图
    expect(systemPromptOf(1)).toContain("HARNESS-MARK-1");
    expect(systemPromptOf(1)).not.toContain("HARNESS-MARK-DEFERRED");
  });

  it("切到磁盘上不存在的自定义架构时回落到种子，不报错", async () => {
    const { sessions, workspace } = await workspacePair();
    const runtime = makeRuntime(sessions);
    await runtime.newSession(workspace);
    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    streamMock.mockResolvedValueOnce(done);
    await runtime.prompt("first");

    await runtime.setHarnessArchitecture("custom-1");
    streamMock.mockResolvedValueOnce(done);
    await runtime.prompt("second");

    const switched = harnessEvents(events).filter((event) => event.source === "switch");
    expect(switched.at(-1)).toMatchObject({ architecture: "custom-1", applied: true, path: null });
    expect(runtime.getHarnessSnapshot()).toMatchObject({
      architecture: "custom-1",
      signature: "seed:standard",
      pendingReload: false,
    });
  });

  it("装载语义有问题的图会在服务端日志里点名（编辑器能看到的提示，命令行也要能看到）", async () => {
    const { sessions, workspace } = await workspacePair();
    const document = harnessWith("HARNESS-MARK-LINT");
    // 结构完全合法：只把 G6 摘出所有 tier 序列，节点本身还在画布上
    document.edges = document.edges.filter(
      (edge) => !(edge.type === "tier-gate" && edge.target === "G6"),
    );
    await writeHarness(workspace, document);

    const runtime = makeRuntime(sessions);
    await runtime.newSession(workspace);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let lines: string[] = [];
    try {
      streamMock.mockResolvedValueOnce(done);
      await runtime.prompt("hello");
      lines = warn.mock.calls.map((args) => args.join(" "));
    } finally {
      warn.mockRestore();
    }

    // 装载本身照旧成功（语义提示不阻断），但后果被写进日志
    expect(systemPromptOf(0)).toContain("HARNESS-MARK-LINT");
    expect(lines.some((line) => line.includes("[harness] standard loaded from"))).toBe(true);
    expect(lines.some((line) => line.includes("gate-unattached"))).toBe(true);
    expect(lines.some((line) => line.includes("G6"))).toBe(true);
  });
});
