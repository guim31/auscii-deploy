import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScreenshotProvider } from "../types";
import { hashInt, sleep } from "../mock-utils";

const PALETTES = [
  ["#1e3a8a", "#dbeafe"],
  ["#14532d", "#dcfce7"],
  ["#7c2d12", "#ffedd5"],
  ["#4a044e", "#fae8ff"],
  ["#0f172a", "#e2e8f0"],
];

function escapeXml(s: string) {
  return s.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Draws a plausible thumbnail instead of running a browser. */
export class MockScreenshotProvider implements ScreenshotProvider {
  readonly name = "mock-screenshot";

  async capture(_url: string, outPath: string, label: string): Promise<"svg"> {
    await sleep(800);
    const [dark, light] = PALETTES[hashInt(label, PALETTES.length)];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
<rect width="640" height="400" fill="${light}"/>
<rect width="640" height="56" fill="#ffffff"/>
<rect x="24" y="20" width="120" height="16" rx="4" fill="${dark}"/>
<rect x="420" y="22" width="48" height="12" rx="3" fill="#94a3b8"/><rect x="480" y="22" width="48" height="12" rx="3" fill="#94a3b8"/><rect x="540" y="22" width="72" height="12" rx="3" fill="#94a3b8"/>
<rect x="24" y="96" width="360" height="28" rx="6" fill="${dark}"/>
<rect x="24" y="136" width="300" height="14" rx="4" fill="#64748b"/>
<rect x="24" y="158" width="260" height="14" rx="4" fill="#64748b"/>
<rect x="24" y="196" width="120" height="36" rx="8" fill="${dark}"/>
<rect x="420" y="88" width="196" height="150" rx="10" fill="#ffffff"/>
<rect x="24" y="280" width="180" height="90" rx="10" fill="#ffffff"/><rect x="230" y="280" width="180" height="90" rx="10" fill="#ffffff"/><rect x="436" y="280" width="180" height="90" rx="10" fill="#ffffff"/>
<text x="32" y="112" font-family="system-ui, sans-serif" font-size="18" font-weight="700" fill="#ffffff">${escapeXml(label)}</text>
</svg>`;
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, svg, "utf8");
    return "svg";
  }
}
