import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildPreviewUrl,
  htmlCharset,
  rewriteCss,
  rewriteHtml,
  servePreview,
  signPreviewToken,
  verifyPreviewToken,
} from "./preview";
import { releaseDir } from "./paths";

const P = "/apercu/tok";

describe("preview tokens", () => {
  it("signs and verifies a release id", () => {
    const token = signPreviewToken("rel123");
    const check = verifyPreviewToken(token);
    expect(check).toMatchObject({ ok: true, releaseId: "rel123" });
    if (check.ok) {
      const hours = (check.expiresAt.getTime() - Date.now()) / 3600_000;
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThanOrEqual(25);
    }
  });

  it("keeps the same URL within the hour", () => {
    const t = Date.UTC(2026, 8, 24, 10, 5);
    expect(signPreviewToken("rel123", t)).toBe(signPreviewToken("rel123", t + 50 * 60_000));
  });

  it("refuses tampered and expired tokens", () => {
    const token = signPreviewToken("rel123");
    const [id, exp, sig] = token.split(".");
    expect(verifyPreviewToken(`other.${exp}.${sig}`)).toEqual({ ok: false, reason: "invalid" });
    const later = (parseInt(exp, 36) + 3600).toString(36);
    expect(verifyPreviewToken(`${id}.${later}.${sig}`)).toEqual({ ok: false, reason: "invalid" });
    const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    expect(verifyPreviewToken(`${id}.${exp}.${flipped}`).ok).toBe(false);
    expect(verifyPreviewToken("garbage").ok).toBe(false);
    expect(verifyPreviewToken(token, Date.now() + 26 * 3600_000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("builds a same-origin URL when no preview host is configured", () => {
    expect(buildPreviewUrl("rel123")).toMatch(/^\/apercu\/rel123\.[0-9a-z]+\.[\w-]{43}\/$/);
  });
});

describe("root-relative URL rewriting", () => {
  it("rewrites URL attributes, srcset, meta refresh and inline styles", () => {
    const html = `<!doctype html><html><head>
<link rel="stylesheet" href="/style.css"><link rel=icon href=/favicon.ico>
<meta http-equiv="refresh" content="5; url=/merci.html">
<base href="/">
<style>@import "/print.css"; .hero{background:url('/img/hero.jpg')}</style>
</head><body style="background: url(/bg.png)">
<a href="/contact.html">Contact</a><a HREF='/a b.html'>x</a>
<img src="/logo.png" srcset="/logo.png 1x, /logo@2x.png 2x" alt="">
<form action="/__forms/contact" method="post"><button formaction="/autre">x</button></form>
<video poster="/p.jpg"><source src="/v.mp4"></video>
<a href="//cdn.example/x.css">cdn</a><a href="https://ex.com/">ext</a><a href="page.html">rel</a><a href="#top">top</a>
<script>document.body.innerHTML += '<img src="/from-js.png">'; if (a<b && c>d) {}</script>
<!-- <a href="/commented"> -->
</body></html>`;
    const out = rewriteHtml(html, P);
    for (const url of [
      "/style.css",
      "/favicon.ico",
      "/contact.html",
      "/a b.html",
      "/logo.png",
      "/logo@2x.png",
      "/__forms/contact",
      "/autre",
      "/p.jpg",
      "/v.mp4",
    ])
      expect(out).toContain(`${P}${url}`);
    expect(out).toContain(`href="${P}/"`);
    expect(out).toContain(`content="5; url=${P}/merci.html"`);
    expect(out).toContain(`@import "${P}/print.css"`);
    expect(out).toContain(`url('${P}/img/hero.jpg')`);
    expect(out).toContain(`url(${P}/bg.png)`);
    expect(out).toContain(`srcset="${P}/logo.png 1x, ${P}/logo@2x.png 2x"`);
    expect(out).toContain('href="//cdn.example/x.css"');
    expect(out).toContain('href="https://ex.com/"');
    expect(out).toContain('href="page.html"');
    expect(out).toContain('href="#top"');
    expect(out).toContain(`'<img src="/from-js.png">'`);
    expect(out).toContain('<a href="/commented">');
    // Idempotent: already prefixed URLs are left alone.
    expect(rewriteHtml(out, P)).toBe(out);
  });

  it("rewrites stylesheets", () => {
    const css = `@import url("/fonts.css");@import '/b.css';.a{background:url(/a.png)}.b{background:url( "//cdn/x.png" )}.c{src:url(font.woff2)}`;
    expect(rewriteCss(css, P)).toBe(
      `@import url("${P}/fonts.css");@import '${P}/b.css';.a{background:url(${P}/a.png)}.b{background:url( "//cdn/x.png" )}.c{src:url(font.woff2)}`,
    );
  });

  it("reads the declared charset", () => {
    expect(htmlCharset('<meta charset="ISO-8859-1">')).toBe("iso-8859-1");
    expect(htmlCharset("<p>rien</p>")).toBe("utf-8");
  });
});

describe("servePreview", () => {
  const releaseId = "previewtest";
  const root = () => releaseDir(releaseId);

  beforeAll(async () => {
    await rm(root(), { recursive: true, force: true });
    const files: Record<string, string | Buffer> = {
      "index.html": '<link rel="stylesheet" href="/style.css"><h1>Accueil</h1>',
      "style.css": "body{background:url(/img/bg.png)}",
      "blog/index.html": "<p>Blog</p>",
      "404.html": '<a href="/">Retour</a>',
      ".env": "SECRET=1",
      "video.mp4": Buffer.from("0123456789"),
      "latin.html": Buffer.from('<meta charset="iso-8859-1"><p>Qualité</p>', "latin1"),
    };
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root(), rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  });
  afterAll(async () => {
    await rm(root(), { recursive: true, force: true });
  });

  const token = () => signPreviewToken(releaseId);
  const get = (segments: string[], init: RequestInit = {}, url?: string) =>
    servePreview(
      new Request(url ?? `http://localhost:3000/apercu/${token()}/${segments.join("/")}`, init),
      token(),
      segments,
    );

  it("serves pages with rewritten URLs and a sandbox CSP", async () => {
    const res = await get(["index.html"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts allow-forms allow-popups allow-modals");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("frame-ancestors 'self' http://localhost:3000");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain(`href="/apercu/${token()}/style.css"`);

    const css = await get(["style.css"]);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain(`url(/apercu/${token()}/img/bg.png)`);
  });

  it("redirects folders to their index so relative links resolve", async () => {
    const rootRes = await get([], {}, `http://localhost:3000/apercu/${token()}`);
    expect(rootRes.status).toBe(302);
    expect(rootRes.headers.get("location")).toBe(`${token()}/index.html`);
    const blog = await get(["blog"]);
    expect(blog.status).toBe(302);
    expect(blog.headers.get("location")).toBe("blog/index.html");
    const withSlash = await get(["blog"], {}, `http://localhost:3000/apercu/${token()}/blog/`);
    expect(withSlash.status).toBe(200);
  });

  it("answers 404 with the site's page, and never serves hidden files", async () => {
    const res = await get(["nope.html"]);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(`href="/apercu/${token()}/"`);
    expect((await get([".env"])).status).toBe(404);
    expect((await get(["..", "..", "etc", "passwd"])).status).toBe(404);
  });

  it("keeps the page encoding", async () => {
    const res = await get(["latin.html"]);
    expect(res.headers.get("content-type")).toBe("text/html; charset=iso-8859-1");
    expect(Buffer.from(await res.arrayBuffer()).toString("latin1")).toContain("Qualité");
  });

  it("supports ranges and revalidation", async () => {
    const res = await get(["video.mp4"], { headers: { range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
    const full = await get(["video.mp4"]);
    const etag = full.headers.get("etag") ?? "";
    expect((await get(["video.mp4"], { headers: { "if-none-match": etag } })).status).toBe(304);
  });

  it("refuses expired tokens and answers form posts without sending anything", async () => {
    const expired = signPreviewToken(releaseId, Date.now() - 48 * 3600_000);
    const res = await servePreview(new Request("http://localhost:3000/x"), expired, []);
    expect(res.status).toBe(410);
    const post = await get(["__forms", "contact"], { method: "POST", body: "email=a" });
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("aucun message n'est envoyé");
  });

  it("only answers on the preview host when one is configured", async () => {
    vi.resetModules();
    process.env.PREVIEW_ORIGIN = "https://apercu.example-preview.site";
    try {
      const fresh = await import("./preview");
      const t = fresh.signPreviewToken(releaseId);
      expect(fresh.buildPreviewUrl(releaseId)).toBe(
        `https://apercu.example-preview.site/apercu/${t}/`,
      );
      const onTool = await fresh.servePreview(
        new Request(`http://localhost:3000/apercu/${t}/index.html`, {
          headers: { host: "localhost:3000" },
        }),
        t,
        ["index.html"],
      );
      expect(onTool.status).toBe(404);
      const onPreview = await fresh.servePreview(
        new Request(`https://apercu.example-preview.site/apercu/${t}/index.html`, {
          headers: { host: "apercu.example-preview.site" },
        }),
        t,
        ["index.html"],
      );
      expect(onPreview.status).toBe(200);
    } finally {
      delete process.env.PREVIEW_ORIGIN;
      vi.resetModules();
    }
  });
});
