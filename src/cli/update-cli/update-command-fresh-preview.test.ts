import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import * as updateGlobal from "../../infra/update-global.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import * as processIdentity from "../../shared/pid-alive.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import * as shared from "./shared.js";
import * as databaseContext from "./update-command-database-context.js";
import * as executorOwner from "./update-command-executor.js";
import * as initialization from "./update-command-initialization.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

const dirs = createTempDirTracker();
let root: string;
let databasePath: string;
let managedServiceNodeRunner: string | undefined;
const targetMetadata = {
  target: "2026.9.2",
  version: "2026.9.2",
  nodeEngine: null,
  schemaVersions: { state: 16, agent: 19 },
};

beforeEach(() => {
  managedServiceNodeRunner = undefined;
  const home = dirs.make("openclaw-update-fresh-preview-");
  root = path.join(home, "installation");
  fs.mkdirSync(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
  );
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "profile"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(home, "profile", "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
  vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", undefined);
  databasePath = resolveOpenClawStateSqlitePath(process.env);
  const executorRoot = path.join(home, "executor");
  fs.mkdirSync(executorRoot);
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(executorRoot);
  // The macOS test sandbox denies /bin/ps. Keep real lease ownership and liveness,
  // supplying only the stable self identity that the OS probe cannot read here.
  vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation((pid) =>
    pid === process.pid ? 1_700_000_000 : null,
  );
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(commandRun, "prepareUpdateCommand").mockImplementation(async (opts) => ({
    startedAt: Date.now(),
    postCoreUpdateResume: false,
    postCoreUpdateChannel: undefined,
    timeoutMs: 5_000,
    shouldRestart: opts.restart !== false,
    requestedChannel: opts.channel === "stable" ? "stable" : null,
    devTarget: undefined,
    controlPlaneUpdateSentinelMeta: null,
    discoveredRoot: root,
    installKind: "package",
    servicePlan: { rootRedirect: null, nodeRunner: managedServiceNodeRunner },
  }));
  vi.spyOn(servicePlan, "isGatewayServiceManagementAllowedForUpdate").mockReturnValue(false);
  vi.spyOn(databaseContext, "inspectUpdateDatabaseContexts").mockImplementation(async () => ({
    service: undefined,
    services: new Map(),
    contexts: [await captureTargetDatabaseSchemaContext(process.env)],
    managedEnv: undefined,
  }));
  vi.spyOn(shared, "resolveGlobalManager").mockResolvedValue("npm");
  vi.spyOn(shared, "resolveTargetVersion").mockResolvedValue("2026.9.2");
  vi.spyOn(updateGlobal, "createGlobalInstallEnv").mockResolvedValue({ ...process.env });
  vi.spyOn(updateGlobal, "resolveGlobalInstallTarget").mockResolvedValue({
    manager: "npm",
    command: "npm",
    globalRoot: path.dirname(root),
    packageRoot: root,
    npmOwner: { version: "11.10.0", lifecyclePolicy: "unflagged" },
  });
  vi.spyOn(updateCheck, "resolveNpmChannelTag").mockResolvedValue({
    tag: "latest",
    version: "2026.9.2",
  });
  vi.spyOn(packageMetadata, "fetchNpmPackageTargetStatus").mockResolvedValue(targetMetadata);
  vi.spyOn(packageUpdate, "stagePackageInstallUpdate").mockRejectedValue(
    new Error("Read-only update admission must not stage a package"),
  );
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  dirs.cleanup();
});

function expectFreshStatePreserved() {
  expect(fs.existsSync(databasePath)).toBe(false);
  expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
  expect(fs.readdirSync(root)).toEqual(["package.json"]);
}

function writeStoredChannel(channel: "stable" | "beta") {
  const configPath = process.env.OPENCLAW_CONFIG_PATH!;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ update: { channel } }));
  return configPath;
}

