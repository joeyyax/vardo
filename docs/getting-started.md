# Getting Started

## First Login and Account Creation

When you visit your Vardo dashboard for the first time, you will be redirected to the onboarding flow at `/onboarding`. This is a three-step process:

1. **Create your account** — Enter your name, email, and password (minimum 8 characters). The first account created is automatically promoted to app admin. If you sign in via GitHub OAuth instead, this step is skipped.
2. **Connect GitHub** (optional) — Install the Vardo GitHub App on your GitHub account or organization. This enables deploying directly from repositories and receiving webhook-triggered auto-deploys. You can skip this and configure it later in Settings.
3. **Create an organization** — Organizations are the top-level container for all your projects and apps. Enter a name and Vardo generates a URL-safe slug automatically.

After onboarding, you are taken to the Projects page where you can start deploying.

### Authentication Methods

Vardo supports multiple authentication methods:

- **Email and password** — Standard credentials with a minimum 8-character password. Can be disabled via the `passwordAuth` feature flag.
- **GitHub OAuth** — Sign in with your GitHub account. Linked automatically if the email matches.
- **Magic link** — Passwordless sign-in via email (requires an email provider to be configured).
- **Passkeys** — WebAuthn/FIDO2 hardware key or biometric authentication.
- **Two-factor authentication** — TOTP-based 2FA with backup codes, configurable per user.

## Creating Your First Project

Projects are logical groups of related apps. For example, a "Blog" project might contain a Ghost app and a MySQL database.

1. Navigate to **Projects** in the sidebar.
2. Click **New Project**.
3. Enter a display name and optional description. Vardo auto-generates a URL-safe name from the display name.
4. Click **Create**.

You can also assign a color to each project for visual organization.

## Deploying from a Template

Templates are the quickest way to deploy common services. Vardo ships with built-in templates for:

| Category | Templates |
|----------|-----------|
| Database | PostgreSQL, MySQL, MariaDB, MongoDB |
| Cache | Redis |
| Web | Nginx, Ghost |
| Tool | Adminer, MinIO, n8n, Uptime Kuma |
| Source Control | Gitea |

To deploy from a template:

1. Go to your project and click **New App**.
2. Select a template from the list.
3. Review the pre-filled configuration — image name, default port, volumes, and environment variables. Fill in any required variables (e.g. `POSTGRES_PASSWORD`).
4. Click **Create**, then **Deploy**.

Templates automatically configure persistent volumes, connection info, and sensible defaults. You can customize any value before or after deployment.

## Deploying from GitHub

To deploy from a GitHub repository, you first need a GitHub App connected to Vardo. If you did not set this up during onboarding, go to **Settings** and configure the GitHub App credentials.

1. Go to your project and click **New App**.
2. Choose **Git** as the source.
3. Select a repository and branch from your connected GitHub installations, or paste an HTTPS git URL.
4. Choose a deploy type:
   - **Compose** — the repository contains a `docker-compose.yml` (or a custom compose file path).
   - **Dockerfile** — the repository contains a `Dockerfile` to build.
   - **Nixpacks** — auto-detects the language and builds without a Dockerfile.
   - **Static** — serves static files.
5. Optionally set a root directory if the app is in a subdirectory of the repo.
6. Set the container port if the app exposes an HTTP service.
7. Enable **Auto deploy** to trigger a redeploy on every push to the configured branch.
8. Click **Create**, then **Deploy**.

When auto-deploy is enabled, Vardo receives GitHub webhook push events and automatically deploys matching apps. Pull request events can create and destroy preview environments.

## Deploying from a Docker Image

1. Go to your project and click **New App**.
2. Choose **Direct** as the source and **Image** as the deploy type.
3. Enter the Docker image name (e.g. `nginx:latest`, `ghcr.io/org/repo:tag`).
4. Set the container port if the app serves HTTP traffic.
5. Add environment variables, persistent volumes, and exposed ports as needed.
6. Click **Create**, then **Deploy**.

## Custom Domains

Every app gets an auto-generated subdomain on your base domain (e.g. `myapp.example.com`). To use a custom domain:

1. Open the app's detail page and go to the **Domains** tab.
2. Click **Add Domain** and enter your custom domain (e.g. `blog.mydomain.com`).
3. Create a DNS record pointing the domain to your server's IP address.
4. Vardo will automatically provision a TLS certificate via Let's Encrypt.

You can set any domain as the primary domain, which controls which domain is used for routing by default. Health checks run automatically against configured domains to verify reachability.

## Next Steps

- Read [Concepts](concepts.md) to understand how projects, apps, environments, and deployments work together.
- See [Configuration](configuration.md) for environment variables, feature flags, and `vardo.yml` config as code.
- Check the [API Reference](api.md) to automate deployments and integrate with CI/CD.
- See [Installation](installation.md) if you haven't set up your server yet.
