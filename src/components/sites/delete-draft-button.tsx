"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { deleteDraftAction } from "@/server/actions/sites";

export function DeleteDraftButton({ siteId, name }: { siteId: string; name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function remove() {
    if (!window.confirm(`Supprimer le brouillon « ${name} » ?`)) return;
    startTransition(async () => {
      const res = await deleteDraftAction(siteId);
      if (!res.ok) return void toast.error(res.error);
      toast.success("Brouillon supprimé");
      router.refresh();
    });
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={remove}
      disabled={pending}
      aria-label={`Supprimer le brouillon ${name}`}
    >
      {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
    </Button>
  );
}
