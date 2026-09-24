"use client";

import { Button } from "@/components/ui/button";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-12 text-center">
      <h1 className="text-2xl font-semibold">Une erreur est survenue</h1>
      <p className="text-muted-foreground max-w-md text-sm">
        L'opération n'a pas pu aboutir. Réessayez ; si le problème persiste, transmettez cette
        référence à l'agence
        {error.digest ? ` : ${error.digest}` : ""}.
      </p>
      <Button onClick={reset}>Réessayer</Button>
    </main>
  );
}
