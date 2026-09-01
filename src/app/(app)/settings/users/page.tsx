import { requireAdmin } from "@/server/session";
import { prisma } from "@/server/db";
import { PageHeader } from "@/components/app/page-header";
import { UsersTable } from "@/components/settings/users-table";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await requireAdmin();
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });
  return (
    <>
      <PageHeader
        title="Utilisateurs"
        description="Les gérants se connectent avec un email et un mot de passe. Les administrateurs peuvent en plus confirmer les achats et modifier les paramètres."
      />
      <UsersTable
        users={users.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() }))}
        meId={me.id}
      />
    </>
  );
}
