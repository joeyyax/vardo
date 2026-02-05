import { renderToBuffer } from "@react-pdf/renderer";
import { ReportPdfTemplate, type ReportPdfData } from "./pdf-template";

/**
 * Generate a PDF buffer for a report.
 */
export async function generateReportPdf(data: ReportPdfData): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buffer = await renderToBuffer(ReportPdfTemplate({ data }) as any);
  return buffer;
}
