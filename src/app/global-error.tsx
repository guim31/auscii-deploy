"use client";

/** Last-resort boundary, when the root layout itself fails: no app styles are available. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="fr">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", textAlign: "center" }}>
        <h1>Une erreur est survenue</h1>
        <p>
          L'application n'a pas pu s'afficher. Réessayez ; si le problème persiste, transmettez
          cette référence à l'agence{error.digest ? ` : ${error.digest}` : ""}.
        </p>
        <button type="button" onClick={reset}>
          Réessayer
        </button>
      </body>
    </html>
  );
}
