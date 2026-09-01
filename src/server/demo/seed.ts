import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db";
import { randomToken } from "../crypto";
import { getMockProviders } from "../providers";
import { DEFAULT_SETTINGS, previewHostFor } from "../settings";
import { releaseDir, screenshotsDir } from "../releases/paths";
import { analyzeSite } from "../releases/analyze";
import { FORMS_ENDPOINT } from "../releases/analyze";
import type { ServerMetrics } from "../providers/types";

type DemoSite = {
  clientName: string;
  slug: string;
  domain: string;
  tagline: string;
  color: string;
  formsEmail: string;
  daysAgo: number;
  status: "live" | "preview";
  server: 0 | 1;
};

const DEMO_SITES: DemoSite[] = [
  {
    clientName: "Boulangerie Dupont",
    slug: "boulangerie-dupont",
    domain: "boulangerie-dupont.fr",
    tagline: "Pain au levain, viennoiseries maison, depuis 1987.",
    color: "#7c2d12",
    formsEmail: "contact@boulangerie-dupont.fr",
    daysAgo: 42,
    status: "live",
    server: 0,
  },
  {
    clientName: "Cabinet Martin Avocats",
    slug: "cabinet-martin",
    domain: "cabinet-martin-avocats.fr",
    tagline: "Droit des affaires et droit du travail à Toulouse.",
    color: "#1e3a8a",
    formsEmail: "accueil@cabinet-martin.fr",
    daysAgo: 18,
    status: "live",
    server: 0,
  },
  {
    clientName: "Studio Lumen Photo",
    slug: "studio-lumen",
    domain: "studio-lumen.com",
    tagline: "Portraits, mariages et reportages d'entreprise.",
    color: "#4a044e",
    formsEmail: "hello@studio-lumen.com",
    daysAgo: 6,
    status: "live",
    server: 1,
  },
  {
    clientName: "Garage Roux",
    slug: "garage-roux",
    domain: "garage-roux.fr",
    tagline: "Entretien et réparation toutes marques.",
    color: "#14532d",
    formsEmail: "garage.roux@example.com",
    daysAgo: 1,
    status: "preview",
    server: 1,
  },
];

function page(site: DemoSite, title: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${site.clientName}</title>
<meta name="description" content="${site.tagline}">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header><a class="brand" href="/">${site.clientName}</a><nav><a href="/">Accueil</a><a href="/services.html">Services</a><a href="/contact.html">Contact</a></nav></header>
<main>${body}</main>
<footer>© ${new Date().getFullYear()} ${site.clientName} — Site réalisé par AUSCII</footer>
</body>
</html>`;
}

function siteFiles(site: DemoSite): Record<string, string> {
  return {
    "index.html": page(
      site,
      "Accueil",
      `<section class="hero"><h1>${site.clientName}</h1><p>${site.tagline}</p><a class="btn" href="/contact.html">Nous contacter</a></section>
<section class="cards"><article><h2>Savoir-faire</h2><p>Une équipe locale, des méthodes éprouvées et une attention constante à la qualité pour chaque client.</p></article><article><h2>Proximité</h2><p>Nous vous accueillons du lundi au samedi et répondons à vos demandes sous 24 heures.</p></article><article><h2>Confiance</h2><p>Des centaines de clients nous recommandent depuis des années. Découvrez leurs témoignages.</p></article></section>`,
    ),
    "services.html": page(
      site,
      "Services",
      `<h1>Nos services</h1><ul class="list"><li>Conseil personnalisé et devis gratuit</li><li>Prestations sur mesure adaptées à votre besoin</li><li>Suivi et garantie sur l'ensemble de nos interventions</li></ul>`,
    ),
    "contact.html": page(
      site,
      "Contact",
      `<h1>Contact</h1><p>Écrivez-nous, nous vous répondons rapidement.</p>
<form action="${FORMS_ENDPOINT}" method="post" class="form">
<input type="text" name="website" tabindex="-1" autocomplete="off" style="display:none">
<label>Nom <input name="nom" required></label>
<label>Email <input type="email" name="email" required></label>
<label>Message <textarea name="message" rows="5" required></textarea></label>
<input type="hidden" name="_redirect" value="/merci.html">
<button class="btn" type="submit">Envoyer</button>
</form>`,
    ),
    "merci.html": page(
      site,
      "Merci",
      `<h1>Merci !</h1><p>Votre message a bien été envoyé. Nous revenons vers vous très vite.</p>`,
    ),
    "404.html": page(
      site,
      "Page introuvable",
      `<h1>Page introuvable</h1><p><a href="/">Retour à l'accueil</a></p>`,
    ),
    "style.css": `:root{--c:${site.color}}*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;color:#1f2937;line-height:1.6}header{display:flex;justify-content:space-between;align-items:center;padding:16px 32px;border-bottom:1px solid #e5e7eb}.brand{font-weight:700;color:var(--c);text-decoration:none;font-size:1.1rem}nav a{margin-left:20px;color:#374151;text-decoration:none}main{max-width:960px;margin:0 auto;padding:48px 24px}.hero{padding:48px 0}.hero h1{font-size:2.5rem;color:var(--c);margin:0 0 12px}.btn{display:inline-block;background:var(--c);color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;border:0;font-size:1rem;cursor:pointer}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}.cards article{background:#f9fafb;border-radius:12px;padding:20px}.form label{display:block;margin:12px 0;font-weight:500}.form input,.form textarea{display:block;width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font:inherit}footer{text-align:center;padding:24px;color:#6b7280;font-size:.9rem}`,
  };
}

