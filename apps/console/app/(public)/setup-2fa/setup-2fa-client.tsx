"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "@/lib/messenger";
import { authClient, signOut } from "@/lib/auth/client";

export function Setup2FAClient() {
  const router = useRouter();
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleEnableTotp() {
    setLoading(true);
    try {
      const { data, error } = await authClient.twoFactor.enable({
        password: "",
      });
      if (error) {
        toast.error(error.message || "Failed to start 2FA setup");
        setLoading(false);
        return;
      }
      if (data?.totpURI) {
        setTotpUri(data.totpURI);
        if (data.backupCodes) {
          setBackupCodes(data.backupCodes);
        }
      }
    } catch {
      toast.error("Failed to start 2FA setup");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyTotp() {
    setLoading(true);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({
        code: verifyCode,
      });
      if (error) {
        toast.error(error.message || "Invalid code");
        setLoading(false);
        return;
      }
      toast.success("Two-factor authentication enabled");
      router.push("/projects");
    } catch {
      toast.error("Failed to verify code");
      setLoading(false);
    }
  }

  async function handleSwitchMethod() {
    await signOut({
      fetchOptions: {
        onSuccess: () => {
          window.location.href = "/login";
        },
      },
    });
  }

  // Step 2: QR code scan + verify
  if (totpUri) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <Card className="w-full max-w-md squircle rounded-2xl">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <ShieldCheck className="w-6 h-6 text-primary" />
            </div>
            <CardTitle>Scan QR code</CardTitle>
            <CardDescription>
              Open your authenticator app (1Password, Authy, etc.) and scan this
              code, then enter the 6-digit code below.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-center rounded-lg bg-white p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(totpUri)}`}
                alt="TOTP QR Code"
                width={200}
                height={200}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="totp-code">Authentication code</Label>
              <Input
                id="totp-code"
                value={verifyCode}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, "").slice(0, 6);
                  setVerifyCode(val);
                }}
                placeholder="000000"
                className="h-12 text-center text-xl tracking-[0.5em] font-mono squircle rounded-lg"
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                disabled={loading}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && verifyCode.length === 6)
                    handleVerifyTotp();
                }}
              />
            </div>

            <Button
              className="w-full h-11 squircle rounded-lg"
              onClick={handleVerifyTotp}
              disabled={loading || verifyCode.length !== 6}
            >
              {loading ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <ShieldCheck className="w-4 h-4 mr-2" />
              )}
              Verify and continue
            </Button>

            {backupCodes && backupCodes.length > 0 && (
              <div className="space-y-2 border-t pt-4">
                <p className="text-sm font-medium">Backup codes</p>
                <p className="text-xs text-muted-foreground">
                  Save these codes somewhere safe. You can use them to sign in
                  if you lose access to your authenticator app.
                </p>
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-3 font-mono text-sm">
                  {backupCodes.map((code) => (
                    <span key={code}>{code}</span>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Step 1: Explain requirement + start setup
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Card className="w-full max-w-md squircle rounded-2xl">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center">
            <ShieldCheck className="w-6 h-6 text-amber-500" />
          </div>
          <CardTitle>Authenticator app required</CardTitle>
          <CardDescription className="mt-2">
            Password accounts require an authenticator app as a second factor.
            This protects your account against phishing and credential stuffing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            className="w-full h-11 squircle rounded-lg"
            onClick={handleEnableTotp}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <ShieldCheck className="w-4 h-4 mr-2" />
            )}
            Set up authenticator app
          </Button>

          <div className="border-t pt-4">
            <p className="text-xs text-muted-foreground text-center mb-3">
              Don&apos;t want to set up an authenticator? Sign out and use a
              passkey or magic link instead &mdash; those methods don&apos;t
              require a second factor.
            </p>
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={handleSwitchMethod}
            >
              <LogOut className="w-4 h-4 mr-2" />
              Sign out and use a different method
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
