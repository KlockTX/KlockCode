import { describe, expect, it } from "vitest";
import { applyLegacyEnvFallback } from "./legacy-env";

describe("旧品牌环境变量兼容", () => {
  it("MEOWCODE_* 在对应新变量缺失时回退映射", () => {
    const env: NodeJS.ProcessEnv = {
      MEOWCODE_SERVER_TOKEN: "legacy-token",
      MEOWCODE_SESSIONS_DIR: "/tmp/legacy-sessions",
    };
    applyLegacyEnvFallback(env);
    expect(env.KLOCKCODE_SERVER_TOKEN).toBe("legacy-token");
    expect(env.KLOCKCODE_SESSIONS_DIR).toBe("/tmp/legacy-sessions");
    // 旧变量不删除，旧脚本仍可自行读取
    expect(env.MEOWCODE_SERVER_TOKEN).toBe("legacy-token");
  });

  it("新变量显式设置时优先，空字符串也算显式", () => {
    const env: NodeJS.ProcessEnv = {
      MEOWCODE_LOG_DIR: "/legacy",
      KLOCKCODE_LOG_DIR: "/current",
      MEOWCODE_PROVIDER_ID: "legacy-provider",
      KLOCKCODE_PROVIDER_ID: "",
    };
    applyLegacyEnvFallback(env);
    expect(env.KLOCKCODE_LOG_DIR).toBe("/current");
    expect(env.KLOCKCODE_PROVIDER_ID).toBe("");
  });

  it("不带旧前缀的变量不受影响", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin", KLOCKCODE_WORKSPACE: "/work" };
    applyLegacyEnvFallback(env);
    expect(env).toEqual({ PATH: "/bin", KLOCKCODE_WORKSPACE: "/work" });
  });
});
