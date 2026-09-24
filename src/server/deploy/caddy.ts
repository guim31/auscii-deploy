import { RELAY_HEADERS, relaySecretFor } from "./relay";

/**
 * Caddy site blocks written to /etc/caddy/sites/<dir>.caddy on the site servers.
 *
 * Everything interpolated here ends up in a Caddyfile shared by all the sites
 * of the server: the inputs are validated again (defense in depth) so a bad
 * value can never inject directives into the configuration.
 */
export type CaddySiteInput = {
  /** Slug of the site (never suffixed): sent to the pilot in X-Site and used for the relay secret. */
  siteSlug: string;
  /**
   * Folder under /srv/sites. Defaults to the site slug for production and to
   * "<siteSlug>--preview" for the preproduction block.
   */
  dir?: string;
  hosts: string[];
  pilotHost: string;
  previewToken?: string;
};

const PREVIEW_COOKIE = "auscii_preview";
/** Largest form submission relayed to the pilot. */
export const FORMS_MAX_BODY = "64KB";
/** Path the pilot serves the forms relay on (the sites post to /__forms/*). */
export const PILOT_FORMS_PATH = "/api/forms";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIR_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function assertSiteSlug(slug: string): string {
  if (slug.length > 60 || !SLUG_RE.test(slug))
    throw new Error(`Identifiant de site invalide : ${JSON.stringify(slug)}`);
  return slug;
}

export function assertHostname(host: string): string {
  if (!HOST_RE.test(host)) throw new Error(`Nom d'hôte invalide : ${JSON.stringify(host)}`);
  return host;
}

export function assertPreviewToken(token: string): string {
  if (!TOKEN_RE.test(token)) throw new Error("Jeton de préproduction invalide");
  return token;
}

function checkedInput(input: CaddySiteInput, environment: "production" | "preview") {
  const siteSlug = assertSiteSlug(input.siteSlug);
  const dir = input.dir ?? (environment === "production" ? siteSlug : `${siteSlug}--preview`);
  if (!DIR_RE.test(dir) || (dir !== siteSlug && dir !== `${siteSlug}--preview`))
    throw new Error(`Dossier de site invalide : ${JSON.stringify(dir)}`);
  if (input.hosts.length === 0) throw new Error("Aucun nom d'hôte pour ce site");
  const hosts = input.hosts.map(assertHostname);
  const pilotHost = assertHostname(input.pilotHost);
  return { siteSlug, dir, hosts, pilotHost };
}

/**
 * Shared response headers. The header block deletes a field, so Caddy defers
 * it to write time: it applies to every response of the site, redirects included.
 */
function securityHeaders(extra: string[] = []): string {
  return [
    "\theader {",
    "\t\t-Server",
    "\t\tX-Content-Type-Options nosniff",
    "\t\tReferrer-Policy strict-origin-when-cross-origin",
    ...extra.map((l) => `\t\t${l}`),
    "\t}",
  ].join("\n");
}

/**
 * Hidden files (.env, .git/, .claude/…) are answered with a 404, except the
 * standard /.well-known/ folder (whose own hidden files stay hidden).
 * The `error` directive must sit in the same handle as file_server: at the
 * top level Caddy would sort it after the handle blocks.
 */
const HIDDEN_MATCHERS = `\t@dotfiles {
\t\tpath */.*
\t\tnot path /.well-known/*
\t}
\t@wellKnownDotfiles path_regexp \`(?i)^/\\.well-known/(?:.*/)?\\.\``;

function staticFiles(indent: string): string {
  return [
    "handle {",
    "\terror @dotfiles 404",
    "\terror @wellKnownDotfiles 404",
    "\ttry_files {path} {path}/index.html {path}.html",
    "\tfile_server",
    "}",
  ]
    .map((l) => indent + l)
    .join("\n");
}

