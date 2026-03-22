"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, ShieldCheck, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { twoFactor } from "@/lib/auth/client";

function TwoFactorForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/track";

  const [mode, setMode] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (mode === "totp") {
        const { error } = await twoFactor.verifyTotp({
          code,
          trustDevice,
        });
        if (error) {
          toast.error(error.message || "Invalid code");
          setLoading(false);
          return;
        }
      } else {
        // Backup code verification
        const { error } = await twoFactor.verifyBackupCode({
          code,
        });
        if (error) {
          toast.error(error.message || "Invalid backup code");
          setLoading(false);
          return;
        }
      }

      router.push(callbackUrl);
    } catch {
      toast.error("Verification failed");
      setLoading(false);
    }
  };

  return (
    <Card className="w-full max-w-md squircle rounded-2xl">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
          <ShieldCheck className="w-6 h-6 text-primary" />
        </div>
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>
          {mode === "totp"
            ? "Enter the 6-digit code from your authenticator app."
            : "Enter one of your backup codes."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === "totp" ? (
            <div className="grid gap-2">
              <Label htmlFor="totp-code">Authentication code</Label>
              <Input
                id="totp-code"
                value={code}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, "").slice(0, 6);
                  setCode(val);
                }}
                placeholder="000000"
                className="h-12 text-center text-xl tracking-[0.5em] font-mono squircle rounded-lg"
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                disabled={loading}
              />
            </div>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="backup-code">Backup code</Label>
              <Input
                id="backup-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Enter backup code"
                className="h-12 text-center font-mono squircle rounded-lg"
                autoFocus
                disabled={loading}
              />
            </div>
          )}

          {mode === "totp" && (
            <div className="flex items-center space-x-2">
              <Checkbox
                id="trust-device"
                checked={trustDevice}
                onCheckedChange={(checked) =>
                  setTrustDevice(checked === true)
                }
              />
              <Label
                htmlFor="trust-device"
                className="text-sm font-normal cursor-pointer"
              >
                Trust this device for 30 days
              </Label>
            </div>
          )}

          <Button
            type="submit"
            className="w-full h-11 squircle rounded-lg"
            disabled={loading || !code}
          >
            {loading ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <KeyRound className="w-4 h-4 mr-2" />
            )}
            Verify
          </Button>

          <div className="text-center">
            <button
              type="button"
              onClick={() => {
                setMode(mode === "totp" ? "backup" : "totp");
                setCode("");
              }}
              className="text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
            >
              {mode === "totp"
                ? "Use a backup code instead"
                : "Use authenticator app"}
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function TwoFactorSkeleton() {
  return (
    <Card className="w-full max-w-md squircle rounded-2xl">
      <CardHeader className="text-center">
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>Loading...</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-12 bg-muted animate-pulse rounded-lg" />
      </CardContent>
    </Card>
  );
}

export default function TwoFactorPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Suspense fallback={<TwoFactorSkeleton />}>
        <TwoFactorForm />
      </Suspense>
    </div>
  );
}
