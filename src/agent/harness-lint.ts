/**
 * 架构图**语义**校验（lint）：在结构校验之外，回答"这张图跑起来到底会发生什么"。
 *
 * 为什么不并进 `validateHarnessDocument`：那边的原则是"只管结构，不管语义删减"——
 * 用户删掉一段流程是他的自由（metis 同款）。但"删了之后运行时**静默**失效"不是自由，
 * 是坑：删掉一条 `tier-gate` 边，门禁节点还留在画布上、名字还在，却再也不会执行。
 * 所以这里的产物不是"能不能存"，而是**带后果的提示**——每条 `code` 都对应一处真实的
 * 运行时读图逻辑，改的是那条路径的实际行为，不是风格建议：
 *
 *  - `workflow-runtime.ts:deriveGateSteps` 只认 `type === "tier-gate"`、且方向必须是
 *    tier → gate 的边，其余形态一律**跳过**；
 *  - 同 `deriveGateSteps` 里门禁序按 `order` 升序、**平手用 id 字典序**；
 *  - `admit()` 对"序列里有门禁但没关账角色"是**硬拒绝**（报错不进门禁），
 *    所以这条在编辑期就该看到，而不是任务跑到一半才发现；
 *  - `admit()` 对"该 tier 没有门禁"是**声明即完成**（T0 的设计，T1/T2 也可改成这样）；
 *  - `applyChildGate` 里 `loop-to:<gate>` 的目标不在本 lane 序列时**静默回退到第一道门禁**；
 *  - `deriveRoleOverrides` 用 `set(roleType, override)`，同类型多个角色节点 → **后者覆盖前者**；
 *  - `deriveAgentTools` / `deriveAgentPrompt` 只取 id 为 `main` 的 agent 节点，没有则取**第一个**。
 */
import type { HarnessDocument, HarnessNode } from "./harness-document.js";

export type HarnessFindingSeverity = "error" | "warning";

export type HarnessFindingCode =
  | "edge-type-ignored"
  | "gate-unattached"
  | "gate-unclosable"
  | "loop-target-untethered"
  | "gate-order-duplicate"
  | "tier-gateless"
  | "role-override-shadowed"
  | "tool-unknown"
  | "root-agent-missing"
  | "root-agent-duplicate";

export interface HarnessFinding {
  code: HarnessFindingCode;
  severity: HarnessFindingSeverity;
  /** 完整的一句话：说清"哪个节点、为什么、运行时会发生什么"。 */
  message: string;
  /** 相关节点 id，编辑器据此在画布上定位/高亮 */
  nodeId?: string;
}

export interface HarnessLintOptions {
  /**
   * 已知工具名。给了才检查 `tools` 白名单里的拼写——校验器不该自己猜有哪些工具，
   * 由调用方（server / runtime）把真实工具表传进来，避免两处清单各自漂移。
   */
  knownTools?: ReadonlySet<string>;
}

/** 角色节点的角色类型：显式 `data.role` 优先，否则回落节点 id（与 roleTypeOfNode 同义）。 */
function roleTypeOf(node: HarnessNode): string | undefined {
  if (node.type !== "role") return undefined;
  const raw = (node.data as { role?: unknown }).role;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return node.id;
}

