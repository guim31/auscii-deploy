import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { getProviders } from "@/server/providers";

export const dynamic = "force-dynamic";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) return true;
  list.push(now);
  hits.set(key, list);
  return false;
}

/**
 * Receives contact form submissions relayed by Caddy from every site
 * (/__forms/contact → this route with an X-Site header). Same-origin from the
 * visitor's point of view, so no CORS is involved.
 */
export async function POST(request: Request) {
  const slug = request.headers.get("x-site");
  if (!slug) return NextResponse.json({ error: "Site inconnu" }, { status: 400 });
  const site = await prisma.site.findUnique({ where: { slug } });
  if (!site || !site.formsEmail)
    return NextResponse.json({ error: "Formulaire non configuré" }, { status: 404 });

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(`${slug}:${ip}`))
    return NextResponse.json({ error: "Trop de messages, réessayez plus tard" }, { status: 429 });

  const contentType = request.headers.get("content-type") ?? "";
  let fields: Record<string, string> = {};
  if (contentType.includes("application/json")) {
    fields = (await request.json()) as Record<string, string>;
  } else {
    const form = await request.formData();
    for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
  }
  if (fields._gotcha || fields.website) return NextResponse.json({ ok: true }); // honeypot
  const clean = Object.fromEntries(
    Object.entries(fields)
      .filter(([k]) => !k.startsWith("_"))
      .map(([k, v]) => [k.slice(0, 64), String(v).slice(0, 5000)]),
  );
  if (Object.keys(clean).length === 0)
    return NextResponse.json({ error: "Message vide" }, { status: 400 });

  const submission = await prisma.formSubmission.create({
    data: { siteId: site.id, payload: clean, fromIp: ip },
  });
  const providers = await getProviders();
  try {
    const text = Object.entries(clean)
      .map(([k, v]) => `${k} : ${v}`)
      .join("\n");
    await providers.mail.send({
      to: site.formsEmail,
      subject: `[${site.clientName}] Nouveau message depuis le site`,
      text: `${text}\n\n— Envoyé depuis ${site.domain ?? site.slug} via auscii-deploy`,
      replyTo: clean.email,
    });
    await prisma.formSubmission.update({
      where: { id: submission.id },
      data: { emailedAt: new Date() },
    });
  } catch (err) {
    console.error("[forms] mail failed", err);
  }

  const redirect = fields._redirect;
  if (redirect && /^\/[^/]/.test(redirect)) {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
    return NextResponse.redirect(`https://${host}${redirect}`, 303);
  }
  return NextResponse.json({ ok: true });
}
