"use client";

import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ChangePasswordForm({ minLength }: { minLength: number }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) return void toast.error("Les deux nouveaux mots de passe diffèrent.");
    setPending(true);
    const res = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    setPending(false);
    if (res.error) {
      toast.error(
        res.error.status === 400 || res.error.status === 401
          ? "Mot de passe actuel incorrect, ou nouveau mot de passe trop court."
          : "Changement impossible, réessayez.",
      );
      return;
    }
    toast.success("Mot de passe changé. Vos autres sessions ont été fermées.");
    setCurrent("");
    setNext("");
    setConfirm("");
  }

  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle className="text-base">Changer de mot de passe</CardTitle>
        <CardDescription>{minLength} caractères minimum.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="current-password">Mot de passe actuel</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-password">Nouveau mot de passe</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              minLength={minLength}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-password">Confirmation</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={pending || next.length < minLength}>
            {pending && <Loader2Icon className="animate-spin" />} Changer le mot de passe
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
