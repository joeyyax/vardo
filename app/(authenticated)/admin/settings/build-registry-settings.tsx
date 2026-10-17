"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RelativeTime } from "@/components/relative-time";
import type { CleanupStatus } from "@/lib/docker/build-registry-cleanup";
import { useSystemSetting } from "./use-system-setting";

type Data = { enabled: boolean; url: string; username: string; hasPassword: boolean; cleanup: CleanupStatus | null };

/** Registry that builds on a target come back through. */
export function BuildRegistrySettings() {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [cleanup, setCleanup] = useState<CleanupStatus | null>(null);

  const onLoad = useCallback((data: Data) => {
    setEnabled(data.enabled);
    setUrl(data.url);
    setUsername(data.username);
    setHasPassword(data.hasPassword);
    setCleanup(data.cleanup);
    setPassword("");
  }, []);

  const { loading, saving, save } = useSystemSetting<Data>("/api/v1/admin/build-registry", {
    label: "Build registry",
    onLoad,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Build registry</CardTitle>
        <CardDescription>
          Builds on a build target come back through this registry. Builds on this server don&apos;t push to it. Deploys reuse its images when nothing build-relevant changed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save({ enabled: true, url, username, ...(password ? { password } : {}) });
          }}
        >
          <div className="max-w-md space-y-2">
            <Label htmlFor="build-registry-url">Registry</Label>
            <Input
              id="build-registry-url"
              placeholder="ghcr.io/owner"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">Host plus a namespace for this instance. Images go to &lt;registry&gt;/&lt;app&gt;:&lt;build key&gt;.</p>
          </div>
          <div className="grid max-w-md gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="build-registry-username">Username</Label>
              <Input
                id="build-registry-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="build-registry-password">Password or token</Label>
              <Input
                id="build-registry-password"
                type="password"
                placeholder={hasPassword ? "Saved" : ""}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="max-w-md space-y-1 text-xs text-muted-foreground">
            <p>
              Every 6 hours Vardo deletes old images: each app keeps its newest 3, plus anything under a day old. The registry needs{" "}
              <code>REGISTRY_STORAGE_DELETE_ENABLED=true</code>, and disk frees only after it runs <code>registry garbage-collect</code>.
            </p>
            {enabled && cleanup && (
              <p className={cleanup.error ? "text-destructive" : undefined}>
                Last cleanup <RelativeTime date={cleanup.at} />: {cleanup.error ?? `deleted ${cleanup.deleted}, kept ${cleanup.kept}`}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving || loading || !url.trim()} aria-label="Save build registry">
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
            {enabled && (
              <Button type="button" variant="outline" disabled={saving || loading} onClick={() => save({ enabled: false })}>
                Turn off
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
