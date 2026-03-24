/**
 * Auto-detect a project icon URL based on image name, deploy type, or git URL.
 * Delegates to detectAppType for the unified type registry.
 */

import { detectAppType } from "./app-type";

export function detectProjectIcon(opts: {
  imageName?: string | null;
  gitUrl?: string | null;
  deployType?: string | null;
  name?: string | null;
  displayName?: string | null;
  templateName?: string | null;
}): string | null {
  return detectAppType(opts).icon;
}
