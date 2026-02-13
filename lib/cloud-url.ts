/**
 * Cloud URL extraction and download resolution.
 * Parses email HTML for known cloud storage share links
 * and converts them to direct download URLs.
 */

export type CloudUrl = {
  service: "dropbox" | "gdrive";
  originalUrl: string;
};

// Patterns for cloud storage share URLs
const CLOUD_URL_PATTERNS: {
  service: CloudUrl["service"];
  pattern: RegExp;
}[] = [
  // Dropbox: dropbox.com/s/... or dropbox.com/scl/fi/...
  {
    service: "dropbox",
    pattern: /https?:\/\/(?:www\.)?dropbox\.com\/(?:s|scl\/fi)\/[^\s"'<>]+/gi,
  },
  // Google Drive: drive.google.com/file/d/{id}/...
  {
    service: "gdrive",
    pattern: /https?:\/\/drive\.google\.com\/file\/d\/[a-zA-Z0-9_-]+(?:\/[^\s"'<>]*)?/gi,
  },
];

/**
 * Extract cloud storage URLs from HTML content.
 * Returns deduplicated list of recognized cloud URLs.
 */
export function extractCloudUrls(html: string): CloudUrl[] {
  const seen = new Set<string>();
  const results: CloudUrl[] = [];

  for (const { service, pattern } of CLOUD_URL_PATTERNS) {
    // Reset regex state for each call
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(html)) !== null) {
      // Clean up trailing punctuation that might have been captured
      let url = match[0].replace(/[.,;)}\]]+$/, "");
      // Remove any HTML entity remnants
      url = url.split("&amp;")[0];

      if (!seen.has(url)) {
        seen.add(url);
        results.push({ service, originalUrl: url });
      }
    }
  }

  return results;
}

/**
 * Convert a cloud share URL to a direct download URL.
 */
export function resolveDownloadUrl(cloudUrl: CloudUrl): string {
  switch (cloudUrl.service) {
    case "dropbox": {
      // Replace ?dl=0 with ?dl=1, or append ?dl=1
      const url = new URL(cloudUrl.originalUrl);
      url.searchParams.set("dl", "1");
      return url.toString();
    }

    case "gdrive": {
      // Extract file ID from drive.google.com/file/d/{id}/...
      const idMatch = cloudUrl.originalUrl.match(
        /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/
      );
      if (idMatch) {
        return `https://drive.google.com/uc?export=download&id=${idMatch[1]}`;
      }
      return cloudUrl.originalUrl;
    }

    default:
      return cloudUrl.originalUrl;
  }
}
