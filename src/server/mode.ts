import "server-only";
import { isDemoMode } from "./settings";

/**
 * Demo and real data never mix: an object created in one mode is only visible
 * and actionable in that mode (jobs use the object's own flag, see getProviders).
 */
export async function matchesCurrentMode(entity: { isDemo: boolean }): Promise<boolean> {
  return entity.isDemo === (await isDemoMode());
}

export const OTHER_MODE_ERROR =
  "Cet élément appartient à l'autre mode (démo ou réel) : changez de mode pour y accéder.";
