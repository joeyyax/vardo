"use client";

import { useState, useCallback } from "react";
import { Loader2, ShieldCheck, ShieldOff, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { twoFactor } from "@/lib/auth/client";

type TwoFactorSectionProps = {
  enabled: boolean;
  hasPassword: boolean;
};

export function TwoFactorSection({
  enabled: initialEnabled,
  hasPassword,
}: TwoFactorSectionProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [enableOpen, setEnableOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  if (!hasPassword) {
    return (
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Two-factor authentication</p>
          <p className="text-sm text-muted-foreground">
            Set a password first to enable 2FA.
          </p>
        </div>
        <Button variant="outline" disabled>
          Configure 2FA
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Two-factor authentication</p>
            {enabled && (
              <Badge variant="secondary" className="text-xs">
                Enabled
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {enabled
              ? "Your account is protected with an authenticator app."
              : "Add an extra layer of security to your account."}
          </p>
        </div>
      </div>

      {enabled ? (
        <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
          <DialogTrigger asChild>
            <Button variant="outline">Disable 2FA</Button>
          </DialogTrigger>
          <DialogContent className="squircle sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Disable two-factor authentication</DialogTitle>
              <DialogDescription>
                Enter your password to disable 2FA. This will make your account
                less secure.
              </DialogDescription>
            </DialogHeader>
            <DisableForm
              onSuccess={() => {
                setEnabled(false);
                setDisableOpen(false);
              }}
            />
          </DialogContent>
        </Dialog>
      ) : (
        <Dialog open={enableOpen} onOpenChange={setEnableOpen}>
          <DialogTrigger asChild>
            <Button variant="outline">Enable 2FA</Button>
          </DialogTrigger>
          <DialogContent className="squircle sm:max-w-md">
            <EnableFlow
              onComplete={() => {
                setEnabled(true);
                setEnableOpen(false);
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

type EnableStep = "password" | "qr" | "verify" | "backup";

function EnableFlow({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<EnableStep>("password");
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data, error } = await twoFactor.enable({
        password,
      });
      if (error) {
        toast.error(error.message || "Failed to enable 2FA");
        return;
      }
      if (data) {
        setTotpURI(data.totpURI);
        setBackupCodes(data.backupCodes);
        setStep("qr");
      }
    } catch {
      toast.error("Failed to enable 2FA");
    } finally {
      setLoading(false);
    }
  };

  if (step === "password") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Enable two-factor authentication</DialogTitle>
          <DialogDescription>
            Enter your password to get started.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="2fa-password">Password</Label>
            <Input
              id="2fa-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              autoFocus
            />
          </div>
          <Button type="submit" disabled={loading || !password} className="w-full">
            {loading ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Verifying...
              </>
            ) : (
              "Continue"
            )}
          </Button>
        </form>
      </>
    );
  }

  if (step === "qr") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Scan QR code</DialogTitle>
          <DialogDescription>
            Scan this QR code with your authenticator app (Google Authenticator,
            1Password, Authy, etc).
          </DialogDescription>
        </DialogHeader>
        <QRCodeDisplay uri={totpURI} />
        <SecretDisplay uri={totpURI} />
        <Button onClick={() => setStep("verify")} className="w-full">
          I&apos;ve scanned the code
        </Button>
      </>
    );
  }

  if (step === "verify") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Verify authenticator</DialogTitle>
          <DialogDescription>
            Enter the 6-digit code from your authenticator app to confirm setup.
          </DialogDescription>
        </DialogHeader>
        <VerifyForm
          onSuccess={() => setStep("backup")}
          onBack={() => setStep("qr")}
        />
      </>
    );
  }

  // backup step
  return (
    <>
      <DialogHeader>
        <div className="mx-auto mb-2 w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center">
          <ShieldCheck className="w-6 h-6 text-green-600" />
        </div>
        <DialogTitle className="text-center">2FA is enabled</DialogTitle>
        <DialogDescription className="text-center">
          Save these backup codes in a safe place. You can use them to sign in if
          you lose access to your authenticator app. Each code can only be used
          once.
        </DialogDescription>
      </DialogHeader>
      <BackupCodesDisplay codes={backupCodes} />
      <Button onClick={onComplete} className="w-full">
        Done
      </Button>
    </>
  );
}

function QRCodeDisplay({ uri }: { uri: string }) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);

  // Generate QR code using a lightweight approach
  const generateQR = useCallback(async () => {
    try {
      // Use Google Charts API for QR generation (no dependency needed)
      const url = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(uri)}`;
      setImgSrc(url);
    } catch {
      setError(true);
    }
  }, [uri]);

  // Generate on mount
  useState(() => {
    generateQR();
  });

  if (error) {
    return (
      <div className="text-center text-sm text-muted-foreground p-4">
        Could not generate QR code. Use the secret key below instead.
      </div>
    );
  }

  return (
    <div className="flex justify-center py-4">
      {imgSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imgSrc}
          alt="QR Code for authenticator app"
          width={200}
          height={200}
          className="rounded-lg border"
        />
      ) : (
        <div className="w-[200px] h-[200px] bg-muted animate-pulse rounded-lg" />
      )}
    </div>
  );
}

function SecretDisplay({ uri }: { uri: string }) {
  const [copied, setCopied] = useState(false);

  // Extract secret from URI
  const secret = new URL(uri).searchParams.get("secret") || "";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        Or enter this key manually:
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded bg-muted px-3 py-2 text-xs font-mono tracking-wider break-all">
          {secret}
        </code>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleCopy}
          className="shrink-0"
        >
          {copied ? (
            <Check className="size-4 text-green-600" />
          ) : (
            <Copy className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

function VerifyForm({
  onSuccess,
  onBack,
}: {
  onSuccess: () => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await twoFactor.verifyTotp({
        code,
      });
      if (error) {
        toast.error(error.message || "Invalid code. Try again.");
        return;
      }
      toast.success("Two-factor authentication enabled");
      onSuccess();
    } catch {
      toast.error("Verification failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-2">
        <Label htmlFor="totp-code">6-digit code</Label>
        <Input
          id="totp-code"
          value={code}
          onChange={(e) => {
            const val = e.target.value.replace(/\D/g, "").slice(0, 6);
            setCode(val);
          }}
          placeholder="000000"
          className="text-center text-lg tracking-[0.5em] font-mono"
          maxLength={6}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          disabled={loading}
        />
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={onBack} className="flex-1">
          Back
        </Button>
        <Button type="submit" disabled={loading || code.length !== 6} className="flex-1">
          {loading ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" />
              Verifying...
            </>
          ) : (
            "Verify"
          )}
        </Button>
      </div>
    </form>
  );
}

function BackupCodesDisplay({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(codes.join("\n"));
    setCopied(true);
    toast.success("Backup codes copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/50 p-4">
        {codes.map((code) => (
          <code key={code} className="text-sm font-mono text-center py-1">
            {code}
          </code>
        ))}
      </div>
      <Button
        variant="outline"
        onClick={handleCopy}
        className="w-full"
      >
        {copied ? (
          <>
            <Check className="mr-2 size-4 text-green-600" />
            Copied!
          </>
        ) : (
          <>
            <Copy className="mr-2 size-4" />
            Copy backup codes
          </>
        )}
      </Button>
    </div>
  );
}

function DisableForm({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await twoFactor.disable({
        password,
      });
      if (error) {
        toast.error(error.message || "Failed to disable 2FA");
        return;
      }
      toast.success("Two-factor authentication disabled");
      onSuccess();
    } catch {
      toast.error("Failed to disable 2FA");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-2">
        <Label htmlFor="disable-password">Password</Label>
        <Input
          id="disable-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
          autoFocus
        />
      </div>
      <Button
        type="submit"
        variant="destructive"
        disabled={loading || !password}
        className="w-full"
      >
        {loading ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" />
            Disabling...
          </>
        ) : (
          <>
            <ShieldOff className="mr-2 size-4" />
            Disable 2FA
          </>
        )}
      </Button>
    </form>
  );
}
