import { requireUser } from "@/server/session";
import { PageHeader } from "@/components/app/page-header";
import { ChangePasswordForm } from "@/components/settings/change-password-form";
import { PASSWORD_MIN_LENGTH } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await requireUser();
  return (
    <>
      <PageHeader title="Mon compte" description={`${user.name} · ${user.email}`} />
      <ChangePasswordForm minLength={PASSWORD_MIN_LENGTH} />
    </>
  );
}
