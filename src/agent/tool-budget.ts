/**
 * 工具输出的 token 预算裁剪。
 *
 * 度量只有一处真源：`context.estimateTokens` / `indexAtTokenBudget`。这里**不再**
 * 自带一份"CJK 1 + 其余 0.25"的副本——那份副本曾经和估算器一起漂移：估算器开始把
 * base64 / 西里尔字符按更重的权重计费后，按旧口径切出来的片段实测是预算的 2.4 倍。
 * 工具输出按字符配预算时中文会被放大 4 倍；Codex 默认按 10KB bytes 截断并保留头尾，
 * 这里用 token 口径做同一件事，避免中文仓库把单次读取撑到几万 token。
 */
import { estimateTokens, indexAtTokenBudget } from "./context.js";

/** 只取前缀/后缀，不追加省略标记（调用方自己拼提示） */
export function sliceHeadToTokens(text: string, maxTokens: number): string {
  return text.slice(0, indexAtTokenBudget(text, maxTokens));
}

export function sliceTailToTokens(text: string, maxTokens: number): string {
  const start = indexAtTokenBudget(text, Math.max(0, estimateTokens(text) - maxTokens));
  return text.slice(start);
}

export type TokenTruncation = {
  text: string;
  truncated: boolean;
  omittedTokens: number;
};

/**
 * 头尾各留一部分，中间用省略标记连接。
 * headRatio 默认 0.5；0 = 只留尾，1 = 只留头。
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  options: {
    headRatio?: number;
    /** 自定义省略标记（不要带前后换行，函数会补） */
    note?: (omittedTokens: number) => string;
  } = {},
): TokenTruncation {
  const total = estimateTokens(text);
  if (total <= maxTokens) return { text, truncated: false, omittedTokens: 0 };

  const headRatio = Math.min(1, Math.max(0, options.headRatio ?? 0.5));
  // 给省略标记留 8% 余量，避免截完仍超预算
  const contentBudget = Math.max(0, maxTokens - Math.max(8, Math.ceil(maxTokens * 0.08)));
  const headBudget = Math.floor(contentBudget * headRatio);
  const tailBudget = contentBudget - headBudget;
  const head = sliceHeadToTokens(text, headBudget);
  const tail = sliceTailToTokens(text, tailBudget);
  const omitted = Math.max(1, total - estimateTokens(head) - estimateTokens(tail));
  const note = options.note?.(omitted) ?? `... [truncated ${omitted} tokens]`;
  return {
    text: `${head}\n${note}\n${tail}`,
    truncated: true,
    omittedTokens: omitted,
  };
}
