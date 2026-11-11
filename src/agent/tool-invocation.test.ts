import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessCommandRisk } from "./command-risk.js";
import { resetSandboxSettingsForTests, setSandboxSettings } from "./sandbox/policy.js";
import {
  autoApprovalReason,
  planModeRejection,
  shouldConfirmFileDelete,
  validateToolArguments,
  WRITABLE_ROOT_TOOLS,
  writablePaths,
  writableRootViolation,
  withinPlansDir,
} from "./tool-invocation.js";

async function workspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "klockcode-admission-"));
}

function errorOf(tool: string, raw: string): string {
  const result = validateToolArguments(tool, raw);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error;
}

describe("validateToolArguments", () => {
  it("拒绝非 JSON 与非对象，且提示直接回给模型", () => {
    expect(errorOf("read_file", '{"path":')).toBe("tool arguments are not valid JSON.");
    expect(errorOf("read_file", "[]")).toBe("tool arguments must be a JSON object.");
    expect(errorOf("read_file", '"a.txt"')).toBe("tool arguments must be a JSON object.");
    expect(errorOf("read_file", "null")).toBe("tool arguments must be a JSON object.");
  });

  it("空参数串按空对象处理：缺字段照常报 missing", () => {
    expect(errorOf("read_file", "")).toBe('missing required string argument "path".');
    expect(errorOf("read_file", undefined)).toBe('missing required string argument "path".');
  });

  it("区分「缺字段」与「字段为空」", () => {
    // 没有 path 键
    expect(errorOf("write_file", '{"content":"x"}')).toBe('missing required string argument "path".');
    // 有 path 键但只有空白
    expect(errorOf("write_file", '{"path":"  ","content":"x"}')).toBe('argument "path" must not be empty.');
    // 非字符串类型也算缺
    expect(errorOf("write_file", '{"path":42,"content":"x"}')).toBe('missing required string argument "path".');
  });

  it("content 允许为空串：写空文件是合法意图", () => {
    const ok = validateToolArguments("write_file", '{"path":"a.txt","content":""}');
    expect(ok.ok).toBe(true);
  });

  it("未登记的工具不校验：动态工具的参数由插件自己解释", () => {
    const ok = validateToolArguments("todo", '{"anything":[1,2]}');
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.input).toEqual({ anything: [1, 2] });
  });

  it("read_many 的 paths 单独校验：非空数组、上限、逐项字符串", () => {
    expect(errorOf("read_many", '{"paths":[]}')).toBe(
      'argument "paths" must be a non-empty array of file paths.',
    );
    expect(errorOf("read_many", '{"paths":"a.txt"}')).toBe(
      'argument "paths" must be a non-empty array of file paths.',
    );
    const tooMany = { paths: Array.from({ length: 13 }, (_, index) => `f${index}.txt`) };
    expect(errorOf("read_many", JSON.stringify(tooMany))).toBe(
      'argument "paths" accepts at most 12 files; split into batches.',
    );
    expect(errorOf("read_many", '{"paths":["a.txt","  "]}')).toBe(
      'every entry in "paths" must be a non-empty string.',
    );
    expect(validateToolArguments("read_many", '{"paths":["a.txt","b.txt"]}').ok).toBe(true);
  });

  it("multi_edit 复用 multi-edit 的分组规则：错误原文透传", () => {
    expect(errorOf("multi_edit", '{"edits":[]}')).toBe(
      "edits must be a non-empty array of { oldString, newString } (optionally path per edit).",
    );
    // 顶层没有 path，edit 上也没有
    expect(errorOf("multi_edit", '{"edits":[{"oldString":"a"}]}')).toBe(
      'edit #1 is missing "path" (give a top-level path or a path on every edit).',
    );
    expect(validateToolArguments("multi_edit", '{"edits":[{"path":"a","oldString":"x"}]}').ok).toBe(true);
    expect(validateToolArguments("multi_edit", '{"path":"a","edits":[{"oldString":"x"}]}').ok).toBe(true);
  });
});

describe("writablePaths", () => {
  it("只对写类工具生效：读/查/命令都不参与可写根判定", () => {
    expect([...WRITABLE_ROOT_TOOLS].sort()).toEqual([
      "apply_patch",
      "delete_file",
      "edit_file",
      "move_file",
      "multi_edit",
      "write_file",
    ]);
    for (const tool of ["read_file", "grep", "glob", "run_command", "run_code", "web_fetch"]) {
      expect(WRITABLE_ROOT_TOOLS.has(tool)).toBe(false);
    }
  });

  it("move_file 返回两端；任一端缺失就少返回一项", () => {
    expect(writablePaths("move_file", { from: "a.txt", to: "../b.txt" })).toEqual(["a.txt", "../b.txt"]);
    expect(writablePaths("move_file", { from: "a.txt" })).toEqual(["a.txt"]);
  });

  it("apply_patch 从补丁正文里取全部目标路径", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-const a = 1;",
      "+const a = 2;",
      "*** Add File: src/b.ts",
      "+export const b = 1;",
      "*** End Patch",
    ].join("\n");
    expect(writablePaths("apply_patch", { patch })).toEqual(["src/a.ts", "src/b.ts"]);
    // 解析失败不抛异常，返回空数组（越界判定会当成「没有路径」）
    expect(writablePaths("apply_patch", { patch: "not a patch" })).toEqual([]);
  });

  it("multi_edit 跨文件时逐个返回，且保持首次出现顺序", () => {
    const input = {
      edits: [
        { path: "b.ts", oldString: "1", newString: "2" },
        { path: "a.ts", oldString: "3", newString: "4" },
        { path: "b.ts", oldString: "5", newString: "6" },
      ],
    };
    expect(writablePaths("multi_edit", input)).toEqual(["b.ts", "a.ts"]);
  });

  it("空参数不返回路径", () => {
    expect(writablePaths("write_file", {})).toEqual([]);
    expect(writablePaths("write_file", undefined)).toEqual([]);
  });
});

