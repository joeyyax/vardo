"use client";

import { useState } from "react";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { authClient } from "@/lib/auth/client";
import { setPassword as setPasswordAction } from "./actions";

type PasswordSectionProps = {
  hasPassword: boolean;
};

export function PasswordSection({ hasPassword: initialHasPassword }: PasswordSectionProps) {
  const [open, setOpen] = useState(false);
  const [hasPassword, setHasPassword] = useState(initialHasPassword);

  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium">Password</p>
        <p className="text-sm text-muted-foreground">
          {hasPassword
            ? "Change your account password."
            : "Set a password for email sign-in."}
        </p>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline">
            {hasPassword ? "Change password" : "Set password"}
          </Button>
        </DialogTrigger>
        <DialogContent className="squircle sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {hasPassword ? "Change password" : "Set password"}
            </DialogTitle>
            <DialogDescription>
              {hasPassword
                ? "Enter your current password and a new password."
                : "Set a password so you can sign in with email and password."}
            </DialogDescription>
          </DialogHeader>
          {hasPassword ? (
            <ChangePasswordForm
              onSuccess={() => {
                setOpen(false);
              }}
            />
          ) : (
            <SetPasswordForm
              onSuccess={() => {
                setHasPassword(true);
                setOpen(false);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [show, setShow] = useState(false);

  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="pr-10"
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        tabIndex={-1}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

function SetPasswordForm({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }

    setSaving(true);
    try {
      const result = await setPasswordAction(password);
      if (!result.success) {
        toast.error(result.error || "Failed to set password");
        return;
      }
      toast.success("Password set successfully");
      onSuccess();
    } catch {
      toast.error("Failed to set password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-2">
        <Label htmlFor="new-password">New password</Label>
        <PasswordInput
          id="new-password"
          value={password}
          onChange={setPassword}
          placeholder="At least 8 characters"
          disabled={saving}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="confirm-password">Confirm password</Label>
        <PasswordInput
          id="confirm-password"
          value={confirm}
          onChange={setConfirm}
          placeholder="Re-enter password"
          disabled={saving}
        />
      </div>
      <Button type="submit" disabled={saving || !password || !confirm} className="w-full">
        {saving ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" />
            Setting password...
          </>
        ) : (
          "Set password"
        )}
      </Button>
    </form>
  );
}

function ChangePasswordForm({ onSuccess }: { onSuccess: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirm) {
      toast.error("Passwords do not match");
      return;
    }

    setSaving(true);
    try {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: false,
      });
      if (error) {
        toast.error(error.message || "Failed to change password");
        return;
      }
      toast.success("Password changed successfully");
      onSuccess();
    } catch {
      toast.error("Failed to change password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-2">
        <Label htmlFor="current-password">Current password</Label>
        <PasswordInput
          id="current-password"
          value={currentPassword}
          onChange={setCurrentPassword}
          disabled={saving}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="new-password">New password</Label>
        <PasswordInput
          id="new-password"
          value={newPassword}
          onChange={setNewPassword}
          placeholder="At least 8 characters"
          disabled={saving}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <PasswordInput
          id="confirm-password"
          value={confirm}
          onChange={setConfirm}
          placeholder="Re-enter new password"
          disabled={saving}
        />
      </div>
      <Button
        type="submit"
        disabled={saving || !currentPassword || !newPassword || !confirm}
        className="w-full"
      >
        {saving ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" />
            Changing password...
          </>
        ) : (
          "Change password"
        )}
      </Button>
    </form>
  );
}
