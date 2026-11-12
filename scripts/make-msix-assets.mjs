#!/usr/bin/env node
/**
 * 生成微软商店（MSIX）需要的图片资源：resources/appx/*.png
 *
 * 尺寸按 AppxManifest 的资源清单（正方形瓦片 + 商店 Logo），用最近邻重采样
 * （像素画不能用 Lanczos）。<=48px 取 16 格简化版 icon-small.png，大图取 icon.png，
 * 与 make-app-icon.mjs 保持同一套小尺寸规则。
 * 换了 Logo 之后重跑一次即可：
 *   node scripts/make-msix-assets.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPng, readPng, resampleNearest, writePng } from "./lib/icon-png.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resources = path.join(repoRoot, "resources");
const outDir = path.join(resources, "appx");
const SMALL_MAX = 48;

/** 文件名与像素尺寸必须与 AppxManifest 的引用一致（electron-builder 按文件名映射）。 */
const ASSETS = {
  "Square44x44Logo.png": 44,
  "Square150x150Logo.png": 150,
  "StoreLogo.png": 50,
};

/** 宽瓦片 310x150：Logo 等比缩到 132px 居中，四周留透明安全区。 */
function wideTile(src) {
  const width = 310;
  const height = 150;
  const iconSize = 132;
  const canvas = createPng(width, height);
  const icon = resampleNearest(src, iconSize);
  const offsetX = Math.floor((width - iconSize) / 2);
  const offsetY = Math.floor((height - iconSize) / 2);
  for (let y = 0; y < iconSize; y++) {
    for (let x = 0; x < iconSize; x++) {
      const from = (y * iconSize + x) * 4;
      const to = ((offsetY + y) * width + offsetX + x) * 4;
      canvas.data[to] = icon.data[from];
      canvas.data[to + 1] = icon.data[from + 1];
      canvas.data[to + 2] = icon.data[from + 2];
      canvas.data[to + 3] = icon.data[from + 3];
    }
  }
  return canvas;
}

function main() {
  const large = readPng(path.join(resources, "icon.png"));
  const small = readPng(path.join(resources, "icon-small.png"));
  for (const [name, png] of [["icon.png", large], ["icon-small.png", small]]) {
    if (png.width !== png.height) throw new Error(`${name} 必须是正方形，当前 ${png.width}x${png.height}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, size] of Object.entries(ASSETS)) {
    writePng(path.join(outDir, name), resampleNearest(size <= SMALL_MAX ? small : large, size));
    console.log(`[make-msix-assets] ${name} <- ${size}x${size}`);
  }
  writePng(path.join(outDir, "Wide310x150Logo.png"), wideTile(large));
  console.log("[make-msix-assets] Wide310x150Logo.png <- 310x150（132px 居中）");
}

try {
  main();
} catch (error) {
  console.error("[make-msix-assets]", error);
  process.exitCode = 1;
}
