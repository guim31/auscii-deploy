import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

/**
 * Liveness and readiness probe: used by the Docker healthcheck, by Caddy and by
 * infra/pilot/update.sh. Public on purpose, so it never exposes anything beyond
 * the database being reachable.
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", database: "ok" });
  } catch {
    return NextResponse.json({ status: "error", database: "unreachable" }, { status: 503 });
  }
}
