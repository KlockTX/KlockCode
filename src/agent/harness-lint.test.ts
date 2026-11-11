import { describe, expect, it } from "vitest";
import { builtinHarnessSeed, type HarnessDocument, type HarnessNode } from "./harness-document.js";
import { lintHarnessDocument, summarizeHarnessFindings, type HarnessFindingCode } from "./harness-lint.js";

function node(id: string, type: HarnessNode["type"], data: Record<string, unknown> = {}): HarnessNode {
  return { id, type, data: { id, name: id, ...data } as HarnessNode["data"] };
}

function edge(source: string, target: string, type?: string, order?: number, id?: string) {
  return {
    id: id ?? `${source}->${target}`,
    source,
    target,
    ...(type === undefined ? {} : { type }),
    ...(order === undefined ? {} : { order }),
  };
}

function doc(nodes: HarnessNode[], edges: Array<ReturnType<typeof edge>>): HarnessDocument {
  return { version: 1, nodes, edges } as HarnessDocument;
}

function codes(findings: ReturnType<typeof lintHarnessDocument>): HarnessFindingCode[] {
  return findings.map((item) => item.code);
}

/** 一张最小但语义完整的图：T1 → G1（由 reviewer 关账）。 */
function healthyDoc(): HarnessDocument {
  return doc(
    [node("main", "agent"), node("T1", "tier"), node("G1", "gate"), node("reviewer", "role", { role: "reviewer" })],
    [edge("main", "T1", "agent-tier"), edge("T1", "G1", "tier-gate", 1), edge("G1", "reviewer", "gate-role")],
  );
}

