import { describe, expect, it } from "vitest";
import {
  evaluateServer,
  formatBytes,
  pickServer,
  requiredBytes,
  type CandidateServer,
} from "./capacity";
import { DEFAULT_SETTINGS } from "./settings";

const T = DEFAULT_SETTINGS.capacity;
const GB = 1024 ** 3;

function server(over: Partial<CandidateServer> & { id: string }): CandidateServer {
  return {
    name: over.id,
    status: "ready",
    vcpus: 2,
    sitesCount: 5,
    metrics: {
      load15: 0.2,
      vcpus: 2,
      ramUsedPct: 40,
      diskUsedPct: 30,
      diskFreeBytes: 14 * GB,
      sitesCount: 5,
      collectedAt: new Date().toISOString(),
    },
    ...over,
  };
}

describe("evaluateServer", () => {
  it("accepts a healthy server", () => {
    const v = evaluateServer(server({ id: "a" }), T);
    expect(v.level).toBe("ok");
    expect(v.reasons).toEqual([]);
  });

  it("flags a server past the disk threshold", () => {
    const s = server({ id: "a" });
    s.metrics!.diskUsedPct = 85;
    const v = evaluateServer(s, T);
    expect(v.level).toBe("full");
    expect(v.reasons[0]).toMatch(/Disque/);
  });

  it("warns near a threshold", () => {
    const s = server({ id: "a" });
    s.metrics!.ramUsedPct = 60; // 60 >= 80 * 0.7
    expect(evaluateServer(s, T).level).toBe("warn");
  });

  it("uses load per vcpu", () => {
    const s = server({ id: "a" });
    s.metrics!.load15 = 1.7; // 0.85 per vcpu > 0.8
    const v = evaluateServer(s, T);
    expect(v.level).toBe("full");
    expect(v.reasons[0]).toMatch(/CPU/);
  });

  it("rejects when free disk cannot hold the release", () => {
    const s = server({ id: "a" });
    s.metrics!.diskFreeBytes = 2.5 * GB;
    const v = evaluateServer(s, T, requiredBytes(500 * 1024 ** 2, T));
    expect(v.level).toBe("full");
    expect(v.reasons[0]).toMatch(/Espace disque/);
  });

  it("applies the hard cap", () => {
    const v = evaluateServer(server({ id: "a", sitesCount: 100 }), T);
    expect(v.level).toBe("full");
  });

  it("treats a server without metrics as usable with a warning", () => {
    const v = evaluateServer(server({ id: "a", metrics: null }), T);
    expect(v.level).toBe("warn");
  });

  it("marks non-ready servers unavailable", () => {
    expect(evaluateServer(server({ id: "a", status: "bootstrapping" }), T).level).toBe(
      "unavailable",
    );
  });
});

describe("pickServer", () => {
  it("asks for a new server when there is none", () => {
    expect(pickServer([], 1000, T).kind).toBe("new-server");
  });

  it("asks for a new server when all are full", () => {
    const s = server({ id: "a" });
    s.metrics!.diskUsedPct = 95;
    expect(pickServer([s], 1000, T).kind).toBe("new-server");
  });

  it("fills the busiest server first", () => {
    const a = server({ id: "a", sitesCount: 3 });
    const b = server({ id: "b", sitesCount: 12 });
    const p = pickServer([a, b], 1000, T);
    expect(p.kind).toBe("existing");
    if (p.kind === "existing") expect(p.server.id).toBe("b");
  });

  it("skips the busiest server when it is full", () => {
    const a = server({ id: "a", sitesCount: 3 });
    const b = server({ id: "b", sitesCount: 12 });
    b.metrics!.ramUsedPct = 90;
    const p = pickServer([a, b], 1000, T);
    if (p.kind === "existing") expect(p.server.id).toBe("a");
    else throw new Error("expected existing");
  });
});

describe("formatBytes", () => {
  it("formats in French units", () => {
    expect(formatBytes(512)).toBe("512 o");
    expect(formatBytes(1536)).toBe("1.5 Ko");
    expect(formatBytes(2 * GB)).toBe("2.0 Go");
    expect(formatBytes(14 * GB)).toBe("14 Go");
  });
});
