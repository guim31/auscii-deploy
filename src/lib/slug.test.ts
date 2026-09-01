import { describe, expect, it } from "vitest";
import { isValidFqdn, normalizeFqdn, slugify } from "./slug";

describe("slugify", () => {
  it("strips accents and punctuation", () => {
    expect(slugify("Boulangerie Dupont & Fils")).toBe("boulangerie-dupont-fils");
    expect(slugify("  Château d'Ébène  ")).toBe("chateau-d-ebene");
  });
  it("caps the length", () => {
    expect(slugify("a".repeat(80)).length).toBeLessThanOrEqual(40);
  });
});

describe("fqdn", () => {
  it("normalizes user input", () => {
    expect(normalizeFqdn(" https://www.Dupont-Boulangerie.FR/ ")).toBe("dupont-boulangerie.fr");
  });
  it("validates", () => {
    expect(isValidFqdn("dupont.fr")).toBe(true);
    expect(isValidFqdn("dupont")).toBe(false);
    expect(isValidFqdn("-dupont.fr")).toBe(false);
    expect(isValidFqdn("dupont.boulangerie.fr")).toBe(true);
  });
});
