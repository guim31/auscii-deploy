import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { queueSubmissionMail } from "@/server/jobs/mail";
import { FORM_LIMITS, formRateLimited, parseFormBody, readRelay } from "@/server/forms";

export const dynamic = "force-dynamic";

/** Reads at most `max` bytes of the body; null when it is larger. */
async function readBounded(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Receives the contact forms of every site. The visitor posts to
 * /__forms/contact on the site itself (same origin, no CORS); the site server's
 * Caddy rewrites it to this route and signs it with the site's relay secret.
 * The email is sent by the worker (mail.send queue): an outage never loses a message.
 */
export async function POST(request: Request) {
  const relay = readRelay(request.headers);
  // Same answer whether the site exists or not: nothing to learn by probing.
  if (!relay) return NextResponse.json({ error: "Requête refusée" }, { status: 403 });

  const body = await readBounded(request, FORM_LIMITS.maxBodyBytes);
  if (body === null) return NextResponse.json({ error: "Message trop long" }, { status: 413 });
  let contentType = request.headers.get("content-type") ?? "";
  let text = body;
  if (contentType.startsWith("multipart/form-data")) {
    // Forms with enctype="multipart/form-data": keep the text fields, drop files.
    try {
      const form = await new Response(body, {
        headers: { "content-type": contentType },
      }).formData();
      const fields: Record<string, string> = {};
      for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
      text = JSON.stringify(fields);
      contentType = "application/json";
    } catch {
      return NextResponse.json({ error: "Message illisible" }, { status: 400 });
    }
  }
  const parsed = parseFormBody(text, contentType);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  const done = () =>
    parsed.redirect
      ? // Relative: the browser resolves it on the client's site, never on the pilot.
        new NextResponse(null, { status: 303, headers: { Location: parsed.redirect } })
      : NextResponse.json({ ok: true });

  if (parsed.honeypot) return done();
  if (formRateLimited(relay.slug, relay.clientIp))
    return NextResponse.json({ error: "Trop de messages, réessayez plus tard" }, { status: 429 });

  const site = await prisma.site.findUnique({ where: { slug: relay.slug } });
  if (!site || site.status === "draft")
    return NextResponse.json({ error: "Requête refusée" }, { status: 403 });
  if (!site.formsEmail)
    return NextResponse.json({ error: "Formulaire non configuré" }, { status: 404 });

  const submission = await prisma.formSubmission.create({
    data: { siteId: site.id, payload: parsed.fields, fromIp: relay.clientIp, env: relay.env },
  });
  try {
    await queueSubmissionMail(submission.id);
  } catch (err) {
    // The submission is stored; the site page offers to resend it.
    console.error("[forms] queue failed", err instanceof Error ? err.message : err);
  }
  return done();
}
