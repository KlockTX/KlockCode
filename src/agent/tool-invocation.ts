/**
 * 工具调用的「准入判定」：参数校验 + 可写根 + 审批归类。
 *
 * 这一层回答的都是同一个问题——**这次调用该不该被执行、要不要人确认**，
 * 与「怎么执行」无关，因此不持有任何运行时状态：全部输入都由参数传入，
 * 唯一的隐式输入是 sandbox 设置（进程级单例，见 sandbox/policy.ts）。
 *
 * 拆出来的动机不是行数，而是边界：runtime.ts 里原先这七段代码与回合循环、
 * 工具目录、提示词装配混在一起，改审批策略时很难确认自己没碰到缓存前缀
 * （rawToolsKey 一旦漂移，每轮都是冷缓存）。这里可以独立演进、独立测试。
 */
import path from "node:path";

import { readMultiEditGroups, multiEditPaths } from "./multi-edit.js";
import { patchPaths } from "./patch.js";
import { isWithinAppDataRoot, isWithinWorkspace, resolveWithinWorkspace } from "./paths.js";
import { getSandboxSettings } from "./sandbox/policy.js";
import { READ_MANY_MAX_PATHS } from "./tools.js";
import type { CommandRisk, CommandRiskCategory, ToolCall } from "./types.js";

/** 必填参数校验的字段规格：required 缺一即拒，nonEmpty 额外要求非空白。 */
export type ToolArgumentSpec = { required: string[]; nonEmpty: string[] };

/**
 * 必填参数校验：参数不完整时绝不落盘/执行，按工具错误回给模型。
 * 只覆盖字符串字段——数组/对象形态的参数在 validateToolArguments 里单独处理。
 */
const TOOL_ARGUMENTS: Record<string, ToolArgumentSpec> = {
  read_file: { required: ["path"], nonEmpty: ["path"] },
  glob: { required: ["pattern"], nonEmpty: ["pattern"] },
  grep: { required: ["pattern"], nonEmpty: ["pattern"] },
  run_code: { required: ["code"], nonEmpty: ["code"] },
  write_file: { required: ["path", "content"], nonEmpty: ["path"] },
  edit_file: { required: ["path", "oldString", "newString"], nonEmpty: ["path", "oldString"] },
  run_command: { required: ["command"], nonEmpty: ["command"] },
  browser_navigate: { required: ["url"], nonEmpty: ["url"] },
  browser_click: { required: ["ref"], nonEmpty: ["ref"] },
  browser_type: { required: ["text"], nonEmpty: ["text"] },
  task: { required: ["description"], nonEmpty: ["description"] },
  admit: { required: ["tier", "task_shape"], nonEmpty: ["tier", "task_shape"] },
  job: { required: ["action"], nonEmpty: ["action"] },
  git: { required: ["action"], nonEmpty: ["action"] },
  delete_file: { required: ["path"], nonEmpty: ["path"] },
  move_file: { required: ["from", "to"], nonEmpty: ["from", "to"] },
  apply_patch: { required: ["patch"], nonEmpty: ["patch"] },
  web_search: { required: ["query"], nonEmpty: ["query"] },
  web_fetch: { required: ["url"], nonEmpty: ["url"] },
};

/** 门禁拦截事件的 input 回显：尽力解析参数，解析失败给空对象 */
export function safeToolInput(call: ToolCall): unknown {
  try {
    return JSON.parse(call.function.arguments || "{}");
  } catch {
    return {};
  }
}

export function validateToolArguments(
  tool: string,
  raw: string | undefined,
): { ok: true; input: unknown } | { ok: false; error: string } {
  const text = (raw ?? "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    return { ok: false, error: "tool arguments are not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "tool arguments must be a JSON object." };
  }
  const args = parsed as Record<string, unknown>;
  // multi_edit 支持跨文件：path 可以在顶层，也可以挂在每条 edit 上
  if (tool === "multi_edit") {
    const groups = readMultiEditGroups(args);
    if (typeof groups === "string") return { ok: false, error: groups };
    return { ok: true, input: args };
  }
  // read_many 的 paths 是字符串数组：单独校验（TOOL_ARGUMENTS 只覆盖字符串字段）
  if (tool === "read_many") {
    const paths = args.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, error: 'argument "paths" must be a non-empty array of file paths.' };
    }
    if (paths.length > READ_MANY_MAX_PATHS) {
      return { ok: false, error: `argument "paths" accepts at most ${READ_MANY_MAX_PATHS} files; split into batches.` };
    }
    if (paths.some((item) => typeof item !== "string" || !item.trim())) {
      return { ok: false, error: 'every entry in "paths" must be a non-empty string.' };
    }
    return { ok: true, input: args };
  }
  const spec = TOOL_ARGUMENTS[tool];
  if (spec) {
    for (const field of spec.required) {
      const value = args[field];
      if (typeof value !== "string") {
        return { ok: false, error: `missing required string argument "${field}".` };
      }
      if (spec.nonEmpty.includes(field) && !value.trim()) {
        return { ok: false, error: `argument "${field}" must not be empty.` };
      }
    }
  }
  return { ok: true, input: args };
}

