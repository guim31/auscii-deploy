import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { env } from "@/server/env";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Liveness and readiness probe: used by the Docker healthcheck, by Caddy and by
 * infra/pilot/update.sh. Public on purpose, so it never exposes anything beyond
 * "configuration valid" and "database reachable": the details of a refused
 * configuration only go to the server logs.
 */
export async function GET() {
  try {
    env();
  } catch (err) {
    console.error("[health] configuration invalide :", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { status: "error", config: "invalid" },
      { status: 503, headers: NO_STORE },
    );
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", database: "ok" }, { headers: NO_STORE });
  } catch (err) {
    console.error("[health] base injoignable :", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { status: "error", database: "unreachable" },
      { status: 503, headers: NO_STORE },
    );
  }
}
