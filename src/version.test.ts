import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "./version.js";

/**
 * 发版末尾被 release-smoke 拦下来那一处的回归测试：
 * 打包产物里的 agent-server/package.json 已经是新版本，服务端代码却还报旧号。
 * 版本号只要出现第二份字面量，这个坑就会在每次发版重演。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");
const packageVersion = (relative: string): string => JSON.parse(read(relative)).version as string;

describe("版本号只有一处真源", () => {
  it("对外的版本常量与根 / desktop 两份 package.json 一致", () => {
    expect(APP_VERSION).toBe(packageVersion("package.json"));
    expect(APP_VERSION).toBe(packageVersion("desktop/package.json"));
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("消费方都引用常量，不再各自硬编码 x.y.z", () => {
    for (const file of [
      "src/server/server.ts",
      "src/agent/web-fetch.ts",
      "src/plugins/mcp.ts",
    ]) {
      const source = read(file);
      expect(source, `${file} 应引用 APP_VERSION`).toContain("APP_VERSION");
      expect(source, `${file} 不应再写字面量版本`).not.toMatch(/["']1\.\d+\.\d+["']/);
    }
    // 打包脚本的兜底不能写死：appInfo 缺失时要从根 package.json 兜
    expect(read("desktop/brand-packaged.cjs")).toContain('require("../package.json").version');
  });
});
