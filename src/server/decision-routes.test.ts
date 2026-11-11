import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentServer } from "./server";

const TOKEN = "decision-routes-token";
let server: AgentServer;
let baseUrl = "";
let workspace = "";
let homeDir = "";

const auth = { authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "meowcode-decision-routes-"));
  homeDir = await mkdtemp(path.join(tmpdir(), "meowcode-decision-routes-home-"));
  process.env.MEOWCODE_SERVER_TOKEN = TOKEN;
  process.env.MEOWCODE_WORKSPACE = workspace;
  process.env.MEOWCODE_SESSIONS_DIR = path.join(workspace, ".sessions");
  process.env.MEOWCODE_HOME_DIR = homeDir;
  process.env.MEOWCODE_PROVIDERS = JSON.stringify([
    { id: "p", name: "P", baseUrl: "http://127.0.0.1:1", model: "m" },
  ]);
  server = await startServer({ port: 0 });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server has no TCP address.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server.shutdown("test");
  await rm(workspace, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
  delete process.env.MEOWCODE_SERVER_TOKEN;
  delete process.env.MEOWCODE_WORKSPACE;
  delete process.env.MEOWCODE_SESSIONS_DIR;
  delete process.env.MEOWCODE_HOME_DIR;
  delete process.env.MEOWCODE_PROVIDERS;
});

describe("decision trace routes", () => {
  it("拒绝未授权访问", async () => {
    const response = await fetch(`${baseUrl}/diagnostics/decisions`);
    expect(response.status).toBe(401);
  });

  it("返回决策链响应契约，并接受 kind 过滤", async () => {
    const response = await fetch(`${baseUrl}/diagnostics/decisions?kind=policy&limit=10`, {
      headers: auth,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { decisions: unknown[] };
    expect(Array.isArray(body.decisions)).toBe(true);
  });

  it("忽略非法 kind，不把枚举错误抛给调用方", async () => {
    const response = await fetch(`${baseUrl}/diagnostics/decisions?kind=nonsense`, {
      headers: auth,
    });
    expect(response.status).toBe(200);
  });

  it("导出完整轨迹结构", async () => {
    const response = await fetch(`${baseUrl}/diagnostics/trace/export`, { headers: auth });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      traceId: string;
      spans: unknown[];
      decisions: unknown[];
    };
    expect(typeof body.traceId).toBe("string");
    expect(Array.isArray(body.spans)).toBe(true);
    expect(Array.isArray(body.decisions)).toBe(true);
  });
});
