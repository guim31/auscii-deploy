import { requireAdmin } from "@/server/session";
import { prisma } from "@/server/db";
import { PageHeader } from "@/components/app/page-header";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatMoney } from "@/lib/format";

export const dynamic = "force-dynamic";

const LABELS: Record<string, string> = {
  "domain.purchase.confirm": "Achat de domaine confirmé",
  "domain.purchased": "Domaine acheté",
  "server.order": "Commande de serveur confirmée",
  "server.ordered": "Serveur commandé",
  "server.delete": "Suppression de serveur",
  "server.register": "Serveur existant ajouté",
  "server.retest": "Serveur revérifié",
  "site.publish": "Publication",
  "site.rollback": "Retour arrière",
  "site.deleteDraft": "Brouillon supprimé",
  "integration.save": "Intégration enregistrée",
  "integration.delete": "Intégration supprimée",
  "settings.save": "Paramètres enregistrés",
  "user.create": "Compte créé",
  "user.setRole": "Rôle modifié",
  "user.delete": "Compte supprimé",
  "user.resetPassword": "Mot de passe réinitialisé",
  "ssh.generateKeys": "Clés SSH générées",
  "ssh.importKey": "Clé SSH importée",
  "mail.sending_domain": "Domaine d'envoi configuré",
  "demo.reset": "Démo réinitialisée",
};

export default async function AuditPage() {
  await requireAdmin();
  const entries = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  // Actions run by the worker only carry the id of the admin who confirmed them.
  const ids = [...new Set(entries.filter((e) => !e.userEmail && e.userId).map((e) => e.userId!))];
  const users = new Map(
    (
      await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } })
    ).map((u) => [u.id, u.email]),
  );
  return (
    <>
      <PageHeader
        title="Journal des actions"
        description="Les 200 dernières actions sensibles : achats, commandes, publications, réglages."
      />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Cible</TableHead>
                <TableHead>Montant</TableHead>
                <TableHead>Par</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(e.createdAt)}</TableCell>
                  <TableCell>{LABELS[e.action] ?? e.action}</TableCell>
                  <TableCell className="max-w-64 truncate">{e.target ?? "—"}</TableCell>
                  <TableCell>
                    {e.amount != null ? formatMoney(e.amount, e.currency) : "—"}
                  </TableCell>
                  <TableCell>
                    {e.userEmail ?? (e.userId ? (users.get(e.userId) ?? "—") : "automatique")}
                  </TableCell>
                </TableRow>
              ))}
              {entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground text-center">
                    Aucune action enregistrée.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
