/**
 * 沙箱 e2e 的启动器：`pnpm test:sandbox`。
 *
 * 为什么不直接在 script 里写 `KLOCKCODE_SANDBOX_E2E=1 vitest ...`：那套写法在
 * cmd / PowerShell / bash 里各不相同，而这份用例只在 Windows 上有意义。
 * 放在 node 里设环境变量，三个 shell 都是同一条命令；顺带绕开 .cmd shim
 * （spawnSync 不带 shell 时 Windows 跑不动 npx.cmd，会静默失败）。
 *
 * 这套用例会真去改临时目录的 ACL、真起受限令牌，所以不随 `pnpm test` 默认跑——
 * 默认套件必须能在任何机器上无副作用地跑完。需要真机验证时显式跑这一条。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.error(`[sandbox-e2e] 只在 Windows 上可跑（当前 ${process.platform}）`);
  process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
if (!existsSync(vitest)) {
  console.error(`[sandbox-e2e] 找不到 vitest：${vitest}（先 pnpm install）`);
  process.exit(1);
}

const run = spawnSync(
  process.execPath,
  [vitest, "run", "src/agent/sandbox/e2e.test.ts"],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, KLOCKCODE_SANDBOX_E2E: "1" },
  },
);

process.exit(run.status ?? 1);
