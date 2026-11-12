#!/usr/bin/env node
/**
 * token-report.mjs — 会话账单四分之一拆（免依赖）。
 *
 * 为什么需要它：改提示词、加工具、调截断，任何一步都能让 token 消耗反向恶化，
 * 而「感觉更省了」不算证据。KlockCode 的会话日志已经把每一项用量都持久化了
 * （type="usage" 条目带 input/output/cacheRead/cacheWrite + source + turnId），
 * 这个脚本只负责把它们加回去，并按「谁在吃」排序。
 *
 * 用法：
 *   node scripts/token-report.mjs                       # 默认 ~/.klockcode/sessions
 *   node scripts/token-report.mjs <会话.jsonl|目录...>   # 指定文件或目录
 *   node scripts/token-report.mjs --top 20 --json
 *
 * 口径（与 src/agent/anthropic.ts 的 buildUsage 一致）：
 *   inputTokens 是**总输入** = 未命中缓存 + 缓存读取 + 缓存写入，
 *   所以未命中部分必须减掉后两者，否则缓存命中率会被算成 100% 以上。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const targets = argv.filter((arg, index) => !arg.startsWith("--") && !argv[index - 1]?.startsWith("--"));
const roots = targets.length ? targets : [path.join(os.homedir(), ".klockcode", "sessions")];
const TOP = Math.max(1, Number(opt("--top", "10")) || 10);

/** 收集 .jsonl 会话文件（目录递归；也接受直接给文件）。 */
async function collect(entry, out) {
  if (!existsSync(entry)) return;
  const stat = statSync(entry);
  if (stat.isFile()) {
    if (entry.endsWith(".jsonl")) out.push(entry);
    return;
  }
  for (const child of await readdir(entry, { withFileTypes: true })) {
    const full = path.join(entry, child.name);
    if (child.isDirectory()) await collect(full, out);
    else if (child.name.endsWith(".jsonl")) out.push(full);
  }
}

/** 逐行读 usage 条目：坏行跳过（日志可能有半行写入）。 */
async function readUsage(file) {
  const rows = [];
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "usage") continue;
    rows.push({
      session: path.basename(file, ".jsonl"),
      source: entry.source ?? "chat",
      turnId: entry.turnId ?? "",
      model: entry.model ?? "",
      input: Number(entry.inputTokens) || 0,
      output: Number(entry.outputTokens) || 0,
      cacheRead: Number(entry.cacheReadTokens) || 0,
      cacheWrite: Number(entry.cacheWriteTokens) || 0,
    });
  }
  return rows;
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const pct = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");

function bucket(rows) {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const row of rows) {
    sum.input += row.input;
    sum.output += row.output;
    sum.cacheRead += row.cacheRead;
    sum.cacheWrite += row.cacheWrite;
  }
  // 未命中输入 = 总输入 − 缓存读取 − 缓存写入（下限 0：个别网关口径不一致）
  const uncached = Math.max(0, sum.input - sum.cacheRead - sum.cacheWrite);
  return { ...sum, uncached, requests: rows.length };
}

async function main() {
  const files = [];
  for (const root of roots) await collect(root, files);
  if (!files.length) {
    console.error(`没有找到会话日志（.jsonl）。检查路径：${roots.join(", ")}`);
    console.error("提示：跑过会话之后日志才会出现在 <sessions>/ 下。");
    process.exit(1);
  }

  const all = [];
  for (const file of files) all.push(...(await readUsage(file)));
  if (!all.length) {
    console.error(`扫描了 ${files.length} 个会话文件，但没有任何 usage 条目（可能是空会话或旧版本日志）。`);
    process.exit(1);
  }

  const total = bucket(all);
  const bySource = new Map();
  for (const row of all) {
    if (!bySource.has(row.source)) bySource.set(row.source, []);
    bySource.get(row.source).push(row);
  }

  if (flag("--json")) {
    console.log(
      JSON.stringify(
        {
          sessions: files.length,
          requests: total.requests,
          tokens: { uncached: total.uncached, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite, output: total.output },
          cacheHitRate: total.input > 0 ? total.cacheRead / total.input : null,
          bySource: Object.fromEntries([...bySource].map(([source, rows]) => [source, bucket(rows)])),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`TOKEN REPORT — ${files.length} 个会话，${total.requests} 次请求\n`);
  console.log("四项拆分（inputTokens 是总输入，未命中部分已扣除缓存读写）：");
  console.log(`  未命中输入  ${fmt(total.uncached).padStart(12)}  ${pct(total.uncached, total.input)}`);
  console.log(`  缓存读取    ${fmt(total.cacheRead).padStart(12)}  ${pct(total.cacheRead, total.input)}  ← 按 ~10% 计价`);
  console.log(`  缓存写入    ${fmt(total.cacheWrite).padStart(12)}  ${pct(total.cacheWrite, total.input)}  ← 按 ~125% 计价`);
  console.log(`  输出        ${fmt(total.output).padStart(12)}                    ← 按 3~5× 计价`);
  console.log(`  总输入      ${fmt(total.input).padStart(12)}`);

  const hitRate = total.input > 0 ? total.cacheRead / total.input : 0;
  console.log(`\n缓存命中率 ${(hitRate * 100).toFixed(1)}%`);
  if (hitRate >= 0.8) {
    console.log("  命中良好：固定前缀（system + 工具表）基本按 10% 计价，继续压它的收益已经很小。");
    console.log("  下一步该看的是「未命中输入」和「输出」——那才是账单主体。");
  } else if (hitRate >= 0.5) {
    console.log("  中等：检查是否有工具在稳定前缀里被每回合改写，或会话被频繁 switchSession 打断。");
  } else {
    console.log("  偏低：优先查前缀稳定性（工具目录/系统提示词里有没有易变内容），而不是继续瘦身。");
    console.log("  命中率从 0.5 提到 0.9，比把工具表砍掉 15% 值钱得多。");
  }

  console.log("\n按来源：");
  const sources = [...bySource].sort((a, b) => b[1].length - a[1].length);
  for (const [source, rows] of sources) {
    const sum = bucket(rows);
    console.log(
      `  ${source.padEnd(11)} ${String(sum.requests).padStart(5)} 次  总输入 ${fmt(sum.input).padStart(11)}  输出 ${fmt(sum.output).padStart(9)}  命中 ${pct(sum.cacheRead, sum.input)}`,
    );
  }

  const expensive = [...all]
    .map((row) => ({ ...row, spend: row.input + row.output * 4 }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, TOP);
  console.log(`\n最贵的 ${expensive.length} 次请求（输入 + 输出×4，近似成本序）：`);
  for (const row of expensive) {
    console.log(
      `  ${fmt(row.spend).padStart(10)}  in ${fmt(row.input).padStart(9)} / out ${fmt(row.output).padStart(6)}  命中 ${pct(row.cacheRead, row.input).padStart(6)}  ${row.source}`,
    );
  }
  console.log("\n提醒：按任务比较，不要按单次调用比较 —— 一个更短的输出若多引发一次重试回合，总账通常更贵。");
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
