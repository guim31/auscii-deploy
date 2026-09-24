import type { ServerMetrics } from "../types";

/**
 * Single remote command whose output is parsed by parseMetrics. Every line is
 * prefixed so the parser does not depend on the order of the commands.
 * MemAvailable is missing on old kernels: the awk falls back to free + buffers + cache.
 */
export const METRICS_COMMAND = [
  'echo "NPROC $(nproc)"',
  'echo "LOAD $(cat /proc/loadavg)"',
  'echo "MEM $(awk \'/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} /^MemFree:/{f=$2} /^Buffers:/{b=$2} /^Cached:/{c=$2} END{if(a=="")a=f+b+c; print t*1024, a*1024}\' /proc/meminfo)"',
  'echo "DISK $(df -B1 --output=size,avail /srv 2>/dev/null | tail -1)"',
  'echo "SITES $(ls -1 /srv/sites 2>/dev/null | grep -v -- --preview | wc -l)"',
].join("; ");

/**
 * Parses METRICS_COMMAND's output. Never returns NaN: a missing optional value
 * falls back to a neutral one, a missing essential one (memory total, disk)
 * throws.
 */
export function parseMetrics(output: string, fallbackVcpus: number): ServerMetrics {
  const lines = Object.fromEntries(
    output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(" ");
        return i === -1 ? [l, ""] : [l.slice(0, i), l.slice(i + 1).trim()];
      }),
  ) as Record<string, string>;

  const vcpus = positive(lines.NPROC) ?? fallbackVcpus;
  const load15 = nonNegative(lines.LOAD?.split(/\s+/)[2]) ?? 0;
  const [memTotal, memAvail] = pair(lines.MEM);
  const [diskSize, diskAvail] = pair(lines.DISK);
  if (!memTotal || !diskSize || diskAvail === undefined)
    throw new Error(`Métriques illisibles : ${output.slice(0, 200)}`);

  return {
    load15,
    vcpus,
    // Unknown available memory counts as idle rather than full: a full server
    // would make the capacity planner order a new (paid) one.
    ramUsedPct: memAvail === undefined ? 0 : percentUsed(memTotal, memAvail),
    diskUsedPct: percentUsed(diskSize, diskAvail),
    diskFreeBytes: Math.min(diskAvail, diskSize),
    sitesCount: nonNegative(lines.SITES) ?? 0,
    collectedAt: new Date().toISOString(),
  };
}

/** Finite, non-negative number, or undefined (never NaN). */
function nonNegative(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function positive(value: string | undefined): number | undefined {
  const n = nonNegative(value);
  return n ? n : undefined;
}

function pair(line: string | undefined): [number | undefined, number | undefined] {
  const [a, b] = (line ?? "").split(/\s+/);
  return [positive(a), nonNegative(b)];
}

function percentUsed(total: number, available: number): number {
  const pct = Math.round(((total - available) / total) * 100);
  return Math.min(100, Math.max(0, pct));
}
