import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <main className="bg-muted/40 flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="bg-primary text-primary-foreground mx-auto mb-3 flex size-12 items-center justify-center rounded-xl text-lg font-bold">
            A
          </div>
          <h1 className="text-xl font-semibold">auscii-deploy</h1>
          <p className="text-muted-foreground text-sm">Mise en ligne des sites vitrine</p>
        </div>
        <LoginForm next={next && next.startsWith("/") ? next : "/"} />
      </div>
    </main>
  );
}
