import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-12 text-center">
      <h1 className="text-2xl font-semibold">Page introuvable</h1>
      <p className="text-muted-foreground">Cette page n'existe pas ou a été déplacée.</p>
      <Button asChild>
        <Link href="/">Retour au tableau de bord</Link>
      </Button>
    </main>
  );
}
