import { renderToBuffer } from "@react-pdf/renderer";
import { DocumentPdfTemplate, type DocumentPdfData } from "./pdf-template";

/**
 * Generate a PDF buffer for a document.
 */
export async function generateDocumentPdf(
  data: DocumentPdfData
): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buffer = await renderToBuffer(DocumentPdfTemplate({ data }) as any);
  return buffer;
}
