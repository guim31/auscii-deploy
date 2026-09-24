import { describe, expect, it } from "vitest";
import { parseMetrics } from "./metrics";

const SAMPLE = `NPROC 2
LOAD 0.12 0.20 0.31 1/210 4321
MEM 2047840256 1234567890
DISK 20000000000 15000000000
SITES 3
`;

describe("parseMetrics", () => {
  it("parses the remote command output", () => {
    const m = parseMetrics(SAMPLE, 1);
    expect(m.vcpus).toBe(2);
    expect(m.load15).toBe(0.31);
    expect(m.ramUsedPct).toBe(40);
    expect(m.diskUsedPct).toBe(25);
    expect(m.diskFreeBytes).toBe(15000000000);
    expect(m.sitesCount).toBe(3);
  });

  it("falls back to the known vcpu count and tolerates line order", () => {
    const m = parseMetrics("SITES 0\nDISK 100 50\nMEM 100 60\nLOAD 0 0 0", 4);
    expect(m.vcpus).toBe(4);
    expect(m.ramUsedPct).toBe(40);
    expect(m.diskUsedPct).toBe(50);
  });

  it("rejects garbage", () => {
    expect(() => parseMetrics("bash: nproc: command not found", 2)).toThrow(/illisibles/);
  });

  it("never returns NaN when a value is missing", () => {
    const m = parseMetrics("NPROC\nLOAD\nMEM 2000\nDISK 100 40\nSITES", 2);
    for (const v of Object.values(m))
      if (typeof v === "number") expect(Number.isNaN(v)).toBe(false);
    expect(m.vcpus).toBe(2);
    expect(m.load15).toBe(0);
    expect(m.ramUsedPct).toBe(0);
    expect(m.diskUsedPct).toBe(60);
    expect(m.sitesCount).toBe(0);
  });

  it("clamps inconsistent values", () => {
    const m = parseMetrics("MEM 100 150\nDISK 100 50", 1);
    expect(m.ramUsedPct).toBe(0);
    expect(() => parseMetrics("MEM 100 50\nDISK 100 -5", 1)).toThrow(/illisibles/);
    expect(() => parseMetrics("MEM 100 50\nDISK 100", 1)).toThrow(/illisibles/);
    expect(parseMetrics("MEM 100 50\nDISK 100 150", 1).diskFreeBytes).toBe(100);
  });
});
