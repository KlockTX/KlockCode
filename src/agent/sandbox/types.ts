/**
 * 沙箱策略类型。与 `src/agent/code-mode.ts` 的 JS VM 沙箱正交：
 * 这里管 `run_command` 的 OS 级写隔离，不涉及 run_code 的 JS 执行。
 */

export type SandboxMode = "off" | "workspace-write" | "read-only";

export type SandboxSettings = {
  enabled: boolean;
  /**
   * 两种可执行语义（`off` 由 enabled=false 表达，不落到这里）：
   * - `workspace-write`：工作区 + 额外可写根 + 私有 temp 可写，其余一律拒绝；
   * - `read-only`：不授予任何写权限（含工作区与 temp），只能读与执行。
   *   `writableRoots` / `allowTemp` 在该模式下不生效——只读就是只读，
   *   留一半写权限的模式名会骗人。
   */
  mode: "workspace-write" | "read-only";
  /** 工作区之外的额外可写根（绝对路径；仅 workspace-write 生效） */
  writableRoots: string[];
  /** 是否授予一次性的私有 temp（仅 workspace-write 生效） */
  allowTemp: boolean;
  grantTimeoutMs: number;
  /** 工作区写入模式下，删除命令是否需要人工确认（完全访问模式下跳过） */
  confirmDelete: boolean;
};

export type SandboxDenialKind = "write_denied" | "delete_denied" | "unknown_denied";

export type SandboxDenial = {
  kind: SandboxDenialKind;
  /** 命中的输出片段，≤400 字符 */
  evidence: string;
  exitCode: number | null;
  writableRoots: string[];
};

export const DEFAULT_SANDBOX_TIMEOUT_MS = 120_000;
export const MIN_SANDBOX_TIMEOUT_MS = 10_000;
export const MAX_SANDBOX_TIMEOUT_MS = 600_000;

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  enabled: false,
  mode: "workspace-write",
  writableRoots: [],
  allowTemp: true,
  grantTimeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
  confirmDelete: false,
};
