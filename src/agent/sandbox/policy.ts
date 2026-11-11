import path from "node:path";
import {
  DEFAULT_SANDBOX_SETTINGS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  MAX_SANDBOX_TIMEOUT_MS,
  MIN_SANDBOX_TIMEOUT_MS,
  type SandboxSettings,
} from "./types.js";

/**
 * 把 settings.json / env 里的沙箱段归一化；非法值一律回落到关闭，绝不静默当已开。
 *
 * mode 是例外：写错一个词不该等于「关掉沙箱」。未知 mode 收敛到最严的
 * read-only 并报错——命令会因写被拒而失败，问题立刻可见；悄悄降级成
 * 「完全不隔离」才是最坏的一种"容错"。
 */
export function normalizeSandboxSettings(
  raw: unknown,
  platform: NodeJS.Platform = process.platform,
): SandboxSettings {
  const parsed =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const mode = normalizeMode(parsed.mode);
  const enabled = parsed.enabled === true && platform === "win32";
  const writableRoots = normalizeRoots(parsed.writableRoots, platform);
  const allowTemp = parsed.allowTemp !== false;
  const grantTimeoutMs =
    typeof parsed.grantTimeoutMs === "number" && Number.isFinite(parsed.grantTimeoutMs)
      ? Math.min(
          MAX_SANDBOX_TIMEOUT_MS,
          Math.max(MIN_SANDBOX_TIMEOUT_MS, Math.round(parsed.grantTimeoutMs)),
        )
      : DEFAULT_SANDBOX_TIMEOUT_MS;
  return {
    enabled,
    mode,
    writableRoots,
    allowTemp,
    grantTimeoutMs,
    confirmDelete: parsed.confirmDelete === true,
  };
}

function normalizeMode(raw: unknown): "workspace-write" | "read-only" {
  if (raw === undefined) return "workspace-write";
  if (raw === "read-only") return "read-only";
  if (raw === "workspace-write") return "workspace-write";
  console.error(
    `[sandbox] unknown mode ${JSON.stringify(raw)}; falling back to the strictest mode (read-only)`,
  );
  return "read-only";
}

function normalizeRoots(raw: unknown, platform: NodeJS.Platform): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value || !path.isAbsolute(value)) continue;
    const key = platform === "win32" ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(value);
  }
  return roots;
}

/** KLOCKCODE_SANDBOX = JSON；解析失败视为关闭并报错，不静默当已开。 */
export function readSandboxSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SandboxSettings {
  const raw = env.KLOCKCODE_SANDBOX;
  if (!raw) return { ...DEFAULT_SANDBOX_SETTINGS };
  try {
    return normalizeSandboxSettings(JSON.parse(raw));
  } catch (error) {
    console.error(
      `[sandbox] ignoring invalid KLOCKCODE_SANDBOX: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ...DEFAULT_SANDBOX_SETTINGS };
  }
}

let current: SandboxSettings = { ...DEFAULT_SANDBOX_SETTINGS };

/** 进程级单例：exec 层在每条命令启动时读取，天然覆盖前台/侧边/后台/子 agent。 */
export function getSandboxSettings(): SandboxSettings {
  return current;
}

export function setSandboxSettings(next: unknown): SandboxSettings {
  current = normalizeSandboxSettings(next);
  return current;
}

export function resetSandboxSettingsForTests(): void {
  current = { ...DEFAULT_SANDBOX_SETTINGS };
}
