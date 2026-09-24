// Always Paris time: the server renders in UTC (containers), the browser in its own zone;
// a fixed zone gives the same text on both sides (no hydration mismatch, no shifted hours).
const TIME_ZONE = "Europe/Paris";
const dateTime = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: TIME_ZONE,
});
const dateOnly = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeZone: TIME_ZONE });
const money = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return dateTime.format(typeof d === "string" ? new Date(d) : d);
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return dateOnly.format(typeof d === "string" ? new Date(d) : d);
}

export function formatEuro(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return money.format(n);
}

/** Amount in the given currency (EUR when unknown). */
export function formatMoney(n: number | null | undefined, currency?: string | null): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (!currency || currency === "EUR") return money.format(n);
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** "1 fichier", "3 fichiers". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n > 1 ? pluralForm : singular}`;
}

export function daysUntil(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const t = typeof d === "string" ? new Date(d) : d;
  return Math.ceil((t.getTime() - Date.now()) / 86_400_000);
}

export function relativeTime(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d) : d;
  const diff = Date.now() - t.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const days = Math.round(h / 24);
  if (days < 30) return `il y a ${days} j`;
  return formatDate(t);
}
