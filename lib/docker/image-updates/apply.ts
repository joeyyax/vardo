import YAML from "yaml";
import { parseImageRef, withTag } from "./image-ref";

/**
 * Rewrites one service's image tag in place.
 *
 * Edits the YAML document rather than re-serializing a parsed model, so
 * comments, ordering and formatting survive and no other service moves.
 */
export function setServiceImageTag(
  yamlContent: string,
  service: string,
  newTag: string,
): { content: string; previousImage: string; newImage: string } | null {
  let doc: YAML.Document.Parsed;
  try {
    doc = YAML.parseDocument(yamlContent);
  } catch {
    return null;
  }
  if (doc.errors.length > 0) return null;

  const current = doc.getIn(["services", service, "image"]);
  if (typeof current !== "string") return null;

  const ref = parseImageRef(current);
  if (!ref) return null;

  const newImage = withTag(ref, newTag);
  if (newImage === current) return null;

  doc.setIn(["services", service, "image"], newImage);
  return { content: String(doc), previousImage: current, newImage };
}

/** Swaps the tag on a bare image reference. */
export function setImageRefTag(
  image: string,
  newTag: string,
): { previousImage: string; newImage: string } | null {
  const ref = parseImageRef(image);
  if (!ref) return null;
  const newImage = withTag(ref, newTag);
  return newImage === image ? null : { previousImage: image, newImage };
}
