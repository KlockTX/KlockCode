/**
 * 策略面：工具调用的前置判定点。
 *
 * 设计约束（改动本文件时必须保留）：
 * 1. 这里不读取任何用户可编辑的配置（harness / approvals / skills / verify 一律不读），
 *    也不接受模型提示词作为输入，因此权限判定无法被配置或技能内容覆盖。
 * 2. 只实现「不可覆盖的硬规则」。审批档的常规逻辑仍由 runtime 决定；
 *    返回 allow 表示「交给后续判定」，不表示「已获授权」。
 * 3. 规则按优先级排列，命中即返回；新增工具类型时先确认是否应纳入 APPROVAL_BOUND_TOOLS。
 *
 * 注意：命令的路径预检是启发式前置门禁，不是沙箱。真正的执行边界仍应由
 * src/agent/sandbox/ 的受限进程提供；此处只是让「明显越界」在到达子进程前就被拒绝。
 */
import path from "node:path";
import { APPROVAL_BOUND_TOOLS } from "./tool-contract.js";
import type { ApprovalMode } from "./types.js";

export type PolicyDecision = "allow" | "ask" | "deny";

export interface PolicyContext {
  /** 会话审批档；只能由用户显式切换，不能由技能或模型消息改写 */
  approvalMode: ApprovalMode;
  /** 工作区根目录（绝对路径） */
  workspaceRoot: string;
  /** 本回合用户消息首部是否带「技能引用」标记 */
  skillReference: boolean;
}

export interface PolicyVerdict {
  decision: PolicyDecision;
  /** 命中的规则 id，写入审计留痕 */
  rule: string;
  /** deny 时作为工具回执内容回灌模型；ask 时用于审计 */
  reason: string;
}

/**
 * 需要过策略面的写类工具与命令工具。
 * 名单在 tool-contract.ts：runtime 的审批判定用同一份，不再各写一份字面量。
 */
export { APPROVAL_BOUND_TOOLS } from "./tool-contract.js";

/** 只有在命令确实涉及路径读写时，才做绝对路径越界预检，避免把 echo 里的字符串误判成越界 */
const PATH_BEARING_COMMAND =
  /\b(?:get-content|type|cat|more|select-string|findstr|rg|grep|get-childitem|dir|ls|copy-item|cp|move-item|mv|remove-item|rm|del|set-content|add-content|out-file|new-item|test-path|invoke-item|start-process|resolve-path|expand-archive|compress-archive)\b/i;

/** Windows 盘符绝对路径或 UNC 路径；(?<![a-z0-9_]) 用于排除 https:// 里的 "s://" */
const ABSOLUTE_PATH = /(?<![a-z0-9_])(?:[a-z]:[\\/]|\\\\[^\\\s/]+[\\/])[^\s"'|;&<>()[\]{}]*/gi;

function normalizeForCompare(value: string): string {
  return path.win32
    .resolve(value)
    .replace(/[\\/]+/g, "\\")
    .toLowerCase()
    .replace(/\\+$/, "");
}

function isWithinWorkspace(candidate: string, workspaceRoot: string): boolean {
  const root = normalizeForCompare(workspaceRoot);
  const target = normalizeForCompare(candidate);
  return target === root || target.startsWith(`${root}\\`);
}

/** 导出供审计与单测使用：返回命令中位于工作区之外的绝对路径列表 */
export function outsideWorkspacePaths(command: string, workspaceRoot: string): string[] {
  if (!PATH_BEARING_COMMAND.test(command)) return [];
  const found = new Set<string>();
  for (const match of command.matchAll(ABSOLUTE_PATH)) {
    const candidate = match[0].replace(/[.,;:]+$/, "");
    if (candidate && !isWithinWorkspace(candidate, workspaceRoot)) found.add(candidate);
  }
  return [...found];
}

/**
 * 唯一前置判定点。调用方必须对 deny 直接终止工具执行，对 ask 禁止一切自动批准路径。
 */
export function authorize(tool: string, input: unknown, ctx: PolicyContext): PolicyVerdict {
  const args = (input ?? {}) as Record<string, unknown>;

  // 规则 1：run_command 没有路径参数，现有的工作区守卫（WRITABLE_ROOT_TOOLS）覆盖不到它。
  // full 是用户对越界的显式授权，其余档位在命令到达子进程前直接拒绝。
  if (tool === "run_command" && ctx.approvalMode !== "full") {
    const outside = outsideWorkspacePaths(String(args.command ?? ""), ctx.workspaceRoot);
    if (outside.length > 0) {
      return {
        decision: "deny",
        rule: "command-outside-workspace",
        reason:
          `Tool ${tool} blocked by policy: command references a path outside the workspace ` +
          `(${outside[0]}). Commands have no path guard; switch to explicit full-access mode ` +
          `if this access is intentional.`,
      };
    }
  }

  // 规则 2：技能是第三方内容，引用技能不等于用户授权。
  // 旧实现会把整个回合提升为 full，绕过审批与越界检查；这里改为任何档位都必须人工确认。
  if (ctx.skillReference && APPROVAL_BOUND_TOOLS.has(tool)) {
    return {
      decision: "ask",
      rule: "skill-reference-requires-approval",
      reason:
        "Skill-referenced turns cannot be auto-approved: a skill is third-party content and " +
        "must not inherit full access from a message prefix.",
    };
  }

  return { decision: "allow", rule: "none", reason: "" };
}
