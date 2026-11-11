import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "./provider-error.js";
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
 * 黄金轨迹回放：一个完整回合的**请求序列 / 工具调用 / 事件序列 / 落盘消息**被钉死。
 *
 * 拆 `runtime.ts`（约 9300 行）之前先有这层护栏：任何一步行为漂移都会在下面的期望数组里
 * 变成一行 diff，而不是藏进一次大重构里。断言刻意只记**结构性事实**（消息角色序、
 * 工具名、ok、事件类型、内容前缀），不记系统提示词的哈希——改文案是常事，钉死哈希
 * 只会让人习惯性 `-u`，护栏就废了。提示词只断言"同一回合内多轮请求的前缀逐字节一致"
 * 这个真正影响缓存的性质。
 *
 * 踩坑记录：`streamChatCompletion` 收到的是 runtime 的**活数组**，回合结束后再去读
 * `mock.calls[n][0].messages` 看到的是被追加过的历史。必须在调用发生的当下快照。
 */

const done = { message: { role: "assistant" as const, content: "done" } };

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

function makeRuntime(sessionsDir: string): Runtime {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
    homeDir: sessionsDir,
  });
}

type RequestSnapshot = {
  roles: string;
  tools: number;
  /** 第一条 system（稳定的缓存前缀） */
  system: string;
  /** 后续 system 块（运行时上下文，可能随轮次变化） */
  tailSystems: string[];
};

function snapshotOf(options: {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
}): RequestSnapshot {
  const roles = options.messages.map((message) => message.role);
  const systems = options.messages
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : ""));
  return {
    roles: roles.join(","),
    tools: (options.tools ?? []).length,
    system: systems[0] ?? "",
    tailSystems: systems.slice(1),
  };
}

/**
 * 每次 provider 调用都在当下抓一份快照，然后返回脚本里的响应。
 * 直接 chain `mockResolvedValueOnce` 会在回合结束后读到被追加过的历史。
 *
 * 脚本里放 Error 实例表示「这次调用要 reject」（溢出、限流都靠这个表达）——
 * 若是把它当普通返回值，mock 会把它 resolve 出去，循环根本走不到 catch 分支，
 * 表面上请求发了、事件也有，就是不压缩。
 */
function scripted(
  responses: unknown[],
): { implementations: Array<(options: never) => Promise<unknown>>; requests: RequestSnapshot[] } {
  const requests: RequestSnapshot[] = [];
  const implementations = responses.map(
    (payload) =>
      async (options: never): Promise<unknown> => {
        requests.push(snapshotOf(options));
        if (payload instanceof Error) throw payload;
        return payload;
      },
  );
  return { implementations, requests };
}

/**
 * 只保留有结构意义的事件。注意 `turn_start` / `turn_end` 是**会话条目**（落盘历史），
 * 不是 MeowEvent——事件侧只有 `turn_complete`。delta / progress 这类高频噪声不进轨迹。
 */
const TRACED_EVENTS = new Set([
  "message_start",
  "message_complete",
  "tool_started",
  "tool_finished",
  "approval_required",
  "approval_resolved",
  "turn_complete",
]);

function tracedEvents(events: MeowEvent[]): string[] {
  return events
    .filter((event) => TRACED_EVENTS.has(event.type))
    .map((event) => {
      if (event.type === "tool_started") return `tool_started:${event.tool}`;
      if (event.type === "tool_finished") return `tool_finished:${event.ok ? "ok" : "fail"}`;
      if (event.type === "approval_required") return `approval_required:${event.tool}`;
      return event.type;
    });
}

