/** generatedBy markers for Claude reports that could not be produced; the UI offers to retry. */
export const AI_REPORT_FAILED = "erreur";
export const AI_REPORT_NOT_CONFIGURED = "non configuré";

export function aiReportRetryable(generatedBy: string | undefined): boolean {
  return generatedBy === AI_REPORT_FAILED || generatedBy === AI_REPORT_NOT_CONFIGURED;
}
