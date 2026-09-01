import { previewHostFor, type Settings } from "../settings";

export type ExpectedRecord = { zone: string; name: string; type: "A"; value: string; host: string };

/** The A records a site needs: apex and www on the client domain, the preview host on the tech domain. */
export function expectedDnsRecords(
  fqdn: string,
  slug: string,
  ip: string,
  settings: Pick<Settings, "techDomain" | "previewSubdomain">,
): ExpectedRecord[] {
  const previewHost = previewHostFor(slug, settings);
  return [
    { zone: fqdn, name: "@", type: "A", value: ip, host: fqdn },
    { zone: fqdn, name: "www", type: "A", value: ip, host: `www.${fqdn}` },
    {
      zone: settings.techDomain,
      name: previewHost.replace(`.${settings.techDomain}`, ""),
      type: "A",
      value: ip,
      host: previewHost,
    },
  ];
}

export function describeRecords(records: ExpectedRecord[]): string {
  return records.map((r) => `${r.host} → ${r.value}`).join(", ");
}
