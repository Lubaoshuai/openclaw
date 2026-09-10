import { execFileSync } from "node:child_process";
import os from "node:os";
import type { NodeHostStatsPayload } from "../../packages/gateway-protocol/src/schema/nodes.js";
import { tryReadDiskSpace } from "../infra/disk-space.js";

function clampFinite(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, value)) : 0;
}

// `os.freemem()` on macOS only counts `Pages free`, ignoring the reclaimable
// `Pages inactive` / `Pages purgeable` / `Pages speculative` file cache, so
// `total - free` sits near 100% even on an idle host. Sum the reclaimable
// categories from `vm_stat` instead, matching what Activity Monitor reports
// as available memory.
export function parseDarwinVmStatAvailableBytes(output: string): number | null {
  const pageSizeMatch = /page size of (\d+) bytes/.exec(output);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 16_384;
  const pages = (label: string): number => {
    const match = new RegExp(`${label}[^:]*:\\s+(\\d+)`).exec(output);
    return match ? Number(match[1]) * pageSize : 0;
  };
  const available =
    pages("Pages free") +
    pages("Pages inactive") +
    pages("Pages purgeable") +
    pages("Pages speculative");
  return available > 0 ? available : null;
}

function readDarwinAvailableMemoryBytes(): number | null {
  try {
    const output = execFileSync("vm_stat", {
      encoding: "utf8",
      timeout: 2_000,
    });
    return parseDarwinVmStatAvailableBytes(output);
  } catch {
    return null;
  }
}

function readAvailableMemoryBytes(): number {
  const available =
    process.platform === "darwin"
      ? readDarwinAvailableMemoryBytes()
      : null;
  return available ?? os.freemem();
}

export function sampleNodeHostStats(): NodeHostStatsPayload {
  const memoryTotalBytes = Math.round(clampFinite(os.totalmem()));
  const memoryFreeBytes = Math.round(
    clampFinite(readAvailableMemoryBytes(), memoryTotalBytes)
  );
  const loads = os.loadavg();
  const loadAverage: [number, number, number] = [
    clampFinite(loads[0]!, 100_000),
    clampFinite(loads[1]!, 100_000),
    clampFinite(loads[2]!, 100_000),
  ];
  // Report the user's home volume, independent of the worker's current directory.
  const disk = tryReadDiskSpace(os.homedir());
  const diskTotalBytes =
    disk?.totalBytes == null ? undefined : Math.round(clampFinite(disk.totalBytes));
  return {
    cpuCount: Math.max(1, Math.min(4096, os.cpus().length)),
    ...(loadAverage.some((load) => load !== 0) ? { loadAverage } : {}),
    memoryTotalBytes,
    memoryFreeBytes,
    ...(disk && diskTotalBytes !== undefined
      ? {
          diskTotalBytes,
          diskAvailableBytes: Math.round(clampFinite(disk.availableBytes, diskTotalBytes)),
        }
      : {}),
  };
}
