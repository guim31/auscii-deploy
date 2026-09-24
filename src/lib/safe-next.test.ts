import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps internal paths", () => {
    expect(safeNext("/sites/abc?tab=1")).toBe("/sites/abc?tab=1");
  });
  it("refuses external or ambiguous destinations", () => {
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "evil", "/a\nb", ""])
      expect(safeNext(bad)).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext(["/a", "/b"])).toBe("/");
  });
});
