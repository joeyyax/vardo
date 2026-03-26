"use client";

import { useState, useCallback } from "react";

export type VerifyResult = {
  ok: boolean;
  message: string;
};

/**
 * Shared hook for verifying external integration credentials.
 * Calls a POST endpoint that tests the saved config server-side.
 */
export function useVerify(endpoint: string) {
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);

  const verify = useCallback(async () => {
    setVerifying(true);
    setResult(null);
    try {
      const res = await fetch(endpoint, { method: "POST" });
      const data = (await res.json()) as VerifyResult;
      setResult(data);
    } catch {
      setResult({ ok: false, message: "Network error — could not reach the server" });
    } finally {
      setVerifying(false);
    }
  }, [endpoint]);

  const reset = useCallback(() => setResult(null), []);

  return { verify, verifying, result, reset };
}
