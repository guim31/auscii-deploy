import type { CapacityThresholds } from "./settings";
import type { ServerMetrics } from "./providers/types";

export type CandidateServer = {
  id: string;
  name: string;
  status: string;
  vcpus: number;
  metrics: ServerMetrics | null;
  sitesCount: number;
};

export type CapacityLevel = "ok" | "warn" | "full" | "unavailable";

export type CapacityVerdict = {
  serverId: string;
  level: CapacityLevel;
  reasons: string[];
  /** 0 to 100, the most loaded dimension. */
  usagePct: number;
};

export function requiredBytes(zipBytes: number, thresholds: CapacityThresholds): number {
  return zipBytes * 3 + thresholds.reserveBytes;
}

/** Evaluates one server against the thresholds. Pure, unit-tested. */
export function evaluateServer(
  server: CandidateServer,
  thresholds: CapacityThresholds,
  needBytes = 0,
): CapacityVerdict {
  const reasons: string[] = [];
  if (server.status !== "ready") {
    return {
      serverId: server.id,
      level: "unavailable",
      reasons: [`Serveur ${server.status}`],
      usagePct: 0,
    };
  }
  if (server.sitesCount >= thresholds.sitesHardCap) {
    reasons.push(`Plafond de ${thresholds.sitesHardCap} sites atteint`);
  }
  const m = server.metrics;
  if (!m) {
    return {
      serverId: server.id,
      level: reasons.length ? "full" : "warn",
      reasons: [...reasons, "Métriques non encore relevées"],
      usagePct: 0,
    };
  }
  const loadPct = (m.load15 / Math.max(1, m.vcpus)) * 100;
  const loadMaxPct = thresholds.loadPerVcpuMax * 100;
  const dims = [
    { name: "Disque", pct: m.diskUsedPct, max: thresholds.diskUsedPctMax },
    { name: "Mémoire", pct: m.ramUsedPct, max: thresholds.ramUsedPctMax },
    { name: "CPU", pct: loadPct, max: loadMaxPct },
  ];
  let usagePct = 0;
  let warn = false;
  for (const d of dims) {
    const relative = (d.pct / d.max) * 100;
    usagePct = Math.max(usagePct, Math.min(100, Math.round(relative)));
    if (d.pct >= d.max)
      reasons.push(`${d.name} à ${Math.round(d.pct)} % (max ${Math.round(d.max)} %)`);
    else if (d.pct >= (d.max * thresholds.warnPct) / 100) warn = true;
  }
  if (needBytes > 0 && m.diskFreeBytes < needBytes) {
    reasons.push(
      `Espace disque insuffisant (${formatBytes(m.diskFreeBytes)} libres, ${formatBytes(needBytes)} requis)`,
    );
  }
  if (reasons.length) return { serverId: server.id, level: "full", reasons, usagePct };
  return { serverId: server.id, level: warn ? "warn" : "ok", reasons: [], usagePct };
}

export type Placement =
  | {
      kind: "existing";
      server: CandidateServer;
      verdict: CapacityVerdict;
      verdicts: CapacityVerdict[];
    }
  | { kind: "new-server"; verdicts: CapacityVerdict[] };

/**
 * Chooses the server for a new site: the fullest server that still has room,
 * so servers fill up one after the other. Returns "new-server" when none fits.
 */
export function pickServer(
  servers: CandidateServer[],
  zipBytes: number,
  thresholds: CapacityThresholds,
): Placement {
  const needBytes = requiredBytes(zipBytes, thresholds);
  const verdicts = servers.map((s) => evaluateServer(s, thresholds, needBytes));
  const candidates = servers
    .map((server, i) => ({ server, verdict: verdicts[i] }))
    .filter(({ verdict }) => verdict.level === "ok" || verdict.level === "warn")
    .sort(
      (a, b) =>
        b.server.sitesCount - a.server.sitesCount || a.server.name.localeCompare(b.server.name),
    );
  if (candidates.length === 0) return { kind: "new-server", verdicts };
  return { kind: "existing", ...candidates[0], verdicts };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