const START = new Date("2026-06-01T09:00:00Z");

function ago(days: number, hours = 0): Date {
  return new Date(Date.now() - days * 86_400_000 - hours * 3_600_000);
}

let seeding: Promise<void> | null = null;

/** Seeds the demo data once. Concurrent callers share the same run. */
export function seedDemo(): Promise<void> {
  if (!seeding) {
    seeding = seedDemoOnce().finally(() => {
      seeding = null;
    });
  }
  return seeding;
}

async function seedDemoOnce(): Promise<void> {
  const existing = await prisma.server.count({ where: { isDemo: true } });
  if (existing > 0) return;

  const mock = getMockProviders();
  const settings = DEFAULT_SETTINGS;

  const servers = await Promise.all(
    [
      {
        name: "demo-01",
        ip: "51.15.42.17",
        createdAt: START,
        sites: 2,
        disk: 31,
        ram: 41,
        load: 0.18,
      },
      {
        name: "demo-02",
        ip: "51.15.87.203",
        createdAt: ago(20),
        sites: 2,
        disk: 22,
        ram: 34,
        load: 0.09,
      },
    ].map((s) =>
      prisma.server.create({
        data: {
          name: s.name,
          provider: "mock",
          providerId: `mock-srv-${s.name}`,
          ip: s.ip,
          status: "ready",
          offer: "DEV1-S",
          zone: "fr-par-1",
          vcpus: 2,
          monthlyPrice: 8.03,
          isDemo: true,
          createdAt: s.createdAt,
          metrics: {
            load15: s.load,
            vcpus: 2,
            ramUsedPct: s.ram,
            diskUsedPct: s.disk,
            diskFreeBytes: Math.round((20 * (100 - s.disk)) / 100) * 1024 ** 3,
            sitesCount: s.sites,
            collectedAt: new Date().toISOString(),
          } satisfies ServerMetrics,
        },
      }),
    ),
  );

  for (const demo of DEMO_SITES) {
    const server = servers[demo.server];
    const site = await prisma.site.create({
      data: {
        slug: demo.slug,
        clientName: demo.clientName,
        domain: demo.domain,
        previewHost: previewHostFor(demo.slug, settings),
        previewToken: randomToken(),
        formsEmail: demo.formsEmail,
        status: demo.status,
        serverId: server.id,
        gitRepo: `auscii/${demo.slug}`,
        isDemo: true,
        createdAt: ago(demo.daysAgo + 2),
        lastPublishedAt: demo.status === "live" ? ago(demo.daysAgo) : null,
        domainRecord: {
          create: {
            fqdn: demo.domain,
            owned: false,
            orderStatus: "registered",
            price: demo.domain.endsWith(".com") ? 14.9 : 12.5,
            currency: "EUR",
            expiresAt: ago(demo.daysAgo - 365),
            dnsConfigured: true,
          },
        },
      },
    });

    // Two releases for live sites (so rollback has something to go back to), one for the preview site.
    const versions = demo.status === "live" ? [1, 2] : [1];
    const releases = [];
    for (const version of versions) {
      const release = await prisma.release.create({
        data: {
          siteId: site.id,
          version,
          archiveHash: randomToken(32),
          sizeBytes: 0,
          fileCount: 0,
          commitSha: randomToken(20)
            .replace(/[^a-f0-9]/g, "a")
            .slice(0, 40),
          gitTag: demo.status === "live" ? `prod-2026${String(version).padStart(4, "0")}` : null,
          createdAt: ago(demo.daysAgo + (2 - version)),
        },
      });
      const dir = releaseDir(release.id);
      await mkdir(dir, { recursive: true });
      const files = siteFiles(demo);
      if (version === 1)
        files["index.html"] = files["index.html"].replace(
          demo.tagline,
          `${demo.tagline} (première version)`,
        );
      const list = [];
      for (const [name, content] of Object.entries(files)) {
        await writeFile(path.join(dir, name), content, "utf8");
        list.push({ path: name, size: Buffer.byteLength(content) });
      }
      const analysis = await analyzeSite(dir, list);
      await prisma.release.update({
        where: { id: release.id },
        data: {
          sizeBytes: list.reduce((n, f) => n + f.size, 0),
          fileCount: list.length,
          analysis: analysis as object,
          aiReport: await mock.ai.analyzeSite({
            clientName: demo.clientName,
            files: list,
            pages: analysis.pages.map((p) => ({ path: p.path, title: p.title, text: p.text })),
          }),
        },
      });
      releases.push(release);
    }
    const latest = releases[releases.length - 1];
    await prisma.site.update({
      where: { id: site.id },
      data: {
        stagingReleaseId: latest.id,
        liveReleaseId: demo.status === "live" ? latest.id : null,
      },
    });

    await mkdir(screenshotsDir(), { recursive: true });
    const ext = await mock.screenshot.capture(
      "",
      path.join(screenshotsDir(), `${site.id}.svg`),
      demo.clientName,
    );
    await prisma.site.update({
      where: { id: site.id },
      data: { screenshotPath: `${site.id}.${ext}` },
    });

    // Deployment history with logs.
    const history: {
      kind: "provision" | "deploy" | "promote";
      env: "staging" | "production" | null;
      release: (typeof releases)[number] | null;
      at: Date;
      steps: [string, string][];
    }[] = [
      {
        kind: "provision",
        env: null,
        release: null,
        at: ago(demo.daysAgo + 2),
        steps: [
          ["server", "Serveur"],
          ["domain", "Nom de domaine"],
          ["dns", "DNS"],
          ["repo", "Dépôt GitHub"],
          ["vhost", "Préparation du serveur"],
        ],
      },
    ];
    for (const r of releases) {
      history.push({
        kind: "deploy",
        env: "staging",
        release: r,
        at: ago(demo.daysAgo + (2 - r.version), 3),
        steps: [
          ["push", "Envoi sur GitHub (staging)"],
          ["deploy", "Déploiement en préproduction"],
          ["tls", "Certificat HTTPS"],
          ["screenshot", "Capture d'écran"],
        ],
      });
      if (demo.status === "live")
        history.push({
          kind: "promote",
          env: "production",
          release: r,
          at: ago(demo.daysAgo + (2 - r.version), 1),
          steps: [
            ["merge", "Fusion staging → production"],
            ["deploy", "Mise en ligne sur le domaine"],
            ["tls", "Certificat HTTPS"],
            ["screenshot", "Capture d'écran"],
          ],
        });
    }
    for (const h of history) {
      const d = await prisma.deployment.create({
        data: {
          siteId: site.id,
          kind: h.kind,
          environment: h.env,
          releaseId: h.release?.id,
          status: "succeeded",
          createdAt: h.at,
          startedAt: h.at,
          finishedAt: new Date(h.at.getTime() + 95_000),
          steps: h.steps.map(([key, label], i) => ({
            key,
            label,
            status: "done",
            startedAt: new Date(h.at.getTime() + i * 20_000).toISOString(),
            finishedAt: new Date(h.at.getTime() + (i + 1) * 20_000).toISOString(),
          })),
        },
      });
      const logs = [
        [
          "info",
          h.steps[0][0],
          `Démarrage : ${h.kind === "provision" ? "provisioning" : h.env === "staging" ? "préproduction" : "production"}`,
        ],
        ...h.steps.map(([key, label]) => ["success", key, `${label} : terminé`] as const),
        [
          "success",
          h.steps[h.steps.length - 1][0],
          h.kind === "promote" ? `${demo.domain} est en ligne.` : "Terminé",
        ],
      ] as const;
      let t = h.at.getTime();
      for (const [level, step, message] of logs) {
        t += 12_000;
        await prisma.deploymentLog.create({
          data: { deploymentId: d.id, level, step, message, ts: new Date(t) },
        });
      }
    }

    if (demo.status === "live") {
      const expires = ago(-(60 + demo.daysAgo));
      await prisma.sslCheck.create({
        data: {
          siteId: site.id,
          host: demo.domain,
          ok: true,
          issuer: "Let's Encrypt (R11)",
          expiresAt: expires,
          checkedAt: ago(0, 5),
        },
      });
      const messages = [
        {
          nom: "Claire Bernard",
          email: "claire.b@example.com",
          message: "Bonjour, êtes-vous ouverts le dimanche matin ? Merci.",
        },
        {
          nom: "Karim Haddad",
          email: "k.haddad@example.com",
          message: "Je souhaite un devis pour une prestation le mois prochain.",
        },
      ];
      for (const [i, m] of messages.entries()) {
        await prisma.formSubmission.create({
          data: {
            siteId: site.id,
            payload: m,
            fromIp: `82.64.10.${i + 1}`,
            emailedAt: ago(i + 1),
            createdAt: ago(i + 1),
          },
        });
      }
    }
  }
}

/** Removes everything flagged isDemo (sites cascade to releases, deployments, logs) and their files. */
export async function resetDemo(): Promise<void> {
  const sites = await prisma.site.findMany({
    where: { isDemo: true },
    include: { releases: true },
  });
  const { rm } = await import("node:fs/promises");
  for (const site of sites) {
    for (const r of site.releases) await rm(releaseDir(r.id), { recursive: true, force: true });
    if (site.screenshotPath)
      await rm(path.join(screenshotsDir(), site.screenshotPath), { force: true });
  }
  await prisma.site.deleteMany({ where: { isDemo: true } });
  await prisma.server.deleteMany({ where: { isDemo: true } });
  await seedDemo();
}
