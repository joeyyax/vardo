# Vardo App Walkthrough
> Every claim in this document includes a file:line citation. If a citation is missing, the claim is unverified and should not be trusted.

Base path for all file references: `/Users/joeyyax/Projects/Sites/joeyyax/host/`

---

## 1. Public Flows

### 1.1 Login Page (`app/(public)/login/`)

**Server component** (`app/(public)/login/page.tsx`):
- Page title "Sign in" (`page.tsx:7`)
- Checks if password auth is allowed via both env var (`isPasswordAuthAllowed()`) and feature flag (`isFeatureEnabled("passwordAuth")`) (`page.tsx:18`)
- Passes `allowPasswordAuth` boolean to the client component (`page.tsx:20`)

**Client component** (`app/(public)/login/login-form.tsx`):
- Three sign-in method types: `"passkey" | "password" | "magic"` (`login-form.tsx:19`)
- Default method is `"password"` when allowed, otherwise `"magic"` (`login-form.tsx:30`)
- State: email, password, showPassword, isLoading, magicLinkSent, method, error (`login-form.tsx:25-31`)
- **Passkey button** -- primary variant, full-width, calls `signIn.passkey()` (`login-form.tsx:33-52`, `login-form.tsx:146-158`)
- **GitHub OAuth button** -- outline variant, calls `signIn.social({ provider: "github" })` (`login-form.tsx:161-187`)
- **Separator** "or use email" between OAuth and email methods (`login-form.tsx:189-198`)
- **Password form** (when `method === "password" && allowPasswordAuth`):
  - Email input (required) (`login-form.tsx:204-214`)
  - Password input with show/hide toggle (`login-form.tsx:216-240`)
  - Submit calls `signIn.email()` (`login-form.tsx:54-78`)
  - Comment on line 69: "If 2FA is enabled, the twoFactorClient plugin handles the redirect" (`login-form.tsx:69`)
- **Magic link form** (when password not selected or not allowed):
  - Email input (required) (`login-form.tsx:258-269`)
  - Submit calls `signIn.magicLink()` (`login-form.tsx:80-101`)
- **Magic link sent state**: shows "Check your email" card, tells user link expires in 10 minutes (`login-form.tsx:103-131`)
- **Method toggle**: "Use magic link instead" / "Use password instead" link, only shown when `allowPasswordAuth` (`login-form.tsx:287-301`)
- **Error display**: red alert div with `role="alert"` (`login-form.tsx:136-143`)
- **Loading skeleton**: `LoginSkeleton` component with pulse animations (`login-form.tsx:309-322`)
- Entire page wrapped in `Suspense` with `LoginSkeleton` fallback (`login-form.tsx:327`)

### 1.2 Setup Wizard (`app/(public)/setup/`)

**Server component** (`app/(public)/setup/page.tsx`):
- Redirects to `/` if setup is not needed (`page.tsx:10-12`)
- Checks mesh feature flag and provider restrictions (`page.tsx:14-15`)
- Forces dynamic rendering (`page.tsx:7`)

**Client component** (`app/(public)/setup/setup-wizard.tsx`):

**Steps** defined at (`setup-wizard.tsx:35-85`):

| Step ID | Label | Description | Icon | Required |
|---------|-------|-------------|------|----------|
| `welcome` | Welcome | Get started with Vardo | Rocket | no |
| `account` | Create account | Set up your admin credentials | User | **yes** |
| `email` | Email provider | SMTP, Mailpace, or Resend | Mail | no |
| `backup` | Backup storage | S3, R2, or B2 for volume backups | HardDrive | no |
| `github` | GitHub App | Repository access and auto-deploy | Github | no |
| `domain` | Domain & DNS | Verify DNS records for HTTPS | Globe | no |
| `instances` | Instances | Connect to other Vardo instances | Network | no (hidden if mesh disabled) |
| `done` | Ready to go | Start deploying | Rocket | no |

- Hidden "import" step also exists (`setup-wizard.tsx:87`)
- Instances step is filtered out when `meshEnabled` is false (`setup-wizard.tsx:124`)
- Progress persisted to localStorage under key `"vardo-setup"` (`setup-wizard.tsx:89`)
- Progress also hydrated from DB via `GET /api/setup/progress` (`setup-wizard.tsx:139`)
- Merged progress: DB wins, then union with localStorage (`setup-wizard.tsx:153-156`)

**Welcome step** (`setup-wizard.tsx:284-327`):
- Two options: "Fresh install" (default) and "Restore from backup" (outline)
- "Fresh install" advances to account step (`setup-wizard.tsx:297-299`)
- "Restore from backup" goes to import step (`setup-wizard.tsx:313-314`)

**Import step** (`setup-wizard.tsx:328-348`):
- Maps imported sections to steps: email, backup, github (`setup-wizard.tsx:334-338`)
- On complete, marks corresponding steps as complete and goes to account (`setup-wizard.tsx:339-343`)

**Steps rendering** (`setup-wizard.tsx:350-436`):
- Each step (email, backup, github, domain, instances) has both `onComplete` and `onSkip` callbacks
- All skip callbacks still mark the step as complete (`setup-wizard.tsx:369-372` etc.)
- Done step clears localStorage and redirects to `/projects` (`setup-wizard.tsx:429-434`)

**Default provider restrictions** (`setup-wizard.tsx:110-114`):
- `allowSmtp: true`
- `allowLocalBackups: true`
- `allowPasswordAuth: true`

