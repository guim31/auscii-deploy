import "server-only";

/**
 * URL of the in-app preview of a release (step 3, site cards, step 4 link).
 * Contract only: the implementation (signed, cookie-less URL on a dedicated
 * origin, PREVIEW_ORIGIN) lives with the preview route.
 */
export function previewUrl(releaseId: string): string {
  return `/api/preview/${releaseId}/`;
}
