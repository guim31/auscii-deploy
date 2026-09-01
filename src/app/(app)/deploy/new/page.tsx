import type { Metadata } from "next";
import { createSiteAction } from "@/server/actions/sites";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const metadata: Metadata = { title: "Nouveau site" };

export default async function NewSitePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <div className="mx-auto max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>Déployer un nouveau site</CardTitle>
          <CardDescription>
            Commencez par le nom du client. Il servira d'identifiant pour le dépôt GitHub et
            l'adresse de préproduction.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={createSiteAction} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="clientName">Nom du client</Label>
              <Input
                id="clientName"
                name="clientName"
                placeholder="Boulangerie Dupont"
                required
                minLength={2}
                autoFocus
              />
              {error === "nom" && (
                <p className="text-destructive text-sm">Indiquez un nom d'au moins 2 caractères.</p>
              )}
            </div>
            <Button type="submit" size="lg">
              Commencer
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