**Layout**: two-column on md+ (280px sidebar + content), centered, max-w-4xl (`setup-wizard.tsx:209-226`)

### 1.3 Onboarding Page (`app/(public)/onboarding/page.tsx`)
- Simply redirects to `/setup` (`page.tsx:4`)

### 1.4 Create Organization Page (`app/(public)/create-org/page.tsx`)
- Client component, requires authentication (`page.tsx:18-23`)
- Single field: "Organization name" (`page.tsx:81-88`)
- Auto-generates slug from name (lowercase, non-alphanumeric to hyphens) (`page.tsx:29-32`)
- POSTs to `/api/v1/organizations` with `{ name, slug }` (`page.tsx:34-36`)
- On success redirects to `/projects` (`page.tsx:49`)
- Loading state: centered spinner (`page.tsx:59-65`)

### 1.5 Invite Page (`app/(public)/invite/[token]/`)

**Server component** (`page.tsx`):
- Fetches invitation from DB by token (`page.tsx:55-62`)
- **States**:
  - Invalid invitation: shows "Invalid invitation" (`page.tsx:64-75`)
  - Expired: checks `status === "expired"` or `expiresAt < new Date()`, shows "Invitation expired" with instructions to request new one (`page.tsx:77-88`)
  - Already accepted: shows "Already accepted" (`page.tsx:116-127`)
  - Logged in with matching email: auto-accepts via server action `acceptInvitation` (`page.tsx:102-114`)
  - Otherwise: renders `InviteAcceptClient` with email, orgName, inviterName, isLoggedIn, acceptAction (`page.tsx:129-138`)
- Scopes: supports `"org"` scope with targetId (`page.tsx:27-28`, `92-97`)

### 1.6 Public Layout (`app/(public)/layout.tsx`)
- Minimal wrapper: `min-h-screen bg-background text-foreground` (`layout.tsx:7`)
- No header or navigation (`layout.tsx:8`)

---

## 2. Authenticated Layout (`app/(authenticated)/layout.tsx`)

- Checks feature flag `"ui"` -- if disabled, shows "Web UI is disabled. Use the API at `/api/v1/`" (`layout.tsx:23-34`)
- Requires current org; redirects to `/create-org` if none (`layout.tsx:38-39`)
- Layout structure (`layout.tsx:46-65`):
  - Sticky `TopNav` at top with org data (`layout.tsx:48-53`)
  - `<main>` with `max-w-screen-xl`, `px-5 py-8 lg:px-10` (`layout.tsx:55-57`)
  - `SessionFooter` at bottom (`layout.tsx:59`)
  - `CommandPalette` and `NotificationListener` outside main (`layout.tsx:62-63`)

### 2.1 Top Navigation (`components/layout/top-nav.tsx`)

**Nav items** (`top-nav.tsx:16-21`):
- Projects (`/projects`)
- Metrics (`/metrics`)
- Backups (`/backups`)
- Activity (`/activity`)

- Brand logo on the left (`top-nav.tsx:35`)
- Nav links hidden on mobile (`lg:flex`) (`top-nav.tsx:39`)
- `UserMenu` on the right, hidden on mobile (`top-nav.tsx:62-67`)
- `MobileSidebar` hamburger for mobile (`top-nav.tsx:31-34`)

### 2.2 User Menu (`components/layout/user-menu.tsx`)

**Sections** in the dropdown:
1. **Profile header**: name, email, settings gear icon linking to `/user/settings/profile` (`user-menu.tsx:105-118`)
2. **Organizations section**: list of user orgs with checkmark on active, "New organization" link to `/onboarding` (`user-menu.tsx:122-152`)
   - Org settings gear links to `/settings` (`user-menu.tsx:126-131`)
   - Switch org via `switchOrganization()` then refresh (`user-menu.tsx:47-56`)
3. **Admin link**: only shown when `session.user.isAppAdmin` is truthy, links to `/admin/settings` (`user-menu.tsx:155-166`)
4. **Theme switcher**: Light/Dark/Auto (system) toggle with Sun/Moon/Monitor icons (`user-menu.tsx:169-194`)
5. **Sign out**: destructive variant (`user-menu.tsx:198-205`)

### 2.3 Command Palette (`components/command-palette.tsx`)

- Triggered by `Cmd/Ctrl+K` (`command-palette.tsx:82-84`)
- Fetches searchable data from `/api/v1/organizations/{orgId}/search` on open (`command-palette.tsx:98`)
- Data cached for 30 seconds after close (`command-palette.tsx:113`)
- **Search groups** (`command-palette.tsx:136-187`):
  - **Apps**: searchable by displayName, name, projectName, imageName, domains (`command-palette.tsx:141`)
  - **Projects**: searchable by displayName, name (`command-palette.tsx:162`)
  - **Shared Variables**: org env var keys, navigates to `/settings/variables` (`command-palette.tsx:173-186`)
- **Pages group** (`command-palette.tsx:192+`): Dashboard, New App, Settings, Admin, Team, Activity, Backups, Metrics, Account settings, more

---

## 3. Projects & Apps

### 3.1 Projects List Page (`app/(authenticated)/projects/page.tsx`)

- Fetches apps, tags, and projects in parallel for the current org (`page.tsx:23-52`)
- Apps query: scoped by `organizationId`, excludes child apps (`parentAppId IS NULL`), ordered by `sortOrder` then `createdAt DESC` (`page.tsx:24-27`)
- Includes related data: domains, deployments (last 1), appTags with tag, project (`page.tsx:28-42`)