/**
 * Relay of the contact forms to the pilot: bounded body, client-sent relay
 * headers stripped, per-site secret, the real site slug (never the folder).
 * The pilot only serves /api/forms, hence the rewrite. The pilot must answer
 * with a relative Location: Caddy passes it through unchanged.
 */
function formsRelay(
  indent: string,
  { siteSlug, pilotHost, preview }: { siteSlug: string; pilotHost: string; preview: boolean },
): string {
  const lines = [
    "handle /__forms/* {",
    "\trequest_body {",
    `\t\tmax_size ${FORMS_MAX_BODY}`,
    "\t}",
    "\trequest_header -X-Auscii-*",
    `\trequest_header -${RELAY_HEADERS.site}`,
    `\trequest_header -${RELAY_HEADERS.env}`,
    // The visitor's cookies (preview token included) are none of the pilot's business.
    "\trequest_header -Cookie",
    "\trequest_header -Authorization",
    `\trewrite * ${PILOT_FORMS_PATH}`,
    `\treverse_proxy https://${pilotHost} {`,
    `\t\theader_up Host ${pilotHost}`,
    `\t\theader_up ${RELAY_HEADERS.site} ${siteSlug}`,
    `\t\theader_up ${RELAY_HEADERS.secret} ${relaySecretFor(siteSlug)}`,
    `\t\theader_up ${RELAY_HEADERS.clientIp} {remote_host}`,
    `\t\theader_up ${RELAY_HEADERS.siteHost} {host}`,
    ...(preview ? [`\t\theader_up ${RELAY_HEADERS.env} preview`] : []),
    "\t}",
    "}",
  ];
  return lines.map((l) => indent + l).join("\n");
}

function notFoundPage(dir: string, extraHeaders: string[] = []): string {
  return `\thandle_errors {
\t\t@notfound expression {http.error.status_code} == 404
\t\thandle @notfound {
${securityHeaders(extraHeaders)
  .split("\n")
  .map((l) => `\t\t${l}`)
  .join("\n")}
\t\t\troot * /srv/sites/${dir}/current
\t\t\trewrite * /404.html
\t\t\tfile_server
\t\t}
\t}`;
}

export function productionCaddyBlock(input: CaddySiteInput): string {
  const { siteSlug, dir, hosts, pilotHost } = checkedInput(input, "production");
  return `${hosts.join(", ")} {
\troot * /srv/sites/${dir}/current
\tencode zstd gzip
${securityHeaders()}
${HIDDEN_MATCHERS}
${formsRelay("\t", { siteSlug, pilotHost, preview: false })}
${staticFiles("\t")}
${notFoundPage(dir)}
}
`;
}

/** Same as production, behind a cookie gate: /__preview/<token> sets the cookie, otherwise "Accès réservé". */
export function previewCaddyBlock(input: CaddySiteInput): string {
  if (!input.previewToken) throw new Error("previewToken is required for a preview block");
  const token = assertPreviewToken(input.previewToken);
  const { siteSlug, dir, hosts, pilotHost } = checkedInput(input, "preview");
  const robots = ['X-Robots-Tag "noindex, nofollow"'];
  return `${hosts.join(", ")} {
\troot * /srv/sites/${dir}/current
\tencode zstd gzip
${securityHeaders(robots)}
${HIDDEN_MATCHERS}
\t@enter path /__preview/${token}
\thandle @enter {
\t\theader Set-Cookie "${PREVIEW_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000"
\t\tredir * / 302
\t}
\t@authorized header_regexp Cookie \`(?:^|;\\s*)${PREVIEW_COOKIE}=${token}(?:;|$)\`
\thandle @authorized {
${formsRelay("\t\t", { siteSlug, pilotHost, preview: true })}
${staticFiles("\t\t")}
\t}
\thandle {
\t\trespond "Accès réservé. Utilisez le lien de prévisualisation transmis par AUSCII." 403
\t}
${notFoundPage(dir, robots)}
}
`;
}
