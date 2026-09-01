import type { CloudProvider, CloudServer, ServerOffer } from "../types";
import { hashInt, sleep } from "../mock-utils";

export const MOCK_OFFERS: ServerOffer[] = [
  { id: "DEV1-S", vcpus: 2, ramGb: 2, diskGb: 20, monthlyPrice: 8.03, currency: "EUR" },
  { id: "DEV1-M", vcpus: 3, ramGb: 4, diskGb: 40, monthlyPrice: 14.26, currency: "EUR" },
  { id: "DEV1-L", vcpus: 4, ramGb: 8, diskGb: 80, monthlyPrice: 28.51, currency: "EUR" },
];

const servers = new Map<string, CloudServer & { createdAt: number }>();

export class MockCloudProvider implements CloudProvider {
  readonly name = "mock-scaleway";

  async listOffers(): Promise<ServerOffer[]> {
    await sleep(400);
    return MOCK_OFFERS;
  }

  async createServer(input: {
    name: string;
    offer: string;
    zone: string;
    cloudInit: string;
  }): Promise<CloudServer> {
    await sleep(1500);
    if (!MOCK_OFFERS.some((o) => o.id === input.offer))
      throw new Error(`Offre inconnue : ${input.offer}`);
    const providerId = `mock-srv-${hashInt(input.name, 1_000_000)}`;
    const server: CloudServer & { createdAt: number } = {
      providerId,
      name: input.name,
      zone: input.zone,
      state: "starting",
      createdAt: Date.now(),
    };
    servers.set(providerId, server);
    return server;
  }

  async getServer(providerId: string): Promise<CloudServer> {
    await sleep(700);
    const s = servers.get(providerId);
    if (!s) throw new Error(`Serveur introuvable : ${providerId}`);
    const elapsed = Date.now() - s.createdAt;
    if (s.state === "starting" && (elapsed > 2500 || process.env.NODE_ENV === "test")) {
      s.state = "running";
      s.ip = `51.15.${hashInt(providerId, 250) + 1}.${hashInt(s.name, 250) + 1}`;
    }
    return s;
  }

  async deleteServer(providerId: string): Promise<void> {
    await sleep(500);
    servers.delete(providerId);
  }
}
