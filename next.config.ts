import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Content-Security-Policy of the tool itself.
 *
 * Headers declared here are computed at build time: the Docker image is built
 * once for every installation, so PREVIEW_ORIGIN is usually unknown at this
 * point. The directive therefore ends with exactly `frame-src 'self'` when it
 * is absent, and the pilot's Caddy (infra/pilot/Caddyfile.pilot) appends the
 * preview origin to it at runtime. Keep that exact spelling.
 *
 * Next.js inlines bootstrap scripts, hence 'unsafe-inline' (a nonce would force
 * every page to render dynamically through src/proxy.ts). React needs
 * 'unsafe-eval' in development only.
 */
function contentSecurityPolicy(): string {
  const previewOrigin = process.env.PREVIEW_ORIGIN?.replace(/\/+$/, "");
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    `frame-src 'self'${previewOrigin ? ` ${previewOrigin}` : ""}`,
  ];
  return directives.join("; ");
}

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg-boss", "yauzl", "@prisma/client", "ssh2", "tar", "playwright-core"],
  // path.resolve(process.cwd(), DATA_DIR) makes Turbopack trace the whole
  // project into .next/standalone. None of these files is read at runtime; the
  // local .env and data/ must never end up in a build output.
  outputFileTracingExcludes: {
    "/*": [
      "./.env*",
      "./.claude/**",
      "./.git/**",
      "./.github/**",
      "./data/**",
      "./data-test/**",
      "./docs/**",
      "./e2e/**",
      "./infra/**",
      "./src/**",
      "./test-results/**",
      "./playwright-report/**",
      "./coverage/**",
    ],
  },
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
  // Defence in depth: Caddy sets the same headers in front of the app.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
      {
        // Release previews carry their own sandboxing CSP and, on the preview
        // origin (/apercu/*), are framed by the tool from another origin.
        source: "/((?!apercu/|api/preview/).*)",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy() },
        ],
      },
    ];
  },
};

export default nextConfig;
