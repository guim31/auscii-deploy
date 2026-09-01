import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = /(^|;\s*)(__Secure-)?better-auth\.session_token=/;

/** Redirects anonymous visitors to /login. The real session check happens in the pages. */
export function proxy(request: NextRequest) {
  const cookie = request.headers.get("cookie") ?? "";
  const hasSession = SESSION_COOKIE.test(cookie);
  const { pathname } = request.nextUrl;

  if (pathname === "/login") {
    return hasSession ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (!hasSession) {
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico|preview).*)"],
};
