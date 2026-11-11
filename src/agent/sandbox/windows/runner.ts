/**
 * Ported from deepseek-harness packages/sandbox/sandbox-windows-acl/src/runner.ts
 * (MIT License, Copyright (c) 2026 DeepSeek). KlockCode: standalone sandbox runner.
 *
 * Stable argv contract (server builds it):
 *   node runner.js --workspace <absReal> [--writable <abs>...]
 *                  [--temp <abs>|--no-temp] --mode workspace-write|read-only
 *                  -- <exe> [argv...]
 *   node runner.js --revoke --workspace <absReal> [--writable <abs>...]
 *
 * mode=read-only 必须配 --no-temp：不写任何 ACE、不上 Low 标签、不发私有 temp。
 *
 * Failure contract: stderr `klockcode-sandbox-run: <detail>` + exit 127.
 * The child is NEVER spawned unrestricted. Success writes no bytes.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseRunnerArgv } from "../runner-args.js";
import { win32 } from "./ffi.js";
import { revokeSandboxGrants, SandboxSession } from "./index.js";
import { waitForProcessExit } from "./job.js";
import { assertTempRootOutsideWorkspace } from "./path-boundary.js";
import { assertLocalNtfs } from "./probe.js";
import { spawnInheritedJobProcess } from "./spawn.js";

const RUNNER_SIGNATURE = "klockcode-sandbox-run";
const RUNNER_FAILURE_EXIT = 127;

class RunnerFailure extends Error {}

function fail(detail: string): never {
  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\n`);
  throw new RunnerFailure(detail);
}

function debugLog(detail: string): void {
  if (process.env.KLOCKCODE_SANDBOX_DEBUG === "1") {
    process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\n`);
  }
}

function requireDirectory(label: string, path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${label} is not an existing directory: ${path}`);
  }
}

async function main(): Promise<number> {
  const parsed = parseRunnerArgv(process.argv.slice(2));

  if (parsed.action === "revoke") {
    const revoked = revokeSandboxGrants(parsed.workspace, parsed.writableRoots);
    process.stdout.write(revoked ? "revoked\n" : "no-grant\n");
    return 0;
  }

  if (parsed.mode === "read-only" && parsed.tempRoot !== null) {
    // 契约违背：只读模式不许带私有 temp（客户端一律发 --no-temp）
    fail("read-only mode must not be given a private temp directory; pass --no-temp");
  }
  requireDirectory("--workspace", parsed.workspace);
  // read-only 不授权可写根，也就不必要求它们存在（被删/离线的额外根不该拦住只读命令）
  if (parsed.mode === "workspace-write") {
    for (const root of parsed.writableRoots) requireDirectory("--writable", root);
  }
  assertLocalNtfs("--workspace", parsed.workspace);
  if (parsed.mode === "workspace-write") {
    for (const root of parsed.writableRoots) assertLocalNtfs("--writable", root);
  }
  if (parsed.tempRoot !== null) {
    assertTempRootOutsideWorkspace(parsed.workspace, parsed.tempRoot);
    assertLocalNtfs("--temp", parsed.tempRoot);
  }

  const api = await win32();
  let privateTemp: string | undefined;
  if (parsed.tempRoot !== null) {
    mkdirSync(parsed.tempRoot, { recursive: true });
    requireDirectory("--temp", parsed.tempRoot);
    privateTemp = mkdtempSync(join(parsed.tempRoot, "mb-"));
  }

  let session: SandboxSession | undefined;
  try {
    // runner 自己不能被 CTRL+C 打断：它还要撤 temp 授权并回传退出码。
    if (api.setConsoleCtrlHandler(null, 1) === 0) {
      fail(`SetConsoleCtrlHandler failed (Win32 ${api.getLastError()})`);
    }

    session = new SandboxSession({
      workspace: parsed.workspace,
      writableRoots: parsed.writableRoots,
      tempDir: privateTemp ?? null,
      mode: parsed.mode,
    });
    const initStartedAt = Date.now();
    await session.init();
    debugLog(`init ${Date.now() - initStartedAt}ms`);

    if (privateTemp !== undefined) {
      // CreateProcessAsUserW 用 lpEnvironment=NULL 继承 runner 环境，所以只能在这里改。
      if (api.setEnvironmentVariableW("TMP", privateTemp) === 0) {
        fail(`SetEnvironmentVariableW TMP failed (Win32 ${api.getLastError()})`);
      }
      if (api.setEnvironmentVariableW("TEMP", privateTemp) === 0) {
        fail(`SetEnvironmentVariableW TEMP failed (Win32 ${api.getLastError()})`);
      }
    }

    const child = spawnInheritedJobProcess(api, {
      token: session.tokenHandle,
      command: parsed.executable,
      args: parsed.args,
      cwd: session.workspace,
    });
    debugLog(`spawned pid ${child.pid}: ${parsed.executable} ${parsed.args.join(" ")}`);
    try {
      return waitForProcessExit(api, child.process);
    } finally {
      if (api.closeHandle(child.job) === 0) {
        debugLog(`CloseHandle job failed (Win32 ${api.getLastError()})`);
      }
    }
  } finally {
    try {
      session?.dispose();
    } catch (error) {
      debugLog(`cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (privateTemp !== undefined) {
      try {
        rmSync(privateTemp, { recursive: true, force: true });
      } catch (error) {
        debugLog(`temp cleanup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

main().then(
  (exitCode) => {
    // 全 32 位回传：GetExitCodeProcess 的 uint32 直接交给 process.exitCode。
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    if (!(error instanceof RunnerFailure)) {
      process.stderr.write(
        `${RUNNER_SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    process.exitCode = RUNNER_FAILURE_EXIT;
  },
);
