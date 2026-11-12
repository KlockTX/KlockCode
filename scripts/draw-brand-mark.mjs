#!/usr/bin/env node
/**
 * 生成两份品牌源图：
 *   resources/icon.png       64x64 逻辑格（完整版：尖括号 + 抖动 + 投影）
 *   resources/icon-small.png 16x16 逻辑格（小尺寸简化版：加粗 K + 两侧琥珀方块）
 *
 * 都按 16x 整数倍放大成 PNG，一格一色、硬边。绘制逻辑在 lib/brand-mark.mjs。
 * 之后跑 pnpm make:ico / node scripts/make-tray-icons.mjs / pnpm make:msix-assets，
 * 各尺寸会按大小自动选源图（见那两个脚本）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderMark } from "./lib/brand-mark.mjs";
import { writePng } from "./lib/icon-png.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  { file: "resources/icon.png", grid: 64 },
  { file: "resources/icon-small.png", grid: 16 },
];

for (const { file, grid } of targets) {
  const out = path.join(repoRoot, file);
  writePng(out, renderMark(grid));
  console.log(`[draw-brand-mark] 像素画 ${file} (${grid}x${grid} 逻辑格 -> ${grid * 16}x${grid * 16})`);
}
