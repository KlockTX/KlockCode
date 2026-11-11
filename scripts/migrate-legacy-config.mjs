#!/usr/bin/env node
/**
 * 旧品牌配置迁移：.meowcode/ → .klockcode/（工作区）与 ~/.meowcode/ → ~/.klockcode/（用户级）。
 *
 * 设计原则：只复制、不删除、不覆盖、不自动执行。默认 dry-run，加 --apply 才写盘，
 * 因为静默改动用户配置比配置不兼容更危险。旧环境变量另由 server 启动时运行时回退。
 *
 * 用法：
 *   node scripts/migrate-legacy-config.mjs [workspace...]          预演
 *   node scripts/migrate-legacy-config.mjs [workspace...] --apply   执行
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const brand = typeof pkg.brand === "object" && pkg.brand ? pkg.brand : {};
const NEW_DIR = String(brand.workspaceDir ?? ".klockcode");
const OLD_DIR = String(brand.legacyWorkspaceDir ?? ".meowcode");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const roots = args.filter((arg) => !arg.startsWith("--"));
if (roots.length === 0) roots.push(process.cwd());

const targets = [
  ...roots.map((root) => ({ label: "workspace", root: path.resolve(root) })),
  { label: "user", root: os.homedir() },
];

let planned = 0;
for (const { label, root } of targets) {
  const next = path.join(root, NEW_DIR);
  const legacy = path.join(root, OLD_DIR);
  if (!fs.existsSync(legacy)) {
    console.log(`[skip] ${label}: ${legacy} 不存在`);
    continue;
  }
  if (fs.existsSync(next)) {
    console.log(`[skip] ${label}: ${next} 已存在，不覆盖，请手动合并`);
    continue;
  }
  planned += 1;
  console.log(`${apply ? "[copy] " : "[would copy] "}${legacy} -> ${next}`);
  if (apply) fs.cpSync(legacy, next, { recursive: true });
}

console.log(
  apply
    ? `完成：迁移 ${planned} 处，原目录全部保留，可随时回滚。`
    : `预演：${planned} 处待迁移；确认后加 --apply 执行。`,
);
