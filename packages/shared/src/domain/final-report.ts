import { z } from "zod";

const trimmed = z.string().trim().min(1);

export const FinalReportSchema = z
  .object({
    well: trimmed.optional(),
    badly: trimmed.optional(),
    useful: trimmed.optional(),
    free_text: trimmed.optional(),
  })
  .refine(
    (o) =>
      o.well !== undefined ||
      o.badly !== undefined ||
      o.useful !== undefined ||
      o.free_text !== undefined,
    {
      message:
        "final report requires at least one of: well, badly, useful, free_text",
    },
  )
  .refine(
    (o) => {
      const hasStructured =
        o.well !== undefined || o.badly !== undefined || o.useful !== undefined;
      return !(hasStructured && o.free_text !== undefined);
    },
    {
      message:
        "free_text is mutually exclusive with the structured fields (well/badly/useful)",
    },
  );

export type FinalReport = z.infer<typeof FinalReportSchema>;

export function summarizeFinalReport(report: FinalReport): string {
  if (report.free_text !== undefined) return report.free_text;
  const parts: string[] = [];
  if (report.well !== undefined) parts.push(`well: ${report.well}`);
  if (report.badly !== undefined) parts.push(`badly: ${report.badly}`);
  if (report.useful !== undefined) parts.push(`useful: ${report.useful}`);
  return parts.join(" | ");
}