/**
 * 只有写类工具参与"可写根"判定；命令走独立的高危判定，见 autoApprovalReason。
 * 名单本体在 tool-contract.ts（与审批名单同源），这里只做本模块的汇出点。
 */
export { WRITABLE_ROOT_TOOLS } from "./tool-contract.js";

/**
 * 命令风险按类别独立授权（codex AskForApproval::Granular 同款策略对象）：
 * "ask" = auto 模式也必须弹审批；"auto" = 可自动放行。
 * 默认全 ask —— 与既往一刀切行为完全一致；将来设置页暴露「XX 类自动放行」时改这张表。
 */
const COMMAND_RISK_POLICY: Record<CommandRiskCategory, "ask" | "auto"> = {
  disk_system: "ask",
  recursive_delete: "ask",
  credential_access: "ask",
  env_dump: "ask",
  remote_exec: "ask",
  inline_exec: "ask",
  system_config: "ask",
  privilege_escalation: "ask",
  process_kill: "ask",
  destructive_git: "ask",
  publish_deploy: "ask",
};

/**
 * auto 模式下这次调用能否自动批准，以及归到哪一类留痕原因。
 * 命令没有路径可校验，改用 assessCommandRisk 的启发式护栏：命中即仍要人确认。
 * 这不是沙箱；真正的执行边界在 run_code 隔离与 full 模式的显式授权上。
 */
export function autoApprovalReason(
  tool: string,
  writableTarget: boolean,
  commandRisk?: CommandRisk,
): "writable_root" | "low_risk_command" | null {
  if (tool === "run_command") {
    if (!commandRisk) return "low_risk_command";
    return commandRisk.categories.some((category) => COMMAND_RISK_POLICY[category] === "ask")
      ? null
      : "low_risk_command";
  }
  return writableTarget ? "writable_root" : null;
}

/**
 * 「文件删除确认」只在工作区写入沙箱模式下生效：
 * 完全访问模式跳过；只读模式下删除本来就被 OS 拒绝，再弹一次确认只是噪音。
 */
export function shouldConfirmFileDelete(): boolean {
  const settings = getSandboxSettings();
  return settings.enabled && settings.mode === "workspace-write" && settings.confirmDelete;
}

/** 写类工具涉及的所有路径：multi_edit 可跨文件，必须逐个判定。 */
export function writablePaths(tool: string, input: unknown): string[] {
  const args = (input ?? {}) as Record<string, unknown>;
  if (tool === "multi_edit") {
    const paths = multiEditPaths(input);
    if (paths.length) return paths;
  }
  if (tool === "move_file") {
    const from = String(args.from ?? "").trim();
    const to = String(args.to ?? "").trim();
    return [from, to].filter(Boolean);
  }
  if (tool === "apply_patch") {
    return patchPaths(String(args.patch ?? ""));
  }
  const target = String(args.path ?? "").trim();
  return target ? [target] : [];
}

/**
 * 计划模式专用：write 系工具的全部目标路径（realpath 后）都落在工作区 plans/ 目录内才放行。
 * 全部在内返回解析后的绝对路径列表（供 plan_documented 事件取展示路径）；
 * 任一路径越界/解析失败/没有路径 → null（整次调用拒绝）。
 */
export async function withinPlansDir(
  workspace: string,
  tool: string,
  input: unknown,
): Promise<string[] | null> {
  const paths = writablePaths(tool, input);
  if (!paths.length) return null;
  const plansRoot = path.resolve(workspace, "plans");
  const resolved: string[] = [];
  for (const target of paths) {
    try {
      const full = await resolveWithinWorkspace(workspace, target);
      if (!isWithinWorkspace(plansRoot, full)) return null;
      resolved.push(full);
    } catch {
      return null;
    }
  }
  return resolved;
}

/**
 * 计划模式下被拒绝的工具统一提示（executeToolCall 与 executeTaskToolCall 共用）。
 * 不弹审批：模型收到这条结果后应停下来等用户确认计划。
 */
export function planModeRejection(tool: string): string {
  return `Tool ${tool} blocked: plan mode only allows writing plan documents under plans/. Do not run commands, spawn subagents, or modify other files; finish the plan document and wait for the user to confirm it.`;
}

/**
 * codex 式「可写根」判定：目标路径经 realpath 后仍落在工作区内才算可自动批准。
 * <home>/.klockcode（应用自己的记忆/技能/插件数据）与工作区同属可信根。
 * 返回第一个越界路径；全部在区内返回 null；参数里没有路径返回空串。
 * 用 resolveWithinWorkspace 而非字符串前缀比较，工作区内指向外部的软链接/junction 会被识别。
 */
export async function writableRootViolation(
  workspace: string,
  tool: string,
  input: unknown,
): Promise<string | null> {
  const paths = writablePaths(tool, input);
  if (!paths.length) return "";
  for (const target of paths) {
    try {
      await resolveWithinWorkspace(workspace, target);
    } catch {
      if (isWithinAppDataRoot(target)) continue;
      return target;
    }
  }
  return null;
}
