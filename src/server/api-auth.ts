import { NextResponse } from "next/server";
import { auth } from "./auth";

export type ApiUser = { id: string; email: string; role: "admin" | "manager" };

/** Session check for route handlers. Returns the user or a 401 response. */
export async function apiUser(request: Request): Promise<ApiUser | NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  return {
    id: session.user.id,
    email: session.user.email,
    role: session.user.role === "admin" ? "admin" : "manager",
  };
}

export function isResponse(value: unknown): value is NextResponse {
  return value instanceof Response;
}
