"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2Icon,
  Loader2Icon,
  SearchIcon,
  ServerIcon,
  XCircleIcon,
  AlertTriangleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { checkDomainAction, submitStep1Action } from "@/server/actions/sites";
import type { DomainAvailability } from "@/server/providers/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatEuro } from "@/lib/format";
import { normalizeFqdn } from "@/lib/slug";

export type PlacementView =
  | { kind: "existing"; serverName: string; sitesCount: number; status: string }
  | { kind: "new-server"; offerId: string; offerPrice: number | null; reasons: string[] };

export function DomainStep({
  siteId,
  initial,
  placement,
  isAdmin,
}: {
  siteId: string;
  initial: {
    clientName: string;
    fqdn: string;
    owned: boolean;
    formsEmail: string;
    price: number | null;
    currency: string | null;
  };
  placement: PlacementView;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [clientName, setClientName] = useState(initial.clientName);
  const [fqdn, setFqdn] = useState(initial.fqdn);
  const [owned, setOwned] = useState(initial.owned);
  const [formsEmail, setFormsEmail] = useState(initial.formsEmail);
  const [check, setCheck] = useState<DomainAvailability | null>(
    initial.fqdn && initial.price
      ? {
          fqdn: initial.fqdn,
          available: true,
          price: initial.price,
          currency: initial.currency ?? "EUR",
        }
      : null,
  );
  const [suggestions, setSuggestions] = useState<DomainAvailability[]>([]);
  const [checking, startCheck] = useTransition();
  const [submitting, startSubmit] = useTransition();
  const [confirmPurchase, setConfirmPurchase] = useState(false);
  const [confirmServer, setConfirmServer] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = normalizeFqdn(fqdn);
  const checked = check?.fqdn === normalized ? check : null;
  const needsPurchase = !owned;
  const canSubmit =
    clientName.trim().length >= 2 &&
    normalized.length > 3 &&
    (owned || (checked?.available ?? false));

  function runCheck(value = fqdn) {
    setError(null);
    startCheck(async () => {
      const res = await checkDomainAction(value);
      if (!res.ok) {
        setError(res.error);
        setCheck(null);
        return;
      }
      setFqdn(res.result.fqdn);
      setCheck(res.result);
      setSuggestions(res.suggestions);
    });
  }

  function submit() {
    setError(null);
    startSubmit(async () => {
      const res = await submitStep1Action(siteId, {
        clientName,
        fqdn: normalized,
        owned,
        formsEmail,
        price: owned ? null : (checked?.price ?? null),
        currency: owned ? null : (checked?.currency ?? null),
        confirmPurchase,
        confirmServerOrder: confirmServer,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success("Provisioning lancé");
      router.push(`/deploy/${siteId}/step-2`);
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardHeader>
          <CardTitle>Domaine et coordonnées</CardTitle>
          <CardDescription>
            Le domaine est vérifié en direct chez Gandi. L'adresse email recevra les messages du
            formulaire de contact.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="clientName">Nom du client</Label>
            <Input
              id="clientName"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="fqdn">Nom de domaine souhaité</Label>
            <div className="flex gap-2">
              <Input
                id="fqdn"
                placeholder="boulangerie-dupont.fr"
                value={fqdn}
                onChange={(e) => setFqdn(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runCheck();
                  }
                }}
                disabled={owned}
              />
              {!owned && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => runCheck()}
                  disabled={checking || normalized.length < 4}
                >
                  {checking ? <Loader2Icon className="animate-spin" /> : <SearchIcon />} Vérifier
                </Button>
              )}
            </div>
            {!owned && checked && (
              <div
                className={`flex items-center gap-2 text-sm ${checked.available ? "text-success" : "text-destructive"}`}
                data-testid="domain-check"
              >
                {checked.available ? (
                  <CheckCircle2Icon className="size-4" />
                ) : (
                  <XCircleIcon className="size-4" />
                )}
                {checked.available ? (
                  <>
                    {checked.fqdn} est disponible · {formatEuro(checked.price)} la première année
                  </>
                ) : (
                  <>
                    {checked.fqdn} n'est pas disponible
                    {checked.reason ? ` (${checked.reason.toLowerCase()})` : ""}
                  </>
                )}
              </div>
            )}
            {!owned && suggestions.length > 0 && (
              <div className="flex flex-wrap gap-2 text-xs">
                {suggestions.map((s) => (
                  <button
                    key={s.fqdn}
                    type="button"
                    disabled={!s.available}
                    onClick={() => {
                      setFqdn(s.fqdn);
                      setCheck(s);
                    }}
                    className="hover:bg-accent rounded-full border px-2.5 py-1 disabled:opacity-40"
                  >
                    {s.fqdn} {s.available ? `· ${formatEuro(s.price)}` : "· pris"}
                  </button>
                ))}
              </div>
            )}
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={owned}
                onChange={(e) => setOwned(e.target.checked)}
                className="size-4"
              />
              Ce domaine est déjà dans le compte Gandi de l'agence (pas d'achat, DNS seulement)
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="formsEmail">Email de réception du formulaire de contact</Label>
            <Input
              id="formsEmail"
              type="email"
              placeholder="contact@client.fr"
              value={formsEmail}
              onChange={(e) => setFormsEmail(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Facultatif. Les messages envoyés depuis le site arrivent à cette adresse et restent
              visibles dans l'outil.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ServerIcon className="size-4" /> Serveur
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {placement.kind === "existing" ? (
              <p>
                Le site sera hébergé sur <strong>{placement.serverName}</strong> (
                {placement.sitesCount} site{placement.sitesCount > 1 ? "s" : ""} déjà en place).
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <p>
                  Aucun serveur n'a de place disponible. Un nouveau serveur{" "}
                  <strong>{placement.offerId}</strong> sera commandé
                  {placement.offerPrice !== null && (
                    <>
                      {" "}
                      pour environ <strong>{formatEuro(placement.offerPrice)}/mois</strong>
                    </>
                  )}
                  .
                </p>
                {placement.reasons.length > 0 && (
                  <p className="text-muted-foreground text-xs">{placement.reasons.join(" · ")}</p>
                )}
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={confirmServer}
                    onChange={(e) => setConfirmServer(e.target.checked)}
                    disabled={!isAdmin}
                  />
                  <span>
                    Je confirme la commande de ce serveur
                    {!isAdmin && (
                      <span className="text-muted-foreground block text-xs">
                        Réservé aux administrateurs
                      </span>
                    )}
                  </span>
                </label>
              </div>
            )}
          </CardContent>
        </Card>

        {needsPurchase && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Achat du domaine</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              {checked?.available ? (
                <>
                  <p>
                    <strong>{checked.fqdn}</strong> sera acheté chez Gandi pour{" "}
                    <strong>{formatEuro(checked.price)}</strong> (première année, renouvellement
                    annuel).
                  </p>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4"
                      checked={confirmPurchase}
                      onChange={(e) => setConfirmPurchase(e.target.checked)}
                      disabled={!isAdmin}
                      data-testid="confirm-purchase"
                    />
                    <span>
                      Je confirme cet achat
                      {!isAdmin && (
                        <span className="text-muted-foreground block text-xs">
                          Réservé aux administrateurs
                        </span>
                      )}
                    </span>
                  </label>
                </>
              ) : (
                <p className="text-muted-foreground">
                  Vérifiez la disponibilité du domaine pour afficher le prix.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>Impossible de continuer</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button
          size="lg"
          onClick={submit}
          disabled={!canSubmit || submitting}
          data-testid="start-provisioning"
        >
          {submitting && <Loader2Icon className="animate-spin" />}
          Lancer le provisioning
        </Button>
      </div>
    </div>
  );
}