**Actions** in PageToolbar (`page.tsx:62-75`):
- "New project" button (outline) -> `/projects/new` (`page.tsx:63-66`)
- "Deploy app" button (default) -> `/apps/new` (`page.tsx:69-73`)

**Empty state** (`page.tsx:88-111`):
- Shows when `appList.length === 0 && emptyProjects.length === 0`
- Text: "Deploy your first app" with description about Git repo, Docker image, or Compose file (`page.tsx:92-96`)
- Two CTAs: "Deploy app" and "New project" (`page.tsx:98-109`)

**Populated state**: renders `<AppGrid>` with apps, tags, orgId, emptyProjects (`page.tsx:113-118`)

### 3.2 New Project Form (`app/(authenticated)/projects/new/new-project-form.tsx`)

**Fields** (`new-project-form.tsx:75-118`):
- **Name** (displayName): text input, required (`new-project-form.tsx:79-87`)
- **Slug** (name): auto-generated from name via `slugify()`, editable, font-mono (`new-project-form.tsx:90-103`)
  - Slug validation: lowercase, only `a-z0-9-` (`new-project-form.tsx:30`)
- **Description**: optional textarea, 3 rows (`new-project-form.tsx:106-118`)

**Actions** (`new-project-form.tsx:122-134`):
- "Create project" submit button (disabled when submitting or no slug)
- "Cancel" ghost button calls `router.back()`
- POSTs to `/api/v1/organizations/{orgId}/projects` (`new-project-form.tsx:45-52`)
- On success redirects to `/projects/{name}` (`new-project-form.tsx:66`)

### 3.3 Project Detail Page (`app/(authenticated)/projects/[...slug]/page.tsx`)

**URL patterns**: `/projects/{slug}` or `/projects/{slug}/{tab}` (`page.tsx:20-34`)

**Valid tabs** (`page.tsx:10`): `apps`, `deployments`, `variables`, `logs`, `metrics`, `backups`, `instances`

- Default tab: `"apps"` (`page.tsx:120`)
- Looks up project by name or ID (`page.tsx:42-45`)
- Redirects ID-based URLs to clean slug URLs (`page.tsx:115-118`)
- Fetches mesh feature flag and mesh data (peers, project instances) in parallel (`page.tsx:123-133`)
- Instances tab data only passed when meshEnabled (`page.tsx:141-142`)

### 3.4 New App Flow (`app/(authenticated)/apps/new/new-app-flow.tsx`)

**Deploy types** (`new-app-flow.tsx:39`): `"compose" | "dockerfile" | "image" | "static" | "nixpacks" | "railpack"`

**Source options** displayed to user (`new-app-flow.tsx:114-118`):
- **GitHub**: "From your connected account"
- **Docker Compose**: "Paste or from a repo"
- **Image**: "Any Docker image"

**Template categories** (`new-app-flow.tsx:105-112`):
- database: "Databases"
- cache: "Cache & Queues"
- monitoring: "Monitoring"
- web: "Web Servers"
- tool: "Tools"
- custom: "Custom"

**Form fields** (`new-app-flow.tsx:141-176`):
- `displayName`, `name` (slug, auto-generated)
- `description`
- `source`: "git" or "direct"
- `deployType`: compose, dockerfile, image, static, nixpacks, railpack
- `gitMode`: "github" or "manual"
- `gitUrl`, `gitBranch` (default "main"), `imageName`
- `composeContent`, `contentMode`: "paste" or "url"
- `rootDirectory`, `containerPort`
- `autoDeploy` (default true), `persistData` (default true)
- `parentId` (project), `exposePort`, `createRepo`
- `cpuLimit`, `memoryLimit`, `diskWriteAlertThreshold`
- `generateDomain` (default true), domain auto-generated via `generateWordPair()` + `getBaseDomain()`
- `envContent` (raw .env format)
- GitHub state: installations, repos, branches, selectedInstallation, selectedRepo

**GitHub integration** (`new-app-flow.tsx:188-216`):
- Fetches installations from `/api/v1/github/installations`
- Auto-selects single installation
- Fetches repos from `/api/v1/github/repos?installationId=...`

### 3.5 App Detail Page (`app/(authenticated)/apps/[...slug]/page.tsx`)

**URL patterns** (`page.tsx:20-27`):
- `/apps/{slug}`
- `/apps/{slug}/{tab}`
- `/apps/{slug}/{tab}/{subView}`
- `/apps/{slug}/{env}`
- `/apps/{slug}/{env}/{tab}`
- `/apps/{slug}/{env}/{tab}/{subView}`

**Valid tabs** (`page.tsx:10`): `apps`, `deployments`, `connect`, `variables`, `networking`, `logs`, `volumes`, `cron`, `terminal`, `metrics`, `backups`

