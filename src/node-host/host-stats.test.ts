import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { validateNodeHostStatsPayload } from "../../packages/gateway-protocol/src/index.js";
import * as diskSpace from "../infra/disk-space.js";
import { parseDarwinVmStatAvailableBytes, sampleNodeHostStats } from "./host-stats.js";

afterEach(() => vi.restoreAllMocks());

it("samples the real host into the node host stats wire contract", () => {
  const stats = sampleNodeHostStats();
  expect(validateNodeHostStatsPayload(stats)).toBe(true);
  expect(stats.memoryTotalBytes).toBeGreaterThan(0);
  expect(stats.cpuCount).toBeGreaterThanOrEqual(1);
  expect(stats).not.toHaveProperty("updatedAtMs");
});

it("bounds OS readings and reports available space on the home volume", () => {
  vi.spyOn(os, "cpus").mockReturnValue([]);
  vi.spyOn(os, "loadavg").mockReturnValue([1.25, -1, 100_001]);
  vi.spyOn(os, "totalmem").mockReturnValue(100.4);
  vi.spyOn(os, "freemem").mockReturnValue(200);
  const disk = vi.spyOn(diskSpace, "tryReadDiskSpace").mockReturnValue({
    targetPath: os.homedir(),
    checkedPath: os.homedir(),
    totalBytes: 500.4,
    availableBytes: 600,
  });

  const stats = sampleNodeHostStats();
  expect(stats).toEqual({
    cpuCount: 1,
    loadAverage: [1.25, 0, 100_000],
    memoryTotalBytes: 100,
    memoryFreeBytes: 100,
    diskTotalBytes: 500,
    diskAvailableBytes: 500,
  });
  expect(disk).toHaveBeenCalledWith(os.homedir());
  expect(validateNodeHostStatsPayload(stats)).toBe(true);
});

it.each([
  null,
  { targetPath: "/home", checkedPath: "/home", totalBytes: null, availableBytes: 100 },
])("omits unavailable disk capacity and zero-only load averages", (disk) => {
  vi.spyOn(os, "loadavg").mockReturnValue([0, 0, 0]);
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockReturnValue(disk);
  const stats = sampleNodeHostStats();
  expect(validateNodeHostStatsPayload(stats)).toBe(true);
  expect(stats).not.toHaveProperty("loadAverage");
  expect(stats).not.toHaveProperty("diskTotalBytes");
  expect(stats).not.toHaveProperty("diskAvailableBytes");
});

it("counts reclaimable pages as available memory on macOS", () => {
  // `os.freemem()` on macOS reports only `Pages free`, which makes the
  // memory bar read ~100% used on an idle host. Available memory must
  // include the reclaimable inactive/purgeable/speculative pages.
  const vmStat = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                1000.",
    "Pages inactive:                            2000.",
    "Pages speculative:                          500.",
    "Pages wired down:                          3000.",
    "Pages purgeable:                            250.",
    "Pages active:                              4000.",
  ].join("\n");
  const available = parseDarwinVmStatAvailableBytes(vmStat);
  // (1000 + 2000 + 500 + 250) pages * 16384 bytes
  expect(available).toBe(3750 * 16384);
});

it("returns null when vm_stat output has no usable page counts", () => {
  expect(parseDarwinVmStatAvailableBytes("vm_stat: not available")).toBeNull();
});
