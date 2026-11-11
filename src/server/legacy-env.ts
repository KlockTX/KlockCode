/**
 * 旧品牌环境变量兼容：MEOWCODE_* 仅在对应的 KLOCKCODE_* 未设置时生效。
 *
 * 独立成模块，避免兼容性单测为了一个纯函数而加载整个 agent server
 * （server 模块会读 process.env、起后台任务，测试间容易串扰）。
 * 只做映射，不删除旧变量，也不覆盖调用方显式传入的新值；旧脚本无需改动即可运行。
 */
export function applyLegacyEnvFallback(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("MEOWCODE_") || value === undefined) continue;
    const next = `KLOCKCODE_${key.slice("MEOWCODE_".length)}`;
    if (env[next] === undefined) env[next] = value;
  }
}
