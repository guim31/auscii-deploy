import { GlobeIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ExpectedRecord } from "@/server/deploy/dns";

/** Shown while the DNS records of a site are not managed automatically. */
export function DnsRecordsCard({ records }: { records: ExpectedRecord[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GlobeIcon className="size-4" /> DNS à créer manuellement
        </CardTitle>
        <CardDescription>
          Gandi n'est pas encore configuré : créez ces enregistrements chez le registrar du domaine.
          Le HTTPS est émis automatiquement dès que le nom pointe vers le serveur.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Zone</TableHead>
              <TableHead>Nom</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Valeur</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((r) => (
              <TableRow key={r.host}>
                <TableCell>{r.zone}</TableCell>
                <TableCell className="font-mono text-xs">{r.name}</TableCell>
                <TableCell>{r.type}</TableCell>
                <TableCell className="font-mono text-xs">{r.value}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
