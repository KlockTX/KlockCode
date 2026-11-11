import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeowEvent, PendingApproval } from "./types";

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

function makeRuntime(sessionsDir: string): Runtime {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
    homeDir: sessionsDir,
  });
}

function collectEvents(runtime: Runtime): MeowEvent[] {
  const events: MeowEvent[] = [];
  runtime.onEvent((event) => events.push(event));
  return events;
}

async function waitForApproval(runtime: Runtime): Promise<PendingApproval> {
  for (let i = 0; i < 300; i += 1) {
    const pending = runtime.pendingApproval;
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for approval");
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } },
      ],
    },
  };
}

const done = { message: { role: "assistant", content: "done" } };

beforeEach(() => {
  streamMock.mockReset();
});

describe("policy 前置门禁（集成回归）", () => {
  it("默认配置下技能引用回合的写入必须弹审批，拒绝后不落盘", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-policy-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-policy-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    const events = collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce(toolCall("w1", "write_file", { path: "skill.txt", content: "ok" }))
      .mockResolvedValueOnce(done);

    const running = runtime.prompt("【技能引用】demo · demo\n\n执行技能");
    const pending = await waitForApproval(runtime);
    runtime.respondToApproval(pending.callId, { approved: false });
    await running;

    expect(events.some((event) => event.type === "approval_required")).toBe(true);
    await expect(readFile(path.join(workspace, "skill.txt"), "utf8")).rejects.toThrow();
    expect(
      runtime
        .getDecisions({ kind: "policy" })
        .some(
          (decision) =>
            decision.rule === "skill-reference-requires-approval" && decision.outcome === "ask",
        ),
    ).toBe(true);
  });

  it("run_command 越界绝对路径在执行前被策略拒绝", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-policy-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-policy-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    const events = collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce(
        toolCall("c1", "run_command", { command: "Get-Content C:\\Windows\\win.ini" }),
      )
      .mockResolvedValueOnce(done);

    await runtime.prompt("read a file outside the workspace");

    const outputs = events
      .filter(
        (event): event is Extract<MeowEvent, { type: "tool_output" }> =>
          event.type === "tool_output",
      )
      .map((event) => event.output);
    expect(outputs.some((output) => output.includes("blocked by policy"))).toBe(true);
    expect(outputs.some((output) => output.includes("outside the workspace"))).toBe(true);
    expect(events.some((event) => event.type === "approval_required")).toBe(false);

    const decisions = runtime.getDecisions({ kind: "policy" });
    expect(
      decisions.some(
        (decision) =>
          decision.rule === "command-outside-workspace" && decision.outcome === "deny",
      ),
    ).toBe(true);
    const traceId = runtime.getTraceId();
    expect(traceId).toBeTruthy();
    if (traceId) {
      const trace = runtime.exportTrace(traceId);
      expect(trace.decisions.some((d) => d.rule === "command-outside-workspace")).toBe(true);
      expect(trace.spans.length).toBeGreaterThan(0);
    }
  });

  it("显式 full 档也不能让技能引用绕过审批", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-policy-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-policy-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce(toolCall("c1", "run_command", { command: "echo hi" }))
      .mockResolvedValueOnce(done);

    const running = runtime.prompt("【技能引用】demo · demo\n\n执行命令");
    const pending = await waitForApproval(runtime);
    runtime.respondToApproval(pending.callId, { approved: false });
    await running;

    expect(events.some((event) => event.type === "approval_required")).toBe(true);
  });

  it("普通回合的常规写入仍按既有审批档自动批准，策略面不过度拦截", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-policy-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-policy-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("auto");
    const events = collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce(toolCall("w1", "write_file", { path: "a.txt", content: "ok" }))
      .mockResolvedValueOnce(done);

    await runtime.prompt("write a file");

    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("ok");
    expect(
      runtime
        .getDecisions({ kind: "policy" })
        .some((decision) => decision.rule === "none" && decision.outcome === "allow"),
    ).toBe(true);
  });
});