describe("autoApprovalReason", () => {
  it("run_command 无风险画像时按低危放行", () => {
    expect(autoApprovalReason("run_command", false, undefined)).toBe("low_risk_command");
  });

  it("命中 ask 类别的命令即使在 auto 模式也必须弹审批", () => {
    // 用真实判定器产出的画像，避免手搓对象把两边一起写错
    const risk = assessCommandRisk("cat ~/.ssh/id_rsa");
    expect(risk?.categories).toContain("credential_access");
    expect(autoApprovalReason("run_command", false, risk)).toBe(null);
  });

  it("画像存在但没有 ask 类别时仍算低危", () => {
    expect(autoApprovalReason("run_command", false, { level: "medium", categories: [], reasons: [] })).toBe(
      "low_risk_command",
    );
  });

  it("写类工具按可写根判定，与命令分支无关", () => {
    expect(autoApprovalReason("write_file", true)).toBe("writable_root");
    expect(autoApprovalReason("write_file", false)).toBe(null);
  });
});

describe("shouldConfirmFileDelete", () => {
  afterEach(() => {
    resetSandboxSettingsForTests();
  });

  it("沙箱没开时永不弹删除确认", () => {
    expect(shouldConfirmFileDelete()).toBe(false);
    setSandboxSettings({ enabled: false, mode: "workspace-write", confirmDelete: true });
    expect(shouldConfirmFileDelete()).toBe(false);
  });

  it("只读模式下删除本来就被拒，不叠加确认", () => {
    setSandboxSettings({ enabled: true, mode: "read-only", confirmDelete: true });
    expect(shouldConfirmFileDelete()).toBe(false);
  });

  it("workspace-write + confirmDelete 才返回 true", () => {
    setSandboxSettings({ enabled: true, mode: "workspace-write", confirmDelete: true });
    expect(shouldConfirmFileDelete()).toBe(true);
    setSandboxSettings({ enabled: true, mode: "workspace-write", confirmDelete: false });
    expect(shouldConfirmFileDelete()).toBe(false);
  });
});

describe("writableRootViolation", () => {
  it("区内相对路径放行（null）", async () => {
    const dir = await workspace();
    expect(await writableRootViolation(dir, "write_file", { path: "a.txt", content: "" })).toBe(null);
    expect(await writableRootViolation(dir, "write_file", { path: path.join(dir, "b.txt") })).toBe(null);
  });

  it("越界路径原样返回（调用方拿它做事后留痕）", async () => {
    const dir = await workspace();
    const outside = process.platform === "win32" ? "C://Windows//x.txt" : "/etc/passwd";
    expect(await writableRootViolation(dir, "write_file", { path: outside })).toBe(outside);
    // 多路径时返回第一个越界者，不是全部
    expect(await writableRootViolation(dir, "move_file", { from: "a.txt", to: outside })).toBe(outside);
  });

  it("参数里没有路径返回空串：调用方据此判定「不可自动批准」，不能当放行", async () => {
    const dir = await workspace();
    expect(await writableRootViolation(dir, "write_file", {})).toBe("");
  });
});

describe("withinPlansDir", () => {
  it("计划模式下 write 只能落到 plans/ 内", async () => {
    const dir = await workspace();
    expect(await withinPlansDir(dir, "write_file", { path: "plans/step-1.md", content: "x" })).toEqual([
      path.join(dir, "plans", "step-1.md"),
    ]);
    expect(await withinPlansDir(dir, "write_file", { path: "src/a.ts", content: "x" })).toBe(null);
    expect(await withinPlansDir(dir, "write_file", { content: "x" })).toBe(null);
  });

  it("拒绝提示固定指向 plans/，且不弹审批", () => {
    expect(planModeRejection("run_command")).toContain("plan mode only allows writing plan documents under plans/");
  });
});

describe("名单只有一处真源", () => {
  it("审批名单 = 可写根 + 命令，policy 与 runtime 拿到的是同一个对象", async () => {
    const { APPROVAL_BOUND_TOOLS } = await import("./tool-contract.js");
    const { APPROVAL_BOUND_TOOLS: fromPolicy } = await import("./policy.js");

    expect([...APPROVAL_BOUND_TOOLS].sort()).toEqual([...WRITABLE_ROOT_TOOLS, "run_command"].sort());
    // 身份相等而不是内容相等：内容相等只能证明「今天一样」，身份相等才证明「不可能不一样」
    expect(fromPolicy).toBe(APPROVAL_BOUND_TOOLS);
  });

  it("可写根工具在契约里必须声明为写、且并发不安全", async () => {
    const { builtinToolContract, isParallelSafeContract } = await import("./tool-contract.js");
    for (const tool of WRITABLE_ROOT_TOOLS) {
      const contract = builtinToolContract(tool);
      expect(contract, `${tool} 缺契约`).toBeDefined();
      expect(contract?.readOnly, tool).toBe(false);
      expect(isParallelSafeContract(contract), tool).toBe(false);
    }
  });
});
