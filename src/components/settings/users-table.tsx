"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createUserAction, deleteUserAction, setUserRoleAction } from "@/server/actions/settings";
import { formatDate } from "@/lib/format";

type Row = { id: string; name: string; email: string; role: string; createdAt: string };

export function UsersTable({ users, meId }: { users: Row[]; meId: string }) {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "manager" });
  const [pending, startTransition] = useTransition();

  function create() {
    startTransition(async () => {
      const res = await createUserAction(form);
      if (!res.ok) return void toast.error(res.error);
      toast.success("Compte créé");
      setForm({ name: "", email: "", password: "", role: "manager" });
      router.refresh();
    });
  }
  function setRole(id: string, role: "admin" | "manager") {
    startTransition(async () => {
      const res = await setUserRoleAction(id, role);
      if (!res.ok) toast.error(res.error);
      router.refresh();
    });
  }
  function remove(id: string, email: string) {
    if (!confirm(`Supprimer le compte ${email} ?`)) return;
    startTransition(async () => {
      const res = await deleteUserAction(id);
      if (!res.ok) toast.error(res.error);
      else toast.success("Compte supprimé");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Rôle</TableHead>
                <TableHead>Créé le</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.name}</TableCell>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>
                    <NativeSelect
                      value={u.role}
                      disabled={u.id === meId || pending}
                      onChange={(e) => setRole(u.id, e.target.value as "admin" | "manager")}
                      className="h-8 w-36"
                    >
                      <option value="manager">Gérant</option>
                      <option value="admin">Administrateur</option>
                    </NativeSelect>
                  </TableCell>
                  <TableCell>{formatDate(u.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    {u.id !== meId && (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => remove(u.id, u.email)}
                        disabled={pending}
                        title="Supprimer"
                      >
                        <Trash2Icon />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ajouter un compte</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-name">Nom</Label>
            <Input
              id="new-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-email">Email</Label>
            <Input
              id="new-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-password">Mot de passe (8 caractères min.)</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-role">Rôle</Label>
            <NativeSelect
              id="new-role"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              <option value="manager">Gérant</option>
              <option value="admin">Administrateur</option>
            </NativeSelect>
          </div>
          <div className="flex justify-end sm:col-span-2">
            <Button onClick={create} disabled={pending || !form.email || form.password.length < 8}>
              {pending ? <Loader2Icon className="animate-spin" /> : <PlusIcon />} Créer le compte
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
