/**
 * KlockCode 像素标记的网格渲染器：按任意逻辑格尺寸现画，所有边都是硬边。
 *
 * 关键点：像素画在小尺寸**不能**靠大图缩小。64 格设计里 3 格宽的 K 斜笔，
 * 缩到 16 格只剩 0.75 格，会被最近邻采样切成互不相连的碎块。所以这里按目标
 * 格数重新画：<=20 格自动切成简化版（去掉尖括号/抖动/内圈，K 加粗），
 * 大格数才用完整的尖括号 + Bayer 抖动 + 1 格投影。
 *
 * 几何按 1024 画布写一次，用 g() 线性映射到目标网格；只借 icon-png 的 PNG 编码器。
 */
import { createPng } from "./icon-png.mjs";

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

// 1024 画布上的几何；端点对齐 16px 网格，像素块边才整齐。
const BODY_HALF = 496;
const BODY_RADIUS = 160;
const CHEVRONS = [
  [256, 384, 96, 512], [96, 512, 256, 640],
  [768, 384, 928, 512], [928, 512, 768, 640],
];
const K_STROKES = [
  [352, 240, 352, 784],
  [448, 512, 688, 240],
  [448, 512, 704, 784],
];

function sdRoundRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - (halfW - radius);
  const qy = Math.abs(y - cy) - (halfH - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function sdCapsule(x, y, ax, ay, bx, by, radius) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(x - (ax + t * vx), y - (ay + t * vy)) - radius;
}

/**
 * 生成 grid x grid 逻辑格的像素画，每格放大 cell 倍输出。
 * 返回 PNG（grid*cell 见方），供重采样脚本读取。
 */
export function renderMark(grid, cell = 16) {
  const simple = grid <= 20;
  const size = grid * cell;
  const g = (v) => (v * grid) / 1024; // 1024 画布坐标 -> 目标格坐标
  const half = grid / 2;
  const kRadius = Math.max(1, g(24));
  const chevronRadius = Math.max(0.8, g(24));
  const shadow = 1; // 1 格投影

  const strokes = (points, radius) => points.map(([ax, ay, bx, by]) => [g(ax), g(ay), g(bx), g(by), radius]);
  const chevrons = strokes(CHEVRONS, chevronRadius);
  const kStrokes = strokes(K_STROKES, kRadius);

  const hits = (x, y, list, dx = 0, dy = 0) => {
    for (const [ax, ay, bx, by, radius] of list) {
      if (sdCapsule(x, y, ax + dx, ay + dy, bx + dx, by + dy, radius) <= 0) return true;
    }
    return false;
  };

  const png = createPng(size, size);
  const data = png.data;
  const cellColor = (gx, gy) => {
    const x = gx + 0.5;
    const y = gy + 0.5;
    if (sdRoundRect(x, y, half, half, g(BODY_HALF), g(BODY_HALF), g(BODY_RADIUS)) > 0) return null;

    let color = PALETTE.bgDark;
    if (!simple) {
      const slope = 0.22 + 0.56 * ((gx + gy) / (2 * grid));
      const threshold = (BAYER[gy % 4][gx % 4] + 0.5) / 16;
      color = slope > threshold ? PALETTE.bgDark : PALETTE.bgLight;
      const ring = Math.abs(sdRoundRect(x, y, half, half, g(BODY_HALF - 32), g(BODY_HALF - 32), g(BODY_RADIUS - 32)));
      if (ring <= 0.75) color = PALETTE.ring;
      if (hits(x, y, chevrons, shadow, shadow)) color = PALETTE.amberShade;
    }
    if (hits(x, y, kStrokes, shadow, shadow)) color = PALETTE.shadow;
    if (!simple) {
      if (hits(x, y, chevrons)) color = PALETTE.amber;
    } else {
      // 简化版：两侧各一个琥珀方块，代替会糊掉的尖括号
      const left = Math.hypot(x - 2, y - half);
      const right = Math.hypot(x - (grid - 3), y - half);
      if (left <= 1.2 || right <= 1.2) color = PALETTE.amber;
    }
    if (hits(x, y, kStrokes)) color = PALETTE.white;
    return color;
  };

  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const color = cellColor(gx, gy);
      for (let py = 0; py < cell; py += 1) {
        for (let px = 0; px < cell; px += 1) {
          const at = ((gy * cell + py) * size + gx * cell + px) * 4;
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
  return png;
}