describe("update command admission with fresh state", () => {
  it("previews an older stable without creating the current runtime database or staging it", async () => {
    await updateCommand({ tag: "2026.9.2", dryRun: true, json: true, restart: false });

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        currentVersion: "2026.9.3",
        targetVersion: "2026.9.2",
        downgradeRisk: true,
      }),
    );
    expectFreshStatePreserved();
  });

  it.each([{ channel: "stable" }, { tag: "latest" }])(
    "refuses unresolved registry metadata for %j before creating runtime state",
    async (target) => {
      vi.mocked(shared.resolveTargetVersion).mockResolvedValue(null);
      vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({
        tag: "latest",
        version: null,
      });

      await expect(
        updateCommand({ ...target, yes: true, json: true, restart: false }),
      ).rejects.toMatchObject({ result: { reason: "target-metadata-preflight" } });

      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", reason: "target-metadata-preflight" }),
      );
      expectFreshStatePreserved();
    },
  );

  it("reports exact package metadata failure without creating runtime state", async () => {
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      target: "2026.9.2",
      version: null,
      nodeEngine: null,
      error: "registry unavailable",
    });

    await expect(
      updateCommand({ tag: "2026.9.2", yes: true, json: true, restart: false }),
    ).rejects.toMatchObject({ result: { reason: "target-metadata-preflight" } });

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", reason: "target-metadata-preflight" }),
    );
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("registry unavailable"),
    );
    expectFreshStatePreserved();
  });

  it.each([
    { owned: true, restart: true, expectedFallback: "/current/node" },
    { owned: false, restart: true, expectedFallback: undefined },
    { owned: true, restart: false, expectedFallback: undefined },
  ])(
    "limits fresh-state Node fallback to the service it will refresh (owned=$owned, restart=$restart)",
    async ({ owned, restart, expectedFallback }) => {
      managedServiceNodeRunner = "/service/node";
      vi.spyOn(shared, "resolveNodeRunner").mockReturnValue("/current/node");
      vi.spyOn(servicePlan, "gatewayServiceCommandUsesRoot").mockResolvedValue(owned);
      const runtimePreflight = vi
        .spyOn(servicePlan, "resolvePackageRuntimePreflight")
        .mockResolvedValue({ ok: false, error: "fixture-stop" });

      await expect(
        updateCommand({ tag: "2026.9.2", yes: true, json: true, restart }),
      ).rejects.toMatchObject({ result: { reason: "node-runtime-preflight" } });

      expect(
        runtimePreflight.mock.calls.map(([params]) => ({
          nodeRunner: params.nodeRunner,
          fallbackNodeRunner: params.fallbackNodeRunner,
        })),
      ).toEqual([
        {
          nodeRunner: "/service/node",
          fallbackNodeRunner: expectedFallback,
        },
      ]);
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", reason: "node-runtime-preflight" }),
      );
      expectFreshStatePreserved();
    },
  );

  it("selects the fresh managed profile's stored channel instead of the shell profile's channel", async () => {
    const shellConfigPath = process.env.OPENCLAW_CONFIG_PATH!;
    fs.mkdirSync(path.dirname(shellConfigPath), { recursive: true });
    fs.writeFileSync(shellConfigPath, JSON.stringify({ update: { channel: "stable" } }));
    const serviceStateDir = dirs.make("openclaw-update-managed-profile-");
    const serviceConfigPath = path.join(serviceStateDir, "openclaw.json");
    fs.writeFileSync(serviceConfigPath, JSON.stringify({ update: { channel: "beta" } }));
    const serviceEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: serviceStateDir,
      OPENCLAW_CONFIG_PATH: serviceConfigPath,
    };
    vi.spyOn(commandRun, "resolveUpdateCommandAdmissionEnv").mockResolvedValue(serviceEnv);
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: false,
      error: "fixture-stop",
    });
    vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({
      tag: "beta",
      version: "2026.9.2",
    });

    await expect(updateCommand({ yes: true, json: true, restart: false })).rejects.toMatchObject({
      result: { reason: "node-runtime-preflight" },
    });

    expect(
      vi.mocked(updateCheck.resolveNpmChannelTag).mock.calls.map(([params]) => params.channel),
    ).toEqual(["beta"]);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(serviceEnv))).toBe(false);
    expect(process.env.OPENCLAW_CONFIG_PATH).toBe(shellConfigPath);
    expectFreshStatePreserved();
  });

  it.each([
    { channel: undefined, reason: "update-channel-changed" },
    { channel: "stable" as const, reason: "node-runtime-preflight" },
  ])(
    "fences a changed stored channel after target lookup with explicit channel=$channel",
    async ({ channel, reason }) => {
      const configPath = writeStoredChannel("stable");
      vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockImplementationOnce(async () => {
        writeStoredChannel("beta");
        return targetMetadata;
      });
      const runtime = vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
        ok: false,
        error: "fixture-stop",
      });

      await expect(
        updateCommand({ channel, yes: true, json: true, restart: false }),
      ).rejects.toMatchObject({
        result: { reason },
      });

      expect(
        vi.mocked(updateCheck.resolveNpmChannelTag).mock.calls.map(([params]) => params.channel),
      ).toEqual(["stable"]);
      expect(runtime).toHaveBeenCalledTimes(channel ? 1 : 0);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
        update: { channel: "beta" },
      });
      expectFreshStatePreserved();
    },
  );

  it("refuses a stored-channel change during staging before target Doctor or activation", async () => {
    const configPath = writeStoredChannel("stable");
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: {},
    });
    const staged = { root, run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockImplementationOnce(async () => {
      writeStoredChannel("beta");
      return staged;
    });
    const doctor = vi
      .spyOn(packageUpdate, "runPackageUpdateDoctor")
      .mockRejectedValue(new Error("Unexpected target Doctor"));

    await expect(updateCommand({ yes: true, json: true, restart: false })).rejects.toMatchObject({
      result: { reason: "update-channel-changed" },
    });

    expect(doctor).not.toHaveBeenCalled();
    expect(staged.run).not.toHaveBeenCalled();
    expect(staged.close).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      update: { channel: "beta" },
    });
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("accepts target Doctor config changes that preserve the selected stored channel", async () => {
    const configPath = writeStoredChannel("stable");
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: {},
    });
    const staged = { root, run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(staged);
    const migrated = {
      update: { channel: "stable" },
      gateway: { mode: "local" },
      meta: { lastTouchedVersion: "2026.9.2" },
    };
    const afterDoctor = new Error("Fixture stopped after target Doctor revalidation");
    vi.spyOn(initialization, "initializeUpdateStateFromTarget").mockImplementation(
      async (params) => {
        await params.checkSchemas();
        fs.writeFileSync(configPath, JSON.stringify(migrated));
        await params.checkSchemas();
        throw afterDoctor;
      },
    );

    await expect(updateCommand({ yes: true, json: true, restart: false })).rejects.toBe(
      afterDoctor,
    );

    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual(migrated);
    expect(staged.close).toHaveBeenCalledOnce();
    expect(staged.run).not.toHaveBeenCalled();
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("keeps fresh staging releasable for a supervised handoff before package activation", async () => {
    let fence: UpdateRecoveryFence | undefined;
    const withExecutor = executorOwner.withUpdateCommandExecutor;
    vi.spyOn(executorOwner, "withUpdateCommandExecutor").mockImplementation((runId, operation) =>
      withExecutor(runId, async (executor) => {
        const enter = executor.enter.bind(executor);
        vi.spyOn(executor, "enter").mockImplementation(async (...args) => {
          fence = await enter(...args);
          return fence;
        });
        return await operation(executor);
      }),
    );
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: {},
    });
    const staged = {
      root,
      run: vi.fn().mockRejectedValue(new Error("Unexpected package activation")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(staged);
    const handoffStop = new Error("Fixture stopped after successful preflight handoff release");
    vi.spyOn(initialization, "initializeUpdateStateFromTarget").mockImplementation(async () => {
      assert(fence);
      executorOwner.releaseUpdateCommandPreflightForHandoff(fence);
      throw handoffStop;
    });

    await expect(
      updateCommand({ tag: "2026.9.2", yes: true, json: true, restart: true }),
    ).rejects.toBe(handoffStop);

    expect(staged.close).toHaveBeenCalledOnce();
    expect(staged.run).not.toHaveBeenCalled();
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(fs.readdirSync(root)).toEqual(["package.json"]);
  });
});
