import tls from "node:tls";
import type { TlsCheck } from "../providers/types";

type NameField = string | string[] | undefined;
export type PeerCertificateLike = {
  issuer?: { O?: NameField; CN?: NameField };
  valid_to?: string;
  subject?: { CN?: NameField };
};

function first(v: NameField): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Turns a peer certificate into the TlsCheck stored for the dashboard. */
export function tlsCheckFromCertificate(
  host: string,
  cert: PeerCertificateLike,
  authorized: boolean,
  authError?: string,
): TlsCheck {
  if (!cert.valid_to) return { host, ok: false, error: "Aucun certificat présenté" };
  const expiresAt = new Date(cert.valid_to);
  const issuer =
    [first(cert.issuer?.O), first(cert.issuer?.CN)].filter(Boolean).join(" ") || undefined;
  if (!authorized)
    return { host, ok: false, issuer, expiresAt, error: authError ?? "Certificat non reconnu" };
  if (expiresAt.getTime() < Date.now())
    return { host, ok: false, issuer, expiresAt, error: "Certificat expiré" };
  return { host, ok: true, issuer, expiresAt };
}

export function describeTlsError(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case "ENOTFOUND":
      return "Le nom de domaine ne pointe vers aucune adresse (DNS non propagé ?)";
    case "ECONNREFUSED":
      return "Connexion refusée sur le port 443 (Caddy pas encore démarré ?)";
    case "ETIMEDOUT":
    case "TIMEOUT":
      return "Délai dépassé (pare-feu ou adresse IP incorrecte ?)";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "Le certificat ne correspond pas à ce nom de domaine";
    default:
      return err.message;
  }
}

/** Connects to host:443 with SNI and inspects the certificate. Never throws. */
export function checkTlsHost(host: string, timeoutMs = 10_000): Promise<TlsCheck> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: TlsCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        done({
          host,
          ok: false,
          error: describeTlsError({ code: "TIMEOUT" } as NodeJS.ErrnoException),
        }),
      timeoutMs,
    );
    const socket = tls.connect(
      { host, port: 443, servername: host, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        done(
          tlsCheckFromCertificate(
            host,
            cert,
            socket.authorized,
            socket.authorizationError?.toString(),
          ),
        );
      },
    );
    socket.on("error", (err: NodeJS.ErrnoException) =>
      done({ host, ok: false, error: describeTlsError(err) }),
    );
  });
}
