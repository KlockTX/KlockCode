#!/usr/bin/env node
/**
 * KlockCode 品牌标记：像素画，从几何图元现画，不引用任何上游素材。
 *
 * 设计：深靛蓝阶梯圆角方底 + 白色几何 K + 两侧琥珀尖括号。
 * 全部在 64x64 的逻辑网格上按格判定（硬边、无抗锯齿），再用 16x 整数倍
 * 放大成 1024² PNG —— 每个逻辑像素是实打实的 16x16 方块，不是"平滑图缩小"。
 * 背景用 Bayer 4x4 抖动在两档深蓝之间过渡，配 1 格内描边与 1 格投影，
 * 是像素画而不是被 threshold 过的矢量图。
 *
 * 只借 scripts/lib/icon-png.mjs 的 PNG 编码器；输出 resources/icon.png。
 * 之后跑 pnpm make:ico / make-tray-icons / make-msix-assets（已切最近邻缩放）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPng, writePng } from "./lib/icon-png.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRID = 64; // 逻辑像素网格
const CELL = 16; // 每个逻辑像素放大 16 倍 → 1024²
const SIZE = GRID * CELL;
const C = SIZE / 2;

// 有限调色板：像素画不出现连续渐变色。
const PALETTE = {
  bgLight: [25, 35, 57],
  bgDark: [16, 23, 39],
  ring: [43, 58, 87],
  shadow: [8, 13, 23],
  amber: [245, 185, 66],
  amberShade: [176, 122, 34],
  white: [244, 248, 255],
};
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function sdRoundRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - (halfW - radius);
  const qy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

function sdCapsule(x, y, ax, ay, bx, by, radius) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(x - (ax + t * vx), y - (ay + t * vy)) - radius;
}

// 端点全部对齐 16px 网格，像素块的边才整齐。
const BODY_HALF = C - 16; // 31 格
const BODY_RADIUS = 160; // 10 格阶梯圆角
const CHEVRON_RADIUS = 24; // 3 格宽
const K_RADIUS = 24; // 3 格宽，64 格画布上 K 才不会糊成一团
const SHADOW_OFFSET = 16; // 1 格投影

// 全部按 16px 网格换算：格坐标 x16 = 画布坐标。
const chevrons = [
  [256, 384, 96, 512], [96, 512, 256, 640],
  [768, 384, 928, 512], [928, 512, 768, 640],
];
const kStrokes = [
  [352, 240, 352, 784], // 竖：第 22 格，15~49 格
  [448, 512, 688, 240], // 上斜
  [448, 512, 704, 784], // 下斜
];

function insideCapsules(x, y, strokes, radius, dx = 0, dy = 0) {
  for (const [ax, ay, bx, by] of strokes) {
    if (sdCapsule(x, y, ax + dx, ay + dy, bx + dx, by + dy, radius) <= 0) return true;
  }
  return false;
}

/** 算出 64x64 每格的颜色；null 表示透明。 */
function cellColor(gx, gy) {
  const x = (gx + 0.5) * CELL;
  const y = (gy + 0.5) * CELL;
  if (sdRoundRect(x, y, C, C, BODY_HALF, BODY_HALF, BODY_RADIUS) > 0) return null;

  // Bayer 抖动：左上偏亮、右下偏暗，颗粒状而非渐变。
  // 压缩到中间区间，抖动才会铺满整块底色，而不是四角各成一片纯色
  const slope = 0.22 + 0.56 * ((gx + gy) / (2 * GRID));
  const threshold = (BAYER[gy % 4][gx % 4] + 0.5) / 16;
  let color = slope > threshold ? PALETTE.bgDark : PALETTE.bgLight;

  // 1 格内描边。
  const ring = Math.abs(sdRoundRect(x, y, C, C, BODY_HALF - 32, BODY_HALF - 32, BODY_RADIUS - 32));
  if (ring <= CELL * 0.75) color = PALETTE.ring;

  // 先投影再本体：向右下各错 1 格，像素画的厚度感。
  if (insideCapsules(x, y, chevrons, CHEVRON_RADIUS, SHADOW_OFFSET, SHADOW_OFFSET)) {
    color = PALETTE.amberShade;
  }
  if (insideCapsules(x, y, kStrokes, K_RADIUS, SHADOW_OFFSET, SHADOW_OFFSET)) {
    color = PALETTE.shadow;
  }
  if (insideCapsules(x, y, chevrons, CHEVRON_RADIUS)) color = PALETTE.amber;
  if (insideCapsules(x, y, kStrokes, K_RADIUS)) color = PALETTE.white;

  return color;
}

const png = createPng(SIZE, SIZE);
const data = png.data;
for (let gy = 0; gy < GRID; gy += 1) {
  for (let gx = 0; gx < GRID; gx += 1) {
    const color = cellColor(gx, gy);
    for (let py = 0; py < CELL; py += 1) {
      for (let px = 0; px < CELL; px += 1) {
        const at = ((gy * CELL + py) * SIZE + gx * CELL + px) * 4;
        if (!color) {
          data[at + 3] = 0;
          continue;
        }
        data[at] = color[0];
        data[at + 1] = color[1];
        data[at + 2] = color[2];
        data[at + 3] = 255;
      }
    }
  }
}

const out = path.join(repoRoot, "resources", "icon.png");
writePng(out, png);
console.log(`[draw-brand-mark] 像素画 ${out} (${GRID}x${GRID} 逻辑格 -> ${SIZE}x${SIZE})`);
