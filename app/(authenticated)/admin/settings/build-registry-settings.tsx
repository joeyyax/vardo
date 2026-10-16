"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSystemSetting } from "./use-system-setting";

type Data = { enabled: boolean; url: string; username: string; hasPassword: boolean };

/** Registry that builds push to and reuse from. */
export function BuildRegistrySettings() {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(false);

  const onLoad = useCallback((data: Data) => {
    setEnabled(data.enabled);
    setUrl(data.url);
    setUsername(data.username);
    setHasPassword(data.hasPassword);
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
          Pushes each built image to this registry and reuses it when a deploy builds the same inputs. Off, images stay on this server.
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
            <p className="text-xs text-muted-foreground">Host plus an optional namespace. Images go to &lt;registry&gt;/&lt;app&gt;:&lt;build key&gt;.</p>
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
