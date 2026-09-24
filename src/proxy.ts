import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = /(^|;\s*)(__Secure-)?better-auth\.session_token=/;

/**
 * Redirects anonymous visitors to /login. Only the presence of the cookie is
 * checked here; pages and actions verify the session itself. /login is never
 * redirected: with an expired or revoked cookie that would loop between "/"
 * and "/login" (the login page sends valid sessions to the dashboard itself).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === "/login") return NextResponse.next();
  const hasSession = SESSION_COOKIE.test(request.headers.get("cookie") ?? "");
  if (!hasSession) {
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // API routes check the session themselves; /apercu serves signed previews (no session).
  matcher: ["/((?!api/|_next/|apercu/|favicon\\.ico$).*)"],
};
