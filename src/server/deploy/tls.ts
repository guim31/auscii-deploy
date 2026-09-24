import tls from "node:tls";
import type { ServerAgent, TlsCheck } from "../providers/types";

type NameField = string | string[] | undefined;
export type PeerCertificateLike = {
  issuer?: { O?: NameField; CN?: NameField };
  valid_to?: string;
  subject?: { CN?: NameField };
};

function first(v: NameField): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const PENDING = "le certificat est peut-être encore en cours d'émission";

/** French explanation of the error codes of Node's TLS and network stack. */
const MESSAGES: Record<string, string> = {
  // Network
  ENOTFOUND: "Le nom de domaine ne pointe vers aucune adresse (DNS non propagé ?)",
  EAI_AGAIN: "Résolution DNS momentanément impossible, nouvel essai plus tard",
  ECONNREFUSED: "Connexion refusée sur le port 443 (Caddy pas encore démarré ?)",
  ECONNRESET: "Connexion coupée par le serveur pendant la négociation HTTPS",
  EHOSTUNREACH: "Serveur injoignable (adresse IP incorrecte ou serveur arrêté ?)",
  ENETUNREACH: "Serveur injoignable (adresse IP incorrecte ou serveur arrêté ?)",
  ETIMEDOUT: "Délai dépassé (pare-feu ou adresse IP incorrecte ?)",
  TIMEOUT: "Délai dépassé (pare-feu ou adresse IP incorrecte ?)",
  // Certificate
  CERT_HAS_EXPIRED: "Certificat expiré",
  CERT_NOT_YET_VALID: "Certificat pas encore valide (horloge du serveur décalée ?)",
  CERT_REVOKED: "Certificat révoqué",
  ERR_TLS_CERT_ALTNAME_INVALID: `Le certificat ne correspond pas à ce nom de domaine : ${PENDING}`,
  HOSTNAME_MISMATCH: `Le certificat ne correspond pas à ce nom de domaine : ${PENDING}`,
  DEPTH_ZERO_SELF_SIGNED_CERT: `Certificat provisoire auto-signé : ${PENDING}`,
  SELF_SIGNED_CERT_IN_CHAIN: `Certificat auto-signé dans la chaîne : ${PENDING}`,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    "Certificat émis par une autorité non reconnue (chaîne incomplète ?)",
  UNABLE_TO_GET_ISSUER_CERT: "Certificat émis par une autorité non reconnue (chaîne incomplète ?)",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
    "Certificat émis par une autorité non reconnue (chaîne incomplète ?)",
  // TLS handshake: Caddy answers with an alert while it has no certificate for the name yet.
  ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR: `Le serveur n'a pas encore de certificat pour ce nom : ${PENDING}`,
  ERR_SSL_TLSV1_UNRECOGNIZED_NAME: `Le serveur ne connaît pas ce nom de domaine : ${PENDING}`,
  EPROTO: "Échec de la négociation HTTPS (certificat absent ou protocole refusé)",
};

/** Translates a TLS or network error code; unknown codes keep the original message. */
export function describeTlsCode(code: string | undefined, fallback?: string): string {
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (code?.startsWith("ERR_SSL_"))
    return `Échec de la négociation HTTPS (${code.slice(8).toLowerCase().replace(/_/g, " ")})`;
  return fallback || code || "Erreur inconnue";
}

export function describeTlsError(err: NodeJS.ErrnoException): string {
  return describeTlsCode(err.code, err.message);
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
    return {
      host,
      ok: false,
      issuer,
      expiresAt,
      error: authError ? describeTlsCode(authError, authError) : "Certificat non reconnu",
    };
  if (expiresAt.getTime() < Date.now())
    return { host, ok: false, issuer, expiresAt, error: "Certificat expiré" };
  return { host, ok: true, issuer, expiresAt };
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
      () => done({ host, ok: false, error: describeTlsCode("TIMEOUT") }),
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

/**
 * Checks a host several times until its certificate is valid. Right after a
 * Caddy reload the certificate is usually still being issued (ACME takes a
 * few seconds to a minute): a single check would report a false failure.
 * Returns the last result; never throws.
 */
export async function checkTlsWithRetry(
  agent: Pick<ServerAgent, "checkTls">,
  host: string,
  {
    attempts = 6,
    delayMs = 15_000,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    onRetry,
  }: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Called before each new attempt, e.g. to log "certificat en cours d'émission". */
    onRetry?: (attempt: number, last: TlsCheck) => void | Promise<void>;
  } = {},
): Promise<TlsCheck> {
  let last: TlsCheck = { host, ok: false, error: "Contrôle non effectué" };
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      last = await agent.checkTls(host);
    } catch (err) {
      last = { host, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (last.ok || attempt >= attempts) return last;
    await onRetry?.(attempt, last);
    await sleep(delayMs);
  }
  return last;
}
