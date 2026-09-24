import "server-only";
import { buildPreviewUrl } from "./preview";

/**
 * URL of the in-app preview of a release (step 3, site cards, step 4 link):
 * `${PREVIEW_ORIGIN}/apercu/<signed token>/`, cookie-less and valid about a
 * day. Compute it server-side and pass it to client components as a prop.
 */
export function previewUrl(releaseId: string): string {
  return buildPreviewUrl(releaseId);
}