/** 节点的人类可读标识：`G6 (验证)`，名字缺失时只有 id。 */
function tag(node: HarnessNode): string {
  const name = (node.data as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? `${node.id} (${name})` : node.id;
}

function hasOverrides(node: HarnessNode): boolean {
  const data = node.data as { systemPrompt?: unknown; tools?: unknown };
  return data.systemPrompt !== undefined || data.tools !== undefined;
}

export function lintHarnessDocument(
  doc: HarnessDocument,
  options: HarnessLintOptions = {},
): HarnessFinding[] {
  const findings: HarnessFinding[] = [];
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const gates = doc.nodes.filter((node) => node.type === "gate");
  const tiers = doc.nodes.filter((node) => node.type === "tier");

  /** tier → 门禁序列（顺序与 deriveGateSteps 一致：order 升序、平手按 id 字典序） */
  const sequence = new Map<string, string[]>();
  /** gate → 它出现在哪些 tier 的序列里 */
  const gateTiers = new Map<string, string[]>();
  /** tier → order（原样，undefined 单独归组）→ 门禁 id 列表 */
  const orderGroups = new Map<string, Map<string, string[]>>();
  /** gate → 关账角色类型 */
  const closerOf = new Map<string, string>();

  for (const edge of doc.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    // 端点不存在 → 结构校验已经报过，这里不重复
    if (source === undefined || target === undefined) continue;

    if (source.type === "tier" && target.type === "gate") {
      if (edge.type !== "tier-gate") {
        findings.push({
          code: "edge-type-ignored",
          severity: "warning",
          nodeId: target.id,
          message:
            `Tier ${tag(source)} → gate ${tag(target)} is connected as ` +
            `${edge.type === undefined ? "an untyped edge" : `type "${String(edge.type)}"`}, ` +
            `but gate sequencing only reads type "tier-gate". This gate is in no sequence, so it never runs.`,
        });
        continue;
      }
      const rawOrder = (edge as { order?: unknown }).order;
      const orderKey = typeof rawOrder === "number" ? String(rawOrder) : "none";
      const perTier = orderGroups.get(source.id) ?? new Map<string, string[]>();
      const bucket = perTier.get(orderKey) ?? [];
      if (!bucket.includes(target.id)) bucket.push(target.id);
      perTier.set(orderKey, bucket);
      orderGroups.set(source.id, perTier);

      const list = sequence.get(source.id) ?? [];
      if (!list.includes(target.id)) list.push(target.id);
      sequence.set(source.id, list);

      const owners = gateTiers.get(target.id) ?? [];
      if (!owners.includes(source.id)) owners.push(source.id);
      gateTiers.set(target.id, owners);
      continue;
    }

    if (source.type === "gate" && target.type === "tier" && edge.type === "tier-gate") {
      findings.push({
        code: "edge-type-ignored",
        severity: "warning",
        nodeId: source.id,
        message:
          `Gate ${tag(source)} → tier ${tag(target)} is drawn backwards with type "tier-gate"; ` +
          `the sequencer only reads tier → gate, so this gate is in no sequence and never runs.`,
      });
      continue;
    }

    if (edge.type === "gate-role" && source.type === "gate" && target.type === "role") {
      const role = roleTypeOf(target);
      if (role !== undefined && !closerOf.has(source.id)) closerOf.set(source.id, role);
    }
  }

  // 序列内排序：order 升序、平手 id 字典序（与 deriveGateSteps 一字不差）
  for (const [tierId, list] of sequence) {
    const orderOf = new Map<string, number>();
    for (const [orderKey, ids] of orderGroups.get(tierId) ?? []) {
      const value = orderKey === "none" ? Number.MAX_SAFE_INTEGER : Number(orderKey);
      for (const id of ids) orderOf.set(id, value);
    }
    list.sort(
      (a, b) =>
        (orderOf.get(a) ?? Number.MAX_SAFE_INTEGER) - (orderOf.get(b) ?? Number.MAX_SAFE_INTEGER) ||
        a.localeCompare(b, "en"),
    );
  }

  for (const gate of gates) {
    const owners = gateTiers.get(gate.id) ?? [];
    if (owners.length === 0) {
      findings.push({
        code: "gate-unattached",
        severity: "warning",
        nodeId: gate.id,
        message:
          `Gate ${tag(gate)} is not attached to any tier, so no run will ever reach it. ` +
          `Its invariant is silently unenforced — attach it to a tier or delete it.`,
      });
      continue;
    }
    if (!closerOf.has(gate.id)) {
      findings.push({
        code: "gate-unclosable",
        severity: "error",
        nodeId: gate.id,
        message:
          `Gate ${tag(gate)} has no gate-role binding. admit() rejects any tier whose sequence ` +
          `contains a gate without a closing role, so runs on ${owners.join(", ")} cannot be admitted at all — ` +
          `drag a role onto this gate to bind a closer.`,
      });
    }
  }

  // loop-to 目标不在同一 tier 的序列里 → 运行时静默回退到该 tier 第一道门禁
  for (const gate of gates) {
    const onFail = (gate.data as { onFail?: unknown }).onFail;
    if (typeof onFail !== "string" || !onFail.startsWith("loop-to:")) continue;
    const targetId = onFail.slice("loop-to:".length).trim();
    if (!byId.has(targetId)) continue; // 结构校验已报"目标不存在"
    for (const tierId of gateTiers.get(gate.id) ?? []) {
      const list = sequence.get(tierId) ?? [];
      if (list.includes(targetId)) continue;
      const fallback = list[0] ?? "the first gate of the tier";
      findings.push({
        code: "loop-target-untethered",
        severity: "warning",
        nodeId: gate.id,
        message:
          `Gate ${tag(gate)} says onFail=loop-to:${targetId}, but ${targetId} is not in tier ${tierId}'s ` +
          `gate sequence. The runtime silently rewinds to ${fallback} instead, so the rework loop you drew is not the one that runs.`,
      });
    }
  }

  for (const [tierId, perTier] of orderGroups) {
    for (const [orderKey, ids] of perTier) {
      if (ids.length < 2) continue;
      const where = orderKey === "none" ? "without an order" : `with order ${orderKey}`;
      findings.push({
        code: "gate-order-duplicate",
        severity: "warning",
        nodeId: ids[0],
        message:
          `Tier ${tierId} has ${ids.length} gates ${where} (${ids.join(", ")}). ` +
          `Ties are broken by node id, so they run in alphabetical order rather than the order you drew.`,
      });
    }
  }

  for (const tier of tiers) {
    // T0 的设计就是"无门禁、声明即完成"，不算问题
    if (tier.id === "T0") continue;
    if ((sequence.get(tier.id) ?? []).length > 0) continue;
    findings.push({
      code: "tier-gateless",
      severity: "warning",
      nodeId: tier.id,
      message:
        `Tier ${tag(tier)} has no gates. admit() on this tier finishes immediately ` +
        `("no gates on this tier"), so the tier gates nothing — intended for trivial work, a hole for anything else.`,
    });
  }

  // 同类型多个角色节点：deriveRoleOverrides 用 set(roleType, …)，最后一个赢，其余静默丢弃
  const overriddenBy = new Map<string, HarnessNode[]>();
  for (const node of doc.nodes) {
    const role = roleTypeOf(node);
    if (role === undefined) continue;
    const list = overriddenBy.get(role) ?? [];
    list.push(node);
    overriddenBy.set(role, list);
  }
  const losers: Array<{ role: string; node: HarnessNode; winner: HarnessNode }> = [];
  for (const [role, list] of overriddenBy) {
    if (list.length < 2) continue;
    const withData = list.filter(hasOverrides);
    if (withData.length < 2) continue;
    const winner = withData[withData.length - 1]!;
    for (const node of withData) {
      if (node !== winner) losers.push({ role, node, winner });
    }
  }
  for (const { role, node, winner } of losers) {
    findings.push({
      code: "role-override-shadowed",
      severity: "warning",
      nodeId: node.id,
      message:
        `Role node ${tag(node)} carries overrides for role "${role}", but ${tag(winner)} declares the same role ` +
        `later in the document and wins. This node's prompt/tools are never applied — merge them or change its role.`,
    });
  }

  if (options.knownTools !== undefined) {
    const known = options.knownTools;
    for (const node of doc.nodes) {
      if (node.type !== "agent" && node.type !== "role") continue;
      const tools = (node.data as { tools?: unknown }).tools;
      if (!Array.isArray(tools)) continue;
      const unknown = tools.filter(
        (tool): tool is string => typeof tool === "string" && tool.trim() !== "" && !known.has(tool),
      );
      if (unknown.length === 0) continue;
      findings.push({
        code: "tool-unknown",
        severity: "warning",
        nodeId: node.id,
        message:
          `${node.type === "agent" ? "Root agent" : "Role node"} ${tag(node)} allows tool(s) that do not exist: ` +
          `${unknown.map((name) => `"${name}"`).join(", ")}. Unknown names are silently inert — ` +
          `a typo in the allowlist does not widen access, it just does nothing.`,
      });
    }
  }

  const agents = doc.nodes.filter((node) => node.type === "agent");
  if (agents.length === 0) {
    findings.push({
      code: "root-agent-missing",
      severity: "warning",
      message:
        "The document has no agent node. The root agent's system prompt and tool allowlist are read from it, " +
        "so both fall back to the profile defaults and any edit you intended here has no effect.",
    });
  } else if (agents.length > 1) {
    const winner = agents.find((node) => node.id === "main") ?? agents[0]!;
    for (const node of agents) {
      if (node === winner) continue;
      findings.push({
        code: "root-agent-duplicate",
        severity: "warning",
        nodeId: node.id,
        message:
          `Agent node ${tag(node)} is ignored: the root is ${tag(winner)} ` +
          `${winner.id === "main" ? '(id "main" wins)' : "(the first agent node wins)"}. ` +
          `Its prompt and tool allowlist are never applied.`,
      });
    }
  }

  return findings;
}

/** 一行摘要，供日志/诊断使用：`2 error(s), 3 warning(s)`。 */
export function summarizeHarnessFindings(findings: readonly HarnessFinding[]): string {
  const errors = findings.filter((item) => item.severity === "error").length;
  const warnings = findings.length - errors;
  return `${errors} error(s), ${warnings} warning(s)`;
}
