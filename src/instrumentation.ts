/**
 * Runs once when a Next.js server starts (Next 16 instrumentation hook).
 * Validates the environment up front so a misconfigured pilot stops at boot,
 * visibly in `docker compose logs app`, instead of failing on the first
 * request. (A thrown error is only logged by Next: the server would keep
 * running half-initialised, hence the explicit exit.)
 */
export async function register() {
  // NEXT_RUNTIME is inlined at build time: the edge bundle drops this block.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { env } = await import("./server/env");
    try {
      env();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[app] configuration invalide, arrêt : ${message}`);
      // In development, keep the server up: the error page shows the same message.
      if (process.env.NODE_ENV === "production") process.exit(1);
    }
  }
}
