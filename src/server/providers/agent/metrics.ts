import type { ServerMetrics } from "../types";

/**
 * Single remote command whose output is parsed by parseMetrics. Every line is
 * prefixed so the parser does not depend on the order of the commands.
 */
export const METRICS_COMMAND = [
  'echo "NPROC $(nproc)"',
  'echo "LOAD $(cat /proc/loadavg)"',
  "echo \"MEM $(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{print t*1024, a*1024}' /proc/meminfo)\"",
  'echo "DISK $(df -B1 --output=size,avail /srv 2>/dev/null | tail -1)"',
  'echo "SITES $(ls -1 /srv/sites 2>/dev/null | grep -v -- --preview | wc -l)"',
].join("; ");

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

  const vcpus = Number(lines.NPROC) || fallbackVcpus;
  const load15 = Number(lines.LOAD?.split(/\s+/)[2]) || 0;
  const [memTotal, memAvail] = (lines.MEM ?? "").split(/\s+/).map(Number);
  const [diskSize, diskAvail] = (lines.DISK ?? "").split(/\s+/).map(Number);
  if (!memTotal || !diskSize) throw new Error(`Métriques illisibles : ${output.slice(0, 200)}`);

  return {
    load15,
    vcpus,
    ramUsedPct: Math.round(((memTotal - memAvail) / memTotal) * 100),
    diskUsedPct: Math.round(((diskSize - diskAvail) / diskSize) * 100),
    diskFreeBytes: diskAvail,
    sitesCount: Number(lines.SITES) || 0,
    collectedAt: new Date().toISOString(),
  };
}