- Tab disambiguation: if segment 2 is a known tab, it's a tab; otherwise it's an env name (`page.tsx:33-49`)
- Feature-gated tabs: `cron` -> "cron" flag, `terminal` -> "terminal" flag; falls back to `"deployments"` if disabled (`page.tsx:213-219`)
- Backfills production environment if missing (`page.tsx:137-152`)
- Strips "production" from URL (it's the default) (`page.tsx:159-163`)
- Redirects ID-based URLs to clean slug (`page.tsx:166-170`)
- Fetches sibling apps if project exists (`page.tsx:173-200`)
- Default tab: `"deployments"` (`page.tsx:219`)

### 3.6 App Detail Client Component (`app/(authenticated)/apps/[...slug]/app-detail.tsx`)

**App types** (from `types.ts:68-104`):

| Field | Type | Notes |
|-------|------|-------|
| status | `"active" \| "stopped" \| "error" \| "deploying"` | (`types.ts:94`) |
| deployType | `"compose" \| "dockerfile" \| "image" \| "static" \| "nixpacks" \| "railpack"` | (`types.ts:74`) |
| source | `"git" \| "direct"` | (`types.ts:73`) |

**Deployment types** (from `types.ts:3-21`):
- Status: `"queued" | "running" | "success" | "failed" | "cancelled" | "rolled_back"` (`types.ts:5`)
- Trigger: `"manual" | "webhook" | "api" | "rollback"` (`types.ts:6`)

**Environment types** (`types.ts:44`): `"production" | "staging" | "preview"`

**Toolbar actions** (when active) (`app-detail.tsx:387-447`):
- **Running dropdown**: Redeploy, Restart (`/restart` POST), Stop (with confirmation) (`app-detail.tsx:409-438`)
  - Shows "Restart Needed" badge with warning color when `app.needsRedeploy` (`app-detail.tsx:390-399`)
  - Shows uptime timer when running (`app-detail.tsx:400-405`)
- **When stopped/error**: single Deploy/Retry button (`app-detail.tsx:440-447`)
- **Edit button**: opens AppSettingsDialog (`app-detail.tsx:448-451`)
- **More menu** (admin only): Assign parent, Delete environment (non-production), Delete app (`app-detail.tsx:452-494`)

**Environment switcher** (`app-detail.tsx:539-583`):
- Dropdown showing all environments with type-colored dots
- Production = green, staging = yellow, preview = blue (`app-detail.tsx:89-93`)
- "New environment" option at bottom (`app-detail.tsx:570-581`)

**New environment form** (`app-detail.tsx:127-132`, `320-376`):
- Fields: name, type (staging/preview), cloneFrom (production, existing env, or empty), gitBranch
- Auto-deploys on creation (`app-detail.tsx:353-358`)

**Error banner** (`app-detail.tsx:587-618`):
- Shown when `app.status === "error"` and a failed deploy exists
- Extracts last error line from deploy log, sanitizes secrets
- Link to "View log" (`app-detail.tsx:612-615`)

**Real-time updates** (`app-detail.tsx:190-218`):
- SSE via EventSource at `/api/v1/organizations/{orgId}/apps/{appId}/events`
- Listens for `deploy:complete` events
- Fallback: polling every 10 seconds on SSE error

**Tag management** (`app-detail.tsx:221-252`):
- Toggle tags via `POST/DELETE /api/v1/organizations/{orgId}/apps/{appId}/tags`

**Tabs** (`app-detail.tsx:783-931`):

| Tab | Value | Feature-gated | Notes |
|-----|-------|--------------|-------|
| Deployments | `deployments` | no | Default tab. Includes `AppDeployPanel` |
| Connect | `connect` | no | Only shown when `connectionInfo` exists |
| Variables | `variables` | no | `EnvEditor` component |
| Networking | `networking` | no | `AppNetworking` with domains and ports |
| Logs | `logs` | no | `LogViewer` |
| Volumes | `volumes` | no | `VolumesPanel` |
| Cron | `cron` | `featureFlags.cron` | `CronManager` |
| Terminal | `terminal` | `featureFlags.terminal` | `AppTerminal` (dynamically imported, SSR disabled) |
| Metrics | `metrics` | no | `AppMetrics` |
| Backups | `backups` | `featureFlags.backups` | `AppBackupHistory` |

### 3.7 App Settings Dialog (`app/(authenticated)/apps/[...slug]/app-settings-dialog.tsx`)

**Editable fields** (`app-settings-dialog.tsx:49-68`):
- `displayName` (`app-settings-dialog.tsx:49`)
- `description` (`app-settings-dialog.tsx:50`)
- `containerPort` with autoPort toggle (`app-settings-dialog.tsx:51-54`)
- `imageName` (for image deploy type) (`app-settings-dialog.tsx:55`)
- `restartPolicy` (default "unless-stopped") (`app-settings-dialog.tsx:56`)
- `autoTraefikLabels` switch (`app-settings-dialog.tsx:57-59`)
- `autoDeploy` switch (`app-settings-dialog.tsx:60`)
- `gitBranch` (`app-settings-dialog.tsx:61`)
- `rootDirectory` (`app-settings-dialog.tsx:62`)
- Project assignment (`editParentId`) (`app-settings-dialog.tsx:63`)
- `cpuLimit`, `memoryLimit` (`app-settings-dialog.tsx:64-65`)
- `diskWriteAlertThreshold` (displayed in GB, stored in bytes) (`app-settings-dialog.tsx:66`)
- `autoRollback` switch (`app-settings-dialog.tsx:67`)
- `rollbackGracePeriod` (default "60" seconds) (`app-settings-dialog.tsx:68`)

### 3.8 App Connect Tab (`app/(authenticated)/apps/[...slug]/app-connect.tsx`)

- Shows internal (Docker network) connection info (`app-connect.tsx:30-33`)
- Values/Variables toggle via Switch (`app-connect.tsx:36-39`)
- Resolves template variables like `${project.name}`, `${project.port}`, `${VAR_KEY}` from env vars (`app-connect.tsx:49-56`)

### 3.9 App Networking Tab (`app/(authenticated)/apps/[...slug]/app-networking.tsx`)

- Manages custom domains: add, edit, delete (`app-networking.tsx:51-60`)
- Domain fields: domain name, port, cert resolver (`app-networking.tsx:53-55`)
- Includes `PortsManager` component for exposed ports (`app-networking.tsx:26`)

### 3.10 App Cron Tab (`app/(authenticated)/apps/[...slug]/app-cron.tsx`)

**CronJob type** (`app-cron.tsx:38-49`):
- `type`: `"command" | "url"`
- `schedule`: cron expression
- `enabled`: boolean
- `lastStatus`: `"success" | "failed" | "running" | null`

**Schedule presets** (`app-cron.tsx:56-66`):
- Every minute, Every 5 minutes, Every 15 minutes, Every hour, Every 6 hours
- Daily at midnight, Daily at 3 AM, Weekly (Sunday midnight), Custom

---

## 4. Settings

### 4.1 Organization Settings (`app/(authenticated)/settings/layout.tsx`)

**Tabs** (`layout.tsx:6-14`):

| Tab | Path | Component |
|-----|------|-----------|
| General | `/settings/general` | `OrgGeneralSettings` |
| Shared variables | `/settings/variables` | `OrgEnvVarsEditor` |
| Domains | `/settings/domains` | `OrgDomainEditor` |
| Backups | `/settings/backups` | `BackupPage (scope="org")` |
| Notifications | `/settings/notifications` | `NotificationChannelsEditor` + `DigestSettingsEditor` |
| Team | `/settings/team` | `TeamMembers` (embedded mode) |
| Invitations | `/settings/invitations` | `InvitationsPanel` |

- Requires auth and current org; redirects to `/onboarding` if missing (`layout.tsx:24-26`)

**Team tab** (`[tab]/page.tsx:76-107`): Shows org members with id, name, email, image, role, joinedAt. Passes `currentRole` and `currentUserId`.

**Invitations tab** (`[tab]/page.tsx:110-144`): Lists invitations with id, email, role, status (pending/accepted/expired), createdAt, expiresAt, inviter info.

**Domains tab** (`[tab]/page.tsx:50-58`): Passes `defaultDomain` from `VARDO_BASE_DOMAIN` env var (fallback "joeyyax.dev"), `sslEnabled`, `serverIP` from `VARDO_SERVER_IP`.

### 4.2 User Settings (`app/(authenticated)/user/settings/layout.tsx`)

**Tabs** (`layout.tsx:5-10`):

| Tab | Path | Components |
|-----|------|-----------|
| Profile | `/user/settings/profile` | `AccountInfo` + `ThemeSwitcher` |
| Authentication | `/user/settings/auth` | `PasskeyManager`, `LinkedAccounts`, `PasswordManagement`, `TwoFactorAuth`, `ActiveSessions` |
| API tokens | `/user/settings/tokens` | `ApiTokens` (requires orgId) |
| Connections | `/user/settings/connections` | `GitHubConnection` |

**Profile tab** (`[tab]/page.tsx:44-58`): AccountInfo component + ThemeSwitcher in top-right.

**Auth tab** (`[tab]/page.tsx:59-76`):
- Grid layout (2 cols on lg): PasskeyManager + LinkedAccounts
- Then: PasswordManagement, TwoFactorAuth, ActiveSessions

**Tokens tab** (`[tab]/page.tsx:77-97`): Shows "No organization selected" message if no org.

**Connections tab** (`[tab]/page.tsx:98-109`): GitHubConnection component for linking external accounts.

### 4.3 Admin Settings (`app/(authenticated)/admin/settings/layout.tsx`)

- Requires `isAppAdmin` on the user; redirects to `/projects` otherwise (`layout.tsx:37`)

**Base nav items** (`layout.tsx:10-19`):

| Tab | Path |
|-----|------|
| Overview | `/admin/settings/overview` |
| General | `/admin/settings/general` |
| Email | `/admin/settings/email` |
| Authentication | `/admin/settings/authentication` |
| Feature flags | `/admin/settings/feature-flags` |
| Backups | `/admin/settings/backup` |
| GitHub App | `/admin/settings/github` |
| Domain & SSL | `/admin/settings/domain` |
| Config | `/admin/settings/config` |

- **Instances** tab added dynamically when mesh feature is enabled (`layout.tsx:39-41`)

---

## 5. Admin Panel (`app/(authenticated)/admin/`)

### 5.1 Admin Panel Page (`app/(authenticated)/admin/[[...slug]]/page.tsx`)

- Requires `isAppAdmin` (`page.tsx:27-28`)
- Valid tabs: `overview`, `system`, `organizations`, `users`, `maintenance`, `metrics` (`page.tsx:8`)
- Default tab: `"overview"` (`page.tsx:17-19`)
- URL: `/admin` or `/admin/{tab}` (`page.tsx:24`)

### 5.2 Admin Panel Client (`app/(authenticated)/admin/admin-panel.tsx`)

**Tabs** (`admin-panel.tsx:42-49`):

| Tab | Component |
|-----|-----------|
| Overview | `AdminOverview` |
| System | `AdminSystem` |
| Organizations | `AdminOrganizations` |
| Users | `UserManagement` (from `admin-actions.tsx`) |
| Maintenance | `DockerPrune` (from `admin-actions.tsx`) |
| Metrics | `AdminMetrics` |

- Link to "System settings" in toolbar (`admin-panel.tsx:31-36`)

### 5.3 Admin Overview (`app/(authenticated)/admin/admin-overview.tsx`)

- Fetches from `/api/v1/admin/overview` (`admin-overview.tsx:31`)
- **Stat cards** with sparklines (`admin-overview.tsx:16-21`):
  - Users, Apps, Deployments, Templates
- **Resource bars** (CPU, memory, disk-like) with status: critical, warning, healthy (`admin-overview.tsx:72-80`)
- **Infrastructure services** list

### 5.4 Admin System (`app/(authenticated)/admin/admin-system.tsx`)

- Fetches from `/api/v1/admin/health` (`admin-system.tsx:30`)
- **Data shape** (`admin-system.tsx:9-15`):
  - `services: ServiceStatus[]`
  - `runtime: RuntimeInfo` (nextVersion, nodeVersion, uptime, memoryUsage)
  - `auth`: passkeys, magicLink, github, passwords, twoFactor (booleans)
  - `featureFlags: FeatureFlagInfo[]`
- **Runtime section**: Next.js version, Node.js version, Uptime, Memory RSS (`admin-system.tsx:44-58`)
- **Infrastructure section**: service list with healthy/unhealthy/unknown status indicators (`admin-system.tsx:68-80`)
- **Auth methods** and **Feature flags** sections

---

## 6. Other Authenticated Pages

### 6.1 Activity Page (`app/(authenticated)/activity/page.tsx`)

- Fetches last 50 activities for current org (`page.tsx:15-22`)
- Includes user info (id, name, email, image) and app info (id, name, displayName) per activity (`page.tsx:18-19`)
- Renders `ActivityFeed` component (`page.tsx:30`)

### 6.2 Metrics Page (`app/(authenticated)/metrics/page.tsx`)

- Fetches app list for current org (id, name, displayName, status) (`page.tsx:18-22`)
- Renders `OrgMetrics` component with orgId and apps (`page.tsx:30-33`)

### 6.3 Backups Page (`app/(authenticated)/backups/page.tsx`)

- Fetches app list (id, name, displayName) (`page.tsx:18-20`)
- Renders `BackupPage` with `scope="org"` (`page.tsx:33`)
- Description: "Manage backup targets, schedules and retention for your organization." (`page.tsx:30`)

---

## 7. Feature Flags (`lib/config/features.ts`)

**Available flags** (`features.ts:13-20`):

| Flag | Label | Description | Default |
|------|-------|-------------|---------|
| `ui` | Web UI | Web dashboard for managing projects, apps, and deployments | true |
| `terminal` | Terminal | Web-based shell access to running containers | true |
| `environments` | Environments | Multiple deployment environments per app (staging, preview) | true |
| `backups` | Backups | Scheduled volume snapshots to S3-compatible storage | true |
| `cron` | Cron Jobs | Scheduled command execution inside containers | true |
| `passwordAuth` | Password Auth | Email/password sign-in and onboarding | true |
| `mesh` | Instances | Connect multiple Vardo instances over encrypted WireGuard tunnels | true |

- Resolution order: config file (vardo.yml) > DB system_settings > default (true) (`features.ts:8`)
- Core features (projects, apps, deployments) cannot be disabled (`features.ts:9`)
- Metrics and logs are always available (`features.ts:10`)
- UI-gated flags for tab visibility: `terminal`, `cron`, `backups` (`features.ts:112`)
- Sync cache populated at startup via `loadFeatureFlags()` (`features.ts:71-74`)

---

## 8. API Surface

### 8.1 MCP Server (`app/api/mcp/route.ts`)

- `POST /api/mcp`: Streamable HTTP transport for MCP JSON-RPC (`route.ts:13-31`)
  - Stateless: fresh McpServer per request (`route.ts:22`)
  - Authenticated via Bearer token bound to an organization (`route.ts:14-19`)
- `GET /api/mcp`: SSE endpoint, returns 405 in stateless mode (`route.ts:39-48`)
- `DELETE /api/mcp`: No-op, returns 204 (`route.ts:56-58`)

**MCP Tools** (`lib/mcp/tools/index.ts:3-6`):
- `list-apps` (`lib/mcp/tools/list-apps.ts`)
- `get-app-status` (`lib/mcp/tools/get-app-status.ts`)
- `get-app-logs` (`lib/mcp/tools/get-app-logs.ts`)
- `list-projects` (`lib/mcp/tools/list-projects.ts`)

**Server config** (`lib/mcp/server.ts:11-13`): name: "vardo", version: "1.0.0"

### 8.2 Auth Route (`app/api/auth/[...all]/route.ts`)
- Better Auth catch-all handler

### 8.3 Health Routes
- `GET /api/health` (`app/api/health/route.ts`)
- `GET /api/health/system` (`app/api/health/system/route.ts`)

### 8.4 Setup API Routes (`app/api/setup/`)
- `POST /api/setup/auth`
- `POST /api/setup/backup`
- `POST /api/setup/email`
- `POST /api/setup/feature-flags`
- `POST /api/setup/general`
- `POST /api/setup/github`
- `GET /api/setup/progress`
- `POST /api/setup/services`
- `POST /api/setup/ssl`
- `GET /api/setup/status`

### 8.5 Admin API Routes (`app/api/v1/admin/`)
- `GET /api/v1/admin/overview`
- `GET /api/v1/admin/health`
- `POST /api/v1/admin/docker-prune`
- `GET /api/v1/admin/stats` and `GET /api/v1/admin/stats/stream`
- `GET /api/v1/admin/users`
- `GET /api/v1/admin/organizations`
- `POST /api/v1/admin/dns-check`
- `GET /api/v1/admin/backup-targets`
- Config: `GET /api/v1/admin/config/export`, `POST /api/v1/admin/config/import`
- Mesh admin: invite, join, clone, promote, pull, peers CRUD

### 8.6 GitHub API Routes (`app/api/v1/github/`)
- `GET /api/v1/github/installations`
- `GET /api/v1/github/repos`
- `POST /api/v1/github/repos`
- `GET /api/v1/github/branches`
- `GET /api/v1/github/env-scan`
- `POST /api/v1/github/connect`
- `POST /api/v1/github/webhook`
- `GET /api/v1/github/callback`

### 8.7 Organization-scoped API Routes (`app/api/v1/organizations/[orgId]/`)

**Core:**
- `GET/PATCH/DELETE /api/v1/organizations/{orgId}`
- `GET/POST /api/v1/organizations/{orgId}/members`
- `PATCH/DELETE /api/v1/organizations/{orgId}/members/{userId}`
- `GET /api/v1/organizations/{orgId}/search`
- `GET /api/v1/organizations/{orgId}/activities`

**Apps:**
- `GET/POST /api/v1/organizations/{orgId}/apps`
- `POST /api/v1/organizations/{orgId}/apps/sort`
- `GET/PATCH/DELETE /api/v1/organizations/{orgId}/apps/{appId}`
- `POST /api/v1/organizations/{orgId}/apps/{appId}/deploy`
- `POST /api/v1/organizations/{orgId}/apps/{appId}/stop`
- `POST /api/v1/organizations/{orgId}/apps/{appId}/restart`
- `GET /api/v1/organizations/{orgId}/apps/{appId}/events` (SSE)
- `GET/POST/DELETE /api/v1/organizations/{orgId}/apps/{appId}/domains`
- `POST /api/v1/organizations/{orgId}/apps/{appId}/domains/primary`
- `GET /api/v1/organizations/{orgId}/apps/{appId}/domains/health`
- `GET/POST/DELETE /api/v1/organizations/{orgId}/apps/{appId}/environments`
- `GET/PATCH /api/v1/organizations/{orgId}/apps/{appId}/environments/{envId}`
- `POST /api/v1/organizations/{orgId}/apps/{appId}/environments/{envId}/clone`
- `POST/DELETE /api/v1/organizations/{orgId}/apps/{appId}/tags`
- `GET/POST /api/v1/organizations/{orgId}/apps/{appId}/cron`
- Backups: history, download, restore per app

**Projects:**
- `GET/POST /api/v1/organizations/{orgId}/projects`
- `GET/PATCH/DELETE /api/v1/organizations/{orgId}/projects/{projectId}`
- `GET/POST /api/v1/organizations/{orgId}/projects/{projectId}/environments`
- `GET /api/v1/organizations/{orgId}/projects/{projectId}/stats` (+ `/stream`, `/history`)

**Other:**
- `GET/POST /api/v1/organizations/{orgId}/domains`
- `GET/POST /api/v1/organizations/{orgId}/env-vars`
- `GET/POST /api/v1/organizations/{orgId}/deploy-keys`
- `GET/POST /api/v1/organizations/{orgId}/tags`
- `GET/POST /api/v1/organizations/{orgId}/invitations`
- `DELETE /api/v1/organizations/{orgId}/invitations/{invitationId}`
- `GET/PATCH /api/v1/organizations/{orgId}/notifications`
- `PATCH/DELETE /api/v1/organizations/{orgId}/notifications/{channelId}`
- `GET /api/v1/organizations/{orgId}/notifications/stream` (SSE)
- `GET/PATCH /api/v1/organizations/{orgId}/digest`
- `GET/POST /api/v1/organizations/{orgId}/transfers`
- `PATCH /api/v1/organizations/{orgId}/transfers/{transferId}`
- `GET /api/v1/organizations/{orgId}/backups` and sub-routes

### 8.8 Mesh API Routes (`app/api/v1/mesh/`)
- `POST /api/v1/mesh/join`
- `POST /api/v1/mesh/promote`
- `POST /api/v1/mesh/pull`
- `POST /api/v1/mesh/clone`
- `POST /api/v1/mesh/heartbeat`
- `POST /api/v1/mesh/sync`

### 8.9 Invitations
- `POST /api/v1/invitations/accept`

---

## 9. Templates (`templates/*.toml`)

**Available templates** (16 active + 2 disabled):

| Template | Category | Deploy Type | Source | Default Port |
|----------|----------|-------------|--------|-------------|
| `adminer` | tool | NOT FOUND | NOT FOUND | NOT FOUND |
| `fumadocs` | NOT FOUND | NOT FOUND | NOT FOUND | NOT FOUND |
| `ghost` | NOT FOUND | NOT FOUND | NOT FOUND | NOT FOUND |
| `gitea` | NOT FOUND | NOT FOUND | NOT FOUND | NOT FOUND |
| `mariadb` | NOT FOUND | NOT FOUND | NOT FOUND | NOT FOUND |
| `minio` | NOT FOUND | NOT FOUND | NOT FOUND | NOT FOUND |
| `mongo` | NOT FOUND | NOT FOUND | NOT FOUND | NOT FOUND |
| `mysql` | NOT FOUND | NOT FOUND | NOT FOUND | NOT FOUND |
| `n8n` | tool | image | direct | 5678 (`n8n.toml:10`) |
| `n8n-postgres` | NOT FOUND | NOT FOUND | NOT FOUND | NOT FOUND |
| `nginx` | NOT FOUND | NOT FOUND | NOT FOUND | NOT FOUND |
| `postgres` | database | image | direct | 5432 (`postgres.toml:10`) |
| `redis` | NOT FOUND | NOT FOUND | NOT FOUND | NOT FOUND |
| `strapi` | NOT FOUND (disabled variant exists) | NOT FOUND | NOT FOUND | NOT FOUND |
| `uptime-kuma` | NOT FOUND | NOT FOUND | NOT FOUND | NOT FOUND |
| `wordpress` | web | compose | direct | 80 (`wordpress.toml:9`) |

### 9.1 Template Format (verified from `postgres.toml` and `wordpress.toml`)

```toml
version = "1"                    # (postgres.toml:1)
name = "postgres"                # (postgres.toml:2)
displayName = "PostgreSQL"       # (postgres.toml:3)
description = "..."              # (postgres.toml:4)
icon = "https://..."             # (postgres.toml:5)
category = "database"            # (postgres.toml:6)
source = "direct"                # (postgres.toml:7)
deployType = "image"             # (postgres.toml:8)
imageName = "postgres:16"        # (postgres.toml:9)
defaultPort = 5432               # (postgres.toml:10)
diskWriteAlertThreshold = 5368709120  # optional, bytes (postgres.toml:11)

[[envVars]]                      # (postgres.toml:13-16)
key = "POSTGRES_PASSWORD"
description = "Superuser password"
required = true

[[volumes]]                      # (postgres.toml:30-32)
name = "data"
mountPath = "/var/lib/postgresql/data"
description = "PostgreSQL data files"

[[connectionInfo]]               # (postgres.toml:34-61)
label = "Host"
value = "${project.name}"
copyRef = "HOST"
```

**WordPress template** (`wordpress.toml`):
- Multi-service compose with `wordpress` + `mysql:8` services (`wordpress.toml:11-32`)
- Compose content defined inline via `composeContent` field (`wordpress.toml:11`)
- 8 env vars defined (`wordpress.toml:34-78`)
- 2 volumes: `wp-content` and `mysql-data` (`wordpress.toml:80-88`)

**n8n template** (`n8n.toml`):
- Single image deploy: `n8nio/n8n:latest` (`n8n.toml:9`)
- Optional env vars: `N8N_BASIC_AUTH_USER`, `N8N_BASIC_AUTH_PASSWORD` (`n8n.toml:12-20`)
- 1 volume: data at `/home/node/.n8n` (`n8n.toml:22-24`)

---

## 10. Rollback System (from `types.ts`)

**RollbackPreview type** (`app/(authenticated)/apps/[...slug]/types.ts:57-66`):
- `deploymentId`, `gitSha`, `gitMessage`, `deployedAt`
- `hasEnvSnapshot`, `hasConfigSnapshot`
- `configChanges`: array of `{ field, from, to }`
- `envKeyChanges`: `{ added, removed, changed }` arrays

---

## 11. Backup System

**Backup storage backends** (from `lib/backup/` file listing):
- `storage-local.ts` -- local filesystem
- `storage-s3.ts` -- S3-compatible
- `storage-ssh.ts` -- SSH/SFTP
- `storage-factory.ts` -- factory pattern

**Backup components** (from `components/backups/`):
- `backup-page.tsx` -- main page (used in both org settings and backups route)
- `backup-history.tsx` -- history list
- `app-backup-history.tsx` -- per-app backup history
- `job-card.tsx`, `job-form.tsx` -- backup job management
- `target-card.tsx`, `target-form.tsx` -- backup target management
- `auto-backup-banner.tsx` -- auto-backup status
- `next-run.tsx` -- next scheduled run display
- `retention-summary.tsx` -- retention policy summary
- `status-badge.tsx` -- backup status indicator

---

## 12. Notification System

**Components**:
- `components/notification-listener.tsx` -- real-time notifications via SSE at `/api/v1/organizations/{orgId}/notifications/stream`
- `app/(authenticated)/settings/notification-channels.tsx` -- channel management
- `app/(authenticated)/settings/digest-settings.tsx` -- digest email settings

---

## 13. Infrastructure Components

**Docker integration** (`lib/docker/`):
- `client.ts` -- Docker client
- `clone.ts` -- cloning
- `compat.ts` -- compatibility layer
- `compose-sync.ts` -- Compose file synchronization
- `deploy.ts` -- deployment engine (NOT FOUND in listing but referenced)

**Mesh networking** (`lib/mesh/`):
- `auth.ts`, `client.ts`, `index.ts`, `invite.ts`
- `bundle-schema.ts` -- schema for mesh bundles

**Cron** (`lib/cron/`):
- `engine.ts` -- cron execution engine
- `parse.ts` -- cron expression parser
- `scheduler.ts` -- job scheduler

**Digest** (`lib/digest/`):
- `collector.ts`, `scheduler.ts`, `tick.ts`

**System alerts** (`lib/system-alerts/`):
- `monitor.ts`, `state.ts`
