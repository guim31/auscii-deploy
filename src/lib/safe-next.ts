/**
 * Keeps a post-login destination inside the tool: a path starting with a
 * single "/" ("//evil.com" or "/\evil.com" would leave the site), without
 * control characters. Anything else falls back to the dashboard.
 */
export function safeNext(next: string | string[] | undefined | null): string {
  if (typeof next !== "string") return "/";
  if (!/^\/(?![/\\])/.test(next)) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  return next;
}
