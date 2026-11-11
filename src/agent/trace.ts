import { randomUUID } from "node:crypto";

/**
 * 轻量 trace 记录：一次顶层会话一个 traceId，turn/llm/tool 三层 span。
 * 只在回合与工具粒度打点（不为流式 delta 建 span），环形缓冲上限 500 条。
 */
export type TraceSpanKind =
  | "turn"
  | "llm"
  | "tool"
  | "subagent"
  | "approval"
  | "policy"
  | "context";
export type TraceSpanStatus = "ok" | "error" | "aborted";

export type TraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: TraceSpanKind;
  name: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: TraceSpanStatus;
  attributes?: Record<string, unknown>;
  error?: string;
};

export type ActiveTraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: TraceSpanKind;
  name: string;
  startedAt: number;
  attributes?: Record<string, unknown>;
};

export type TraceSummary = {
  total: number;
  errors: number;
  aborted: number;
  averageMs: number;
  maxMs: number;
  byKind: Partial<Record<TraceSpanKind, number>>;
};

/**
 * 决策链：harness 做的每一个「为什么」都是一等记录。
 * 与 TraceSpan 分开存放，避免污染性能汇总；仍通过同一个 sink 以 span 形式落盘。
 */
export type DecisionKind = "policy" | "context";
export type DecisionRecord = {
  traceId: string;
  kind: DecisionKind;
  /** 命中的规则 id，例如 command-outside-workspace */
  rule: string;
  /** 结果，例如 allow | ask | deny | compact | shrink */
  outcome: string;
  /** 人可读的原因，能独立回答「为什么」 */
  reason: string;
  at: number;
  turnId?: string;
  callId?: string;
  sessionId?: string;
  tool?: string;
  details?: Record<string, unknown>;
};

export type TraceExport = {
  traceId: string;
  spans: TraceSpan[];
  decisions: DecisionRecord[];
};

const TRACE_SPAN_CAPACITY = 500;
const DECISION_CAPACITY = 1000;
const ERROR_MESSAGE_MAX = 300;

export function newTraceId(): string {
  return randomUUID();
}

export class TraceRecorder {
  private readonly spans: TraceSpan[] = [];
  private readonly decisions: DecisionRecord[] = [];
  private readonly sink?: (span: TraceSpan) => void;

  constructor(options: { sink?: (span: TraceSpan) => void } = {}) {
    this.sink = options.sink;
  }

  startSpan(input: {
    traceId: string;
    kind: TraceSpanKind;
    name: string;
    parentSpanId?: string;
    attributes?: Record<string, unknown>;
  }): ActiveTraceSpan {
    return {
      traceId: input.traceId,
      spanId: randomUUID().slice(0, 12),
      ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
      kind: input.kind,
      name: input.name,
      startedAt: Date.now(),
      ...(input.attributes ? { attributes: input.attributes } : {}),
    };
  }

  endSpan(
    active: ActiveTraceSpan,
    result: {
      status?: TraceSpanStatus;
      error?: unknown;
      attributes?: Record<string, unknown>;
    } = {},
  ): TraceSpan {
    const endedAt = Date.now();
    const errorText =
      result.error === undefined || result.error === null
        ? undefined
        : (result.error instanceof Error ? result.error.message : String(result.error)).slice(
            0,
            ERROR_MESSAGE_MAX,
          );
    const span: TraceSpan = {
      traceId: active.traceId,
      spanId: active.spanId,
      ...(active.parentSpanId ? { parentSpanId: active.parentSpanId } : {}),
      kind: active.kind,
      name: active.name,
      startedAt: active.startedAt,
      endedAt,
      durationMs: endedAt - active.startedAt,
      status: result.status ?? (errorText ? "error" : "ok"),
      ...(active.attributes || result.attributes
        ? { attributes: { ...active.attributes, ...result.attributes } }
        : {}),
      ...(errorText ? { error: errorText } : {}),
    };
    this.spans.push(span);
    if (this.spans.length > TRACE_SPAN_CAPACITY) this.spans.shift();
    try {
      this.sink?.(span);
    } catch {
      // 诊断落盘失败不能影响回合
    }
    return span;
  }

  /** 最近 limit 条，按发生顺序（旧 → 新）。 */
  list(limit = 100): TraceSpan[] {
    return this.spans.slice(Math.max(0, this.spans.length - limit));
  }

  summary(): TraceSummary {
    const byKind: Partial<Record<TraceSpanKind, number>> = {};
    let errors = 0;
    let aborted = 0;
    let maxMs = 0;
    let totalMs = 0;
    for (const span of this.spans) {
      byKind[span.kind] = (byKind[span.kind] ?? 0) + 1;
      if (span.status === "error") errors += 1;
      if (span.status === "aborted") aborted += 1;
      maxMs = Math.max(maxMs, span.durationMs);
      totalMs += span.durationMs;
    }
    return {
      total: this.spans.length,
      errors,
      aborted,
      averageMs: this.spans.length ? Math.round(totalMs / this.spans.length) : 0,
      maxMs,
      byKind,
    };
  }

  /** 记录一条决策：独立环形缓冲，不进入性能 span 列表；仍交给 sink 落盘。 */
  recordDecision(input: Omit<DecisionRecord, "at">): DecisionRecord {
    const record: DecisionRecord = { ...input, at: Date.now() };
    this.decisions.push(record);
    if (this.decisions.length > DECISION_CAPACITY) this.decisions.shift();
    try {
      this.sink?.({
        traceId: record.traceId,
        spanId: randomUUID().slice(0, 12),
        kind: record.kind,
        name: record.rule,
        startedAt: record.at,
        endedAt: record.at,
        durationMs: 0,
        status: "ok",
        attributes: { decision: record },
      });
    } catch {
      // 诊断落盘失败不能影响回合
    }
    return record;
  }

  listDecisions(
    options: { traceId?: string; kind?: DecisionKind; limit?: number } = {},
  ): DecisionRecord[] {
    const limit = Math.max(1, Math.min(DECISION_CAPACITY, options.limit ?? 200));
    const matched = this.decisions.filter(
      (record) =>
        (!options.traceId || record.traceId === options.traceId) &&
        (!options.kind || record.kind === options.kind),
    );
    return matched.slice(Math.max(0, matched.length - limit));
  }

  /** 导出一条完整轨迹，供回放与回归对比。 */
  exportTrace(traceId: string, limit = 500): TraceExport {
    return {
      traceId,
      spans: this.spans.filter((span) => span.traceId === traceId).slice(-limit),
      decisions: this.listDecisions({ traceId, limit: DECISION_CAPACITY }),
    };
  }

  clear(): void {
    this.spans.length = 0;
    this.decisions.length = 0;
  }
}
