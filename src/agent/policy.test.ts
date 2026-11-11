import { describe, expect, it } from "vitest";
import { authorize, outsideWorkspacePaths, type PolicyContext } from "./policy.js";

const workspace = "C:\\work\\project";

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    approvalMode: "auto",
    workspaceRoot: workspace,
    skillReference: false,
    ...overrides,
  };
}

describe("outsideWorkspacePaths", () => {
  it("识别越界的 Windows 绝对路径", () => {
    expect(outsideWorkspacePaths("Get-Content C:\\Windows\\win.ini", workspace)).toEqual([
      "C:\\Windows\\win.ini",
    ]);
  });

  it("工作区内的绝对路径不算越界", () => {
    expect(outsideWorkspacePaths("Get-Content C:\\work\\project\\src\\a.ts", workspace)).toEqual(
      [],
    );
  });

  it("不带路径读写语义的命令不触发预检", () => {
    expect(outsideWorkspacePaths("echo C:\\Windows\\win.ini", workspace)).toEqual([]);
    expect(outsideWorkspacePaths("pnpm test", workspace)).toEqual([]);
  });

  it("不把 https:// 误判为盘符路径", () => {
    expect(outsideWorkspacePaths("Get-Content https://example.com/a.txt", workspace)).toEqual([]);
  });

  it("识别 UNC 路径", () => {
    expect(outsideWorkspacePaths("Copy-Item \\\\server\\share\\a.txt .", workspace)).toEqual([
      "\\\\server\\share\\a.txt",
    ]);
  });
});

describe("authorize", () => {
  it("非 full 档拒绝命令越界读取", () => {
    const verdict = authorize(
      "run_command",
      { command: "Get-Content C:\\Windows\\win.ini" },
      ctx(),
    );
    expect(verdict.decision).toBe("deny");
    expect(verdict.rule).toBe("command-outside-workspace");
    expect(verdict.reason).toContain("blocked by policy");
  });

  it("full 是用户显式授权，放行越界命令", () => {
    const verdict = authorize(
      "run_command",
      { command: "Get-Content C:\\Windows\\win.ini" },
      ctx({ approvalMode: "full" }),
    );
    expect(verdict.decision).toBe("allow");
  });

  it("技能引用回合的写操作在任何档位都必须人工确认", () => {
    for (const approvalMode of ["auto", "ask", "full", "read-only"] as const) {
      const verdict = authorize(
        "write_file",
        { path: "a.txt", content: "x" },
        ctx({ skillReference: true, approvalMode }),
      );
      expect(verdict.decision).toBe("ask");
      expect(verdict.rule).toBe("skill-reference-requires-approval");
    }
  });

  it("技能引用回合的只读工具不受影响", () => {
    const verdict = authorize("read_file", { path: "a.txt" }, ctx({ skillReference: true }));
    expect(verdict.decision).toBe("allow");
  });

  it("普通回合的常规写操作交回 runtime 判定，策略面不额外拦截", () => {
    const verdict = authorize("write_file", { path: "a.txt", content: "x" }, ctx());
    expect(verdict.decision).toBe("allow");
    expect(verdict.rule).toBe("none");
  });

  it("策略面不接受配置对象作为输入，无法被注入覆盖", () => {
    const forged = ctx({ approvalMode: "auto" }) as PolicyContext & { fullAccess: boolean };
    forged.fullAccess = true;
    const verdict = authorize(
      "run_command",
      { command: "Get-Content C:\\Windows\\win.ini" },
      forged,
    );
    expect(verdict.decision).toBe("deny");
  });
});