describe("lintHarnessDocument", () => {
  it("内置三档种子零发现（lint 不能对自己的产物报噪音）", () => {
    for (const profile of ["minimal", "standard", "complex"] as const) {
      const findings = lintHarnessDocument(builtinHarnessSeed(profile));
      expect(
        findings.map((item) => `${item.code}: ${item.message}`),
        `seed ${profile} should lint clean`,
      ).toEqual([]);
    }
  });

  it("语义完整的自建图零发现", () => {
    expect(lintHarnessDocument(healthyDoc())).toEqual([]);
  });

  it("门禁没挂到任何 tier：节点还在画布上，但再也不会执行", () => {
    const document = healthyDoc();
    document.nodes.push(node("G2", "gate"));
    const findings = lintHarnessDocument(document);
    expect(codes(findings)).toContain("gate-unattached");
    const finding = findings.find((item) => item.code === "gate-unattached");
    expect(finding?.severity).toBe("warning");
    expect(finding?.nodeId).toBe("G2");
    expect(finding?.message).toContain("silently unenforced");
  });

  it("门禁没有关账角色：admit 会直接拒绝该 tier（error 而非 warning）", () => {
    const document = healthyDoc();
    document.edges = document.edges.filter((item) => item.type !== "gate-role");
    const finding = lintHarnessDocument(document).find((item) => item.code === "gate-unclosable");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("cannot be admitted");
  });

  it("tier→gate 边没写 type：sequencer 只认 tier-gate，这张图等于没有门禁", () => {
    const document = healthyDoc();
    document.edges = document.edges.map((item) =>
      item.type === "tier-gate" ? { ...item, type: undefined } : item,
    );
    const found = codes(lintHarnessDocument(document));
    expect(found).toContain("edge-type-ignored");
    // 边不算序列之后，门禁就变成"没挂到 tier"，两条提示应当同时出现
    expect(found).toContain("gate-unattached");
  });

  it("tier-gate 边画反方向：同样不被读取", () => {
    const document = healthyDoc();
    document.edges = document.edges.map((item) =>
      item.type === "tier-gate" ? { ...item, source: "G1", target: "T1" } : item,
    );
    const finding = lintHarnessDocument(document).find((item) => item.code === "edge-type-ignored");
    expect(finding?.message).toContain("backwards");
  });

  it("loop-to 目标不在本 tier 序列：运行时会静默回退到第一道门禁", () => {
    // G2 挂在 T1 上，但它要求回跳的 G9 属于 T2 —— 跨 tier 的回跳不会执行，
    // applyChildGate 里 `lane.gateOrder.includes(loopTarget)` 为假，直接回退到第一道门禁
    const document = doc(
      [
        node("main", "agent"),
        node("T1", "tier"),
        node("T2", "tier"),
        node("G1", "gate"),
        node("G2", "gate", { onFail: "loop-to:G9" }),
        node("G9", "gate"),
        node("reviewer", "role", { role: "reviewer" }),
      ],
      [
        edge("main", "T1", "agent-tier"),
        edge("T1", "G1", "tier-gate", 1),
        edge("T1", "G2", "tier-gate", 2),
        edge("T2", "G9", "tier-gate", 1),
        edge("G1", "reviewer", "gate-role"),
        edge("G2", "reviewer", "gate-role"),
        edge("G9", "reviewer", "gate-role"),
      ],
    );
    const finding = lintHarnessDocument(document).find((item) => item.code === "loop-target-untethered");
    expect(finding?.nodeId).toBe("G2");
    expect(finding?.message).toContain("silently rewinds");
  });

  it("同 tier 内 order 重复：顺序静默退化成字典序", () => {
    const document = healthyDoc();
    document.nodes.push(node("G2", "gate"), node("G3", "gate"));
    document.edges.push(
      edge("T1", "G2", "tier-gate", 1),
      edge("T1", "G3", "tier-gate", 1),
      edge("G2", "reviewer", "gate-role"),
      edge("G3", "reviewer", "gate-role"),
    );
    const finding = lintHarnessDocument(document).find((item) => item.code === "gate-order-duplicate");
    expect(finding?.message).toContain("alphabetical");
  });

  it("T1/T2 没有门禁：admit 立即完成，等于没有门禁；T0 这种写法是设计", () => {
    const document = doc([node("main", "agent"), node("T0", "tier"), node("T1", "tier")], []);
    const found = lintHarnessDocument(document).filter((item) => item.code === "tier-gateless");
    expect(found.map((item) => item.nodeId)).toEqual(["T1"]);
    expect(found[0]?.message).toContain("gates nothing");
  });

  it("同类型两个角色节点都写了覆盖：后者赢，前者静默丢弃", () => {
    const document = healthyDoc();
    document.nodes[3] = node("reviewer", "role", { role: "reviewer", systemPrompt: "first" });
    document.nodes.push(node("reviewer2", "role", { role: "reviewer", systemPrompt: "second" }));
    const finding = lintHarnessDocument(document).find((item) => item.code === "role-override-shadowed");
    expect(finding?.nodeId).toBe("reviewer");
    expect(finding?.message).toContain("reviewer2 (reviewer2)".slice(0, 9));
    expect(finding?.message).toContain("never applied");
  });

  it("工具白名单里有不存在的名字：拼错不会放宽权限，只是什么都不做", () => {
    const document = healthyDoc();
    document.nodes[3] = node("reviewer", "role", { role: "reviewer", tools: ["read_file", "reed_file"] });
    const findings = lintHarnessDocument(document, {
      knownTools: new Set(["read_file", "grep", "task"]),
    });
    const finding = findings.find((item) => item.code === "tool-unknown");
    expect(finding?.nodeId).toBe("reviewer");
    expect(finding?.message).toContain('"reed_file"');
    expect(finding?.message).not.toContain('"read_file"');
  });

  it("按宿主注入的工具不算「工具不存在」：真源用 knownToolNames", async () => {
    const { knownToolNames } = await import("./tools.js");
    const document = healthyDoc();
    document.nodes[3] = node("reviewer", "role", {
      role: "reviewer",
      tools: ["read_file", "browser_navigate", "browser_screenshot"],
    });
    // 浏览器工具只在桌面端挂上 host 时才注册定义；按名字判「不存在」会让用户删掉合法白名单。
    const findings = lintHarnessDocument(document, { knownTools: knownToolNames() });
    expect(findings.some((item) => item.code === "tool-unknown")).toBe(false);
  });

  it("没有传 knownTools 时跳过工具名检查（校验器不自己猜工具表）", () => {
    const document = healthyDoc();
    document.nodes[3] = node("reviewer", "role", { role: "reviewer", tools: ["不存在"] });
    expect(codes(lintHarnessDocument(document))).not.toContain("tool-unknown");
  });

  it("根 agent 缺失 / 重复：提示词与工具白名单的落点不是你以为的那个", () => {
    const missing = healthyDoc();
    missing.nodes = missing.nodes.filter((item) => item.type !== "agent");
    missing.edges = missing.edges.filter((item) => item.type !== "agent-tier");
    expect(codes(lintHarnessDocument(missing))).toContain("root-agent-missing");

    const duplicated = healthyDoc();
    duplicated.nodes.push(node("shadow", "agent", { systemPrompt: "ignored" }));
    const finding = lintHarnessDocument(duplicated).find((item) => item.code === "root-agent-duplicate");
    expect(finding?.nodeId).toBe("shadow");
    expect(finding?.message).toContain("never applied");
  });

  it("摘要能一句话说清有几个 error / warning", () => {
    expect(summarizeHarnessFindings([])).toBe("0 error(s), 0 warning(s)");
    // 一个孤立门禁节点 = 没挂 tier + 没有根 agent，两条 warning
    const findings = lintHarnessDocument(doc([node("G1", "gate")], []));
    expect(summarizeHarnessFindings(findings)).toBe("0 error(s), 2 warning(s)");
  });
});
