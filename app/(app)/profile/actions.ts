"use server";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";

export async function setPassword(newPassword: string) {
  try {
    await auth.api.setPassword({
      body: { newPassword },
      headers: await headers(),
    });
    return { success: true };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to set password";
    return { success: false, error: message };
  }
}