function head(text: unknown, limit = 60): string {
  const value = typeof text === "string" ? text : JSON.stringify(text ?? null);
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

async function workspacePair(): Promise<{ sessions: string; workspace: string }> {
  return {
    sessions: await mkdtemp(path.join(tmpdir(), "klockcode-golden-rt-")),
    workspace: await mkdtemp(path.join(tmpdir(), "klockcode-golden-ws-")),
  };
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("黄金轨迹：一个完整回合", () => {
  it("读 → 搜 → 写（走审批）→ 收尾，请求/工具/事件/落盘逐项对齐", async () => {
    const { sessions, workspace } = await workspacePair();
    await writeFile(path.join(workspace, "a.txt"), "alpha\nneedle here\n", "utf8");
    const runtime = makeRuntime(sessions);
    await runtime.newSession(workspace);

    const events: MeowEvent[] = [];
    runtime.onEvent((event) => {
      events.push(event);
      // 审批走真实路径：由事件驱动结算，而不是绕过审批直接执行
      if (event.type === "approval_required") {
        runtime.respondToApproval(event.callId, { approved: true });
      }
    });

    const { implementations, requests } = scripted([
      toolTurn("read_file", { path: "a.txt" }),
      toolTurn("grep", { pattern: "needle" }),
      toolTurn("write_file", { path: "out.txt", content: "written\n" }),
      done,
    ]);
    for (const implementation of implementations) streamMock.mockImplementationOnce(implementation);

    await runtime.prompt("整理一下 a.txt");

    // 1) 请求序列：历史按 用户 → 助手 → 工具结果 交替增长
    expect(requests.map((request) => request.roles)).toEqual([
      "system,system,user",
      "system,system,user,assistant,tool",
      "system,system,user,assistant,tool,assistant,tool",
      "system,system,user,assistant,tool,assistant,tool,assistant,tool",
    ]);
    // 工具表在整个回合内不缩水（tools 缓存断点靠这个）
    expect(new Set(requests.map((request) => request.tools)).size).toBe(1);
    expect(requests[0]!.tools).toBeGreaterThan(10);
    // 同一回合内 system 前缀逐字节一致：前缀缓存成立的前提
    expect(new Set(requests.map((request) => request.system)).size).toBe(1);
    expect(requests[0]!.system.length).toBeGreaterThan(500);
    // 第二条 system 是运行时上下文（回合内不变；跨回合会带新的事实）
    expect(requests.map((request) => request.tailSystems.length)).toEqual([1, 1, 1, 1]);

    // 2) 事件全序列（黄金记录本金）
    //    · message_start / message_complete 每回合各一次，不是每轮一次；
    //    · tool_started 先于 approval_required —— UI 先出行，再弹确认；
    //    · 写操作的结果在审批结算之后才 tool_finished。
    expect(tracedEvents(events)).toEqual([
      "message_start",
      "tool_started:read_file",
      "tool_finished:ok",
      "tool_started:grep",
      "tool_finished:ok",
      "tool_started:write_file",
      "approval_required:write_file",
      "approval_resolved",
      "tool_finished:ok",
      "message_complete",
      "turn_complete",
    ]);

    // 3) 落盘：工具结果进了历史，写操作真的落到了磁盘
    const stored = runtime.current!.messages.map((message) => ({
      role: message.role,
      head: head(message.content),
    }));
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(stored[0]!.head).toBe("整理一下 a.txt");
    expect(stored[2]!.head).toContain("needle");
    expect(stored[7]!.head).toBe("done");
    expect(await readFile(path.join(workspace, "out.txt"), "utf8")).toBe("written\n");

  });

  it("一轮里只读并发、写串行：工具结果仍按调用顺序进上下文", async () => {
    const { sessions, workspace } = await workspacePair();
    await writeFile(path.join(workspace, "a.txt"), "alpha", "utf8");
    await writeFile(path.join(workspace, "b.txt"), "beta", "utf8");
    const runtime = makeRuntime(sessions);
    await runtime.newSession(workspace);

    runtime.onEvent((event) => {
      if (event.type === "approval_required") {
        runtime.respondToApproval(event.callId, { approved: true });
      }
    });

    const { implementations, requests } = scripted([
      {
        message: {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function" as const,
              function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) },
            },
            {
              id: "c2",
              type: "function" as const,
              function: { name: "read_file", arguments: JSON.stringify({ path: "b.txt" }) },
            },
            {
              id: "c3",
              type: "function" as const,
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "c.txt", content: "gamma" }),
              },
            },
          ],
        },
      },
      done,
    ]);
    for (const implementation of implementations) streamMock.mockImplementationOnce(implementation);

    await runtime.prompt("读两个文件再写一个");

    // 三个工具结果按**调用顺序**进上下文，与只读批的完成顺序无关
    const toolMessages = runtime.current!.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(head(toolMessages[0]!.content, 20)).toContain("alpha");
    expect(head(toolMessages[1]!.content, 20)).toContain("beta");
    expect(head(toolMessages[2]!.content, 20)).toContain("c.txt");
    expect(requests.map((request) => request.roles)).toEqual([
      "system,system,user",
      "system,system,user,assistant,tool,tool,tool",
    ]);
    expect(await readFile(path.join(workspace, "c.txt"), "utf8")).toBe("gamma");

  });
});

describe("黄金轨迹：压缩回合", () => {
  it("溢出压缩只改历史，不动缓存前缀与工具表", async () => {
    const { sessions, workspace } = await workspacePair();
    const runtime = makeRuntime(sessions);
    await runtime.newSession(workspace);

    // 先垫两轮真实历史：压缩需要有东西可丢，否则「变短」无从谈起
    streamMock.mockResolvedValueOnce(done);
    await runtime.prompt("第一轮");
    streamMock.mockResolvedValueOnce(done);
    await runtime.prompt("第二轮");

    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    const overflow = new ProviderRequestError(413, "prompt is too long");
    const { implementations, requests } = scripted([
      overflow,
      { message: { role: "assistant", content: "SUMMARY" } },
      done,
    ]);
    for (const implementation of implementations) streamMock.mockImplementationOnce(implementation);

    await runtime.prompt("这一轮会溢出");

    expect(requests).toHaveLength(3); // 溢出 + 摘要 + 重试
    const [attempt, summaryCall, retry] = requests;
    expect(attempt!.roles).not.toBe(summaryCall!.roles);

    // 1) 压缩改的是历史长度，不是缓存前缀：两次主对话请求的 system 必须逐字节一致
    expect(retry!.system).toBe(attempt!.system);
    expect(retry!.tailSystems).toEqual(attempt!.tailSystems);
    // 2) 工具表也不能因为压缩而变（缓存断点挂在工具定义后面）
    expect(retry!.tools).toBe(attempt!.tools);
    // 3) 历史确实变短了，且摘要落在历史最前面
    expect(retry!.roles.split(",").length).toBeLessThan(attempt!.roles.split(",").length);
    expect(runtime.current!.effectiveMessages[0]!.content).toBe("Earlier conversation summary:\nSUMMARY");
    expect(runtime.current!.currentCompactionSummary).toBe("SUMMARY");

    // 4) 落盘留审计：条目在，事件也在，且事件夹在两次主对话请求之间
    expect(runtime.current!.entries.filter((entry) => entry.type === "compaction_summary")).toHaveLength(1);
    const order = tracedEvents(events);
    expect(order).toContain("message_start");
    expect(order.at(-1)).toBe("turn_complete");
    expect(events.some((event) => event.type === "compaction_started")).toBe(true);
    expect(events.some((event) => event.type === "compaction_completed" && event.summary === "SUMMARY")).toBe(true);
  });
});
