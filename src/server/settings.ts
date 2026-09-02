import { prisma } from "./db";
import { env } from "./env";

export type CapacityThresholds = {
  diskUsedPctMax: number;
  ramUsedPctMax: number;
  loadPerVcpuMax: number;
  sitesHardCap: number;
  warnPct: number;
  reserveBytes: number;
};

export type Settings = {
  demoMode: boolean;
  techDomain: string;
  previewSubdomain: string;
  defaultOffer: string;
  defaultZone: string;
  agencyName: string;
  /** Public half of the pilot's SSH key, shown in the UI and embedded in the bootstrap script. */
  sshPublicKey: string;
  /** Legal owner of purchased domains: the agency. */
  gandiContact: {
    organizationId: string;
    email: string;
    orgName: string;
    givenName: string;
    familyName: string;
    phone: string;
    street: string;
    zip: string;
    city: string;
    country: string;
  };
  capacity: CapacityThresholds;
};

export const DEFAULT_SETTINGS: Settings = {
  demoMode: true,
  techDomain: "auscii.site",
  previewSubdomain: "preview",
  defaultOffer: "DEV1-S",
  defaultZone: "fr-par-1",
  agencyName: "AUSCII",
  sshPublicKey: "",
  gandiContact: {
    organizationId: "",
    email: "",
    orgName: "",
    givenName: "",
    familyName: "",
    phone: "",
    street: "",
    zip: "",
    city: "",
    country: "FR",
  },
  capacity: {
    diskUsedPctMax: 80,
    ramUsedPctMax: 80,
    loadPerVcpuMax: 0.8,
    sitesHardCap: 100,
    warnPct: 70,
    reserveBytes: 2 * 1024 ** 3,
  },
};

type Key = keyof Settings;

export async function getSetting<K extends Key>(key: K): Promise<Settings[K]> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  if (!row) return DEFAULT_SETTINGS[key];
  return row.value as Settings[K];
}

export async function getSettings(): Promise<Settings> {
  const rows = await prisma.appSetting.findMany();
  const out: Settings = structuredClone(DEFAULT_SETTINGS);
  for (const row of rows) {
    if (row.key in out) (out as Record<string, unknown>)[row.key] = row.value;
  }
  if (env().DEMO_MODE) out.demoMode = true;
  return out;
}

export async function setSetting<K extends Key>(key: K, value: Settings[K]): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: value as object },
    update: { value: value as object },
  });
}

/** Demo mode is forced on by DEMO_MODE=true, otherwise toggled from the UI. */
export async function isDemoMode(): Promise<boolean> {
  if (env().DEMO_MODE) return true;
  return getSetting("demoMode");
}

export function previewHostFor(
  slug: string,
  settings: Pick<Settings, "techDomain" | "previewSubdomain">,
) {
  return `${slug}.${settings.previewSubdomain}.${settings.techDomain}`;
}
