import { previewHostFor, previewZone, type Settings } from "../settings";

export type ExpectedRecord = { zone: string; name: string; type: "A"; value: string; host: string };

type DnsSettings = Pick<Settings, "techDomain" | "previewSubdomain"> &
  Partial<Pick<Settings, "previewDomain">>;

/** The A records a site needs: apex and www on the client domain, the preview host on the preview zone. */
export function expectedDnsRecords(
  fqdn: string,
  slug: string,
  ip: string,
  settings: DnsSettings,
): ExpectedRecord[] {
  const previewHost = previewHostFor(slug, settings);
  const zone = previewZone(settings);
  return [
    { zone: fqdn, name: "@", type: "A", value: ip, host: fqdn },
    { zone: fqdn, name: "www", type: "A", value: ip, host: `www.${fqdn}` },
    {
      zone,
      name: previewHost.slice(0, -(zone.length + 1)),
      type: "A",
      value: ip,
      host: previewHost,
    },
  ];
}

export function describeRecords(records: ExpectedRecord[]): string {
  return records.map((r) => `${r.host} → ${r.value}`).join(", ");
}
