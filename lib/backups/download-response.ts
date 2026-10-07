import { NextResponse } from "next/server";
import { createReadStream } from "fs";
import { rm } from "fs/promises";
import { dirname } from "path";
import { getBackupDownloadUrl, downloadBackupToTemp } from "./engine";
import { ArchiveMissingError } from "./storage-port";

/**
 * Redirect to a presigned URL where the target has one, otherwise stream the
 * archive through the server. A missing archive is a 404.
 */
export async function backupDownloadResponse(backupId: string, fileName: string): Promise<Response> {
  let tempPath: string;
  try {
    const url = await getBackupDownloadUrl(backupId);
    if (url) return NextResponse.redirect(url);
    tempPath = await downloadBackupToTemp(backupId);
  } catch (err) {
    if (err instanceof ArchiveMissingError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }

  const cleanup = () => rm(dirname(tempPath), { recursive: true, force: true }).catch(() => {});
  const stream = createReadStream(tempPath);
  const body = new ReadableStream({
    start(controller) {
      stream.on("data", (chunk) => controller.enqueue(chunk));
      stream.on("end", () => {
        controller.close();
        cleanup();
      });
      stream.on("error", (err) => {
        controller.error(err);
        cleanup();
      });
    },
    cancel() {
      stream.destroy();
      cleanup();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
