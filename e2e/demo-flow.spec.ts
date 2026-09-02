import { expect, test, type Page } from "@playwright/test";
import { createWriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import yazl from "yazl";

const EMAIL = process.env.ADMIN_EMAIL ?? "admin@auscii.com";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "admin1234";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Mot de passe").fill(PASSWORD);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function makeZip(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "auscii-e2e-"));
  const file = path.join(dir, "site.zip");
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from(
      `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fleuriste Rose</title><meta name="description" content="Fleurs fraîches"></head><body><h1>Fleuriste Rose</h1><p>Bouquets et compositions à Albi. Contactez-nous.</p><a href="contact.html">Contact</a></body></html>`,
    ),
    "fleuriste/index.html",
  );
  zip.addBuffer(
    Buffer.from(
      `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Contact</title></head><body><form action="/__forms/contact" method="post"><input name="email"><button>Envoyer</button></form></body></html>`,
    ),
    "fleuriste/contact.html",
  );
  zip.end();
  await new Promise<void>((resolve, reject) =>
    zip.outputStream.pipe(createWriteStream(file)).on("close", resolve).on("error", reject),
  );
  return file;
}

test.describe.configure({ mode: "serial" });

test("login shows the dashboard with demo sites", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Sites en production" })).toBeVisible();
  await expect(page.getByText("Mode démo")).toBeVisible();
  await expect(page.getByText("Boulangerie Dupont")).toBeVisible();
  await page.getByRole("button", { name: "Voir" }).first().click();
  await expect(page.getByTitle(/Aperçu de/)).toBeVisible();
});

test("full wizard: domain, provisioning, upload, staging, production", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  await page.getByRole("link", { name: "Déployer un nouveau site" }).first().click();
  await page.getByLabel("Nom du client").fill("Fleuriste Rose");
  await page.getByRole("button", { name: "Commencer" }).click();
  await expect(page).toHaveURL(/step-1/);

  // The demo registrar marks about one name in ten as taken: try a few candidates.
  let domain = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    domain = `fleuriste-rose-${Date.now().toString(36)}${attempt}.fr`;
    await page.getByLabel("Nom de domaine souhaité").fill(domain);
    await page.getByRole("button", { name: "Vérifier" }).click();
    const check = page.getByTestId("domain-check");
    await expect(check).toContainText(domain);
    if ((await check.textContent())?.includes("est disponible")) break;
  }
  await expect(page.getByTestId("domain-check")).toContainText("est disponible");
  await page.getByLabel("Email de réception du formulaire de contact").fill("rose@example.com");
  await page.getByTestId("confirm-purchase").check();
  const serverConfirm = page.getByText("Je confirme la commande de ce serveur");
  if (await serverConfirm.isVisible().catch(() => false)) await serverConfirm.click();
  await page.getByTestId("start-provisioning").click();

  await expect(page).toHaveURL(/step-2/);
  await expect(page.getByTestId("deploy-console")).toContainText("Infrastructure prête", {
    timeout: 120_000,
  });
  await page.getByTestId("go-step-3").click();

  await expect(page).toHaveURL(/step-3/);
  const zip = await makeZip();
  await page.getByTestId("zip-input").setInputFiles(zip);
  await expect(page.getByText("Archive valide")).toBeVisible();
  await expect(page.getByTestId("preview-frame")).toBeVisible();
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.getByRole("heading", { name: "Fleuriste Rose" })).toBeVisible();
  await expect(page.getByTestId("analysis-issues")).toContainText(
    "formulaire(s) de contact prêt(s)",
  );
  await expect(
    page
      .getByText("Le site est prêt pour la préproduction", { exact: false })
      .or(page.getByText("Le site peut partir en préproduction", { exact: false })),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("go-step-4").click();

  await expect(page).toHaveURL(/step-4/);
  await page.getByTestId("deploy-staging").click();
  await expect(page.getByTestId("staging-ready")).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("publish").click();
  await page.getByTestId("confirm-publish").click();
  await expect(page.getByTestId("back-dashboard")).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("back-dashboard").click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(domain, { exact: true })).toBeVisible();
});

test("site page lists versions and messages", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Boulangerie Dupont" }).click();
  await expect(page.getByRole("heading", { name: "Boulangerie Dupont" })).toBeVisible();
  await expect(page.getByText("Historique des déploiements")).toBeVisible();
  await expect(page.getByText("Claire Bernard")).toBeVisible();
  await expect(page.getByTestId("rollback-1")).toBeVisible();
});

test("settings pages are reachable for the admin", async ({ page }) => {
  await login(page);
  await page.goto("/settings/servers");
  await expect(page.getByText("demo-01")).toBeVisible();
  await page.goto("/settings/integrations");
  await expect(page.getByText("Gandi")).toBeVisible();
  await page.goto("/settings/agency");
  await expect(page.getByLabel("Domaine technique")).toHaveValue(/auscii/);
  await page.goto("/settings/users");
  await expect(page.getByText(EMAIL)).toBeVisible();
});

test("SSH keys and manual server registration (demo)", async ({ page }) => {
  await login(page);
  await page.goto("/settings/integrations");
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("generate-ssh-keys").click();
  await expect(page.getByText("Clé prête")).toBeVisible();
  await expect(page.getByText(/^ssh-ed25519 /)).toBeVisible();

  await page.goto("/settings/servers");
  await page.getByTestId("add-server").click();
  await expect(page.getByText("PILOT_KEY='ssh-ed25519")).toBeVisible();
  const name = `manuel-${Date.now().toString(36)}`;
  await page.getByLabel("Nom", { exact: true }).fill(name);
  await page.getByLabel("Adresse IP").fill("203.0.113.10");
  await page.getByTestId("add-server-submit").click();
  await expect(page.getByText(name)).toBeVisible();
  await expect(page.locator("div", { hasText: name }).getByText("Prêt").first()).toBeVisible({
    timeout: 30_000,
  });
});
