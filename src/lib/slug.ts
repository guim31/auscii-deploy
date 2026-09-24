/** Turns "Boulangerie Dupont & Fils" into "boulangerie-dupont-fils", "Sœurs Martin" into "soeurs-martin". */
export function slugify(input: string): string {
  return input
    .replace(/œ/g, "oe")
    .replace(/Œ/g, "Oe")
    .replace(/æ/g, "ae")
    .replace(/Æ/g, "Ae")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const FQDN = new RegExp(`^(?=.{4,253}$)(${LABEL}\\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{1,59})$`);

/**
 * Normalizes what a manager types into an ASCII domain name: scheme, path,
 * port, "www." and the trailing dot are removed, accented names (IDN) are
 * converted to their punycode form ("boulangerie-été.fr" → "xn--boulangerie--t-bga…").
 */
export function normalizeFqdn(input: string): string {
  const raw = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!raw || /[\s@]/.test(raw)) return raw;
  try {
    return new URL(`http://${raw}`).hostname;
  } catch {
    return raw;
  }
}

export function isValidFqdn(fqdn: string): boolean {
  return FQDN.test(fqdn);
}
