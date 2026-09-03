"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { resendSubmissionAction } from "@/server/actions/sites";

/** Queues again the email of a message that was not transmitted. */
export function ResendSubmissionButton({ submissionId }: { submissionId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function go() {
    startTransition(async () => {
      const res = await resendSubmissionAction(submissionId);
      if (!res.ok) return void toast.error(res.error);
      toast.success("Message remis en file d'envoi");
      setTimeout(() => router.refresh(), 1500);
    });
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={go}
      disabled={pending}
      data-testid="resend-submission"
    >
      {pending ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} Renvoyer
    </Button>
  );
}
