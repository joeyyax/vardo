import { notFound } from "next/navigation";
import { ServiceError } from "./errors";

/** Awaits a service read for a page. A denial or a miss renders the 404. */
export async function pageData<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ServiceError && (error.status === 403 || error.status === 404)) notFound();
    throw error;
  }
}
