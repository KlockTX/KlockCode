#!/usr/bin/env node
/**
 * 应用图标（exe / 任务管理器 / 任务栏）：按每个 DPI 尺寸用最近邻渲染，保留像素块硬边。
 *
 * 小尺寸不能把 64 格设计硬缩下去——3 格宽的 K 斜笔在 16px 会碎成互不相连的块。
 * <=48px 用专门为小格数重画的 resources/icon-small.png（16 格简化版），
 * 大尺寸才用 resources/icon.png（64 格完整版）。两份源图都由 draw-brand-mark.mjs 生成。
 * Windows 125% 缩放会请求 20px（原 icon.ico 缺这个尺寸，导致图标被放大发糊）。
 * 生成后运行 node scripts/make-tray-icons.mjs，再完全退出应用并运行
 * node scripts/brand-electron.mjs --force 重打 exe。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import { encodePng, readPng, resampleNearest } from "./lib/icon-png.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resources = path.join(repoRoot, "resources");
const outPath = path.join(resources, "icon.ico");
const SMALL_MAX = 48;

// Windows 会按显示缩放请求的小/大图标尺寸（100%–400%，含 125%/150% 等）。
const SIZES = [16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 128, 256];

async function main() {
  const large = readPng(path.join(resources, "icon.png"));
  const small = readPng(path.join(resources, "icon-small.png"));
  for (const [name, png] of [["icon.png", large], ["icon-small.png", small]]) {
    if (png.width !== png.height) throw new Error(`${name} 必须是正方形，当前 ${png.width}x${png.height}`);
  }
  const pngs = SIZES.map((size) => encodePng(resampleNearest(size <= SMALL_MAX ? small : large, size)));
  fs.writeFileSync(outPath, await pngToIco(pngs));
  console.log(
    `[make-app-icon] resources/icon.ico <- ${SIZES.join(", ")} px（<=${SMALL_MAX} 用 16 格简化版）`,
  );
}

main().catch((error) => {
  console.error("[make-app-icon]", error);
  process.exitCode = 1;
});
