/**
 * Auto-detect a project icon URL based on image name, deploy type, or git URL.
 */

const IMAGE_ICONS: [RegExp, string | null][] = [
  [/postgres/i, "https://cdn.simpleicons.org/postgresql/4169E1"],
  [/mysql/i, "https://cdn.simpleicons.org/mysql/4479A1"],
  [/mariadb/i, "https://cdn.simpleicons.org/mariadb/BA7257"],
  [/redis/i, "https://cdn.simpleicons.org/redis/FF4438"],
  [/mongo/i, "https://cdn.simpleicons.org/mongodb/47A248"],
  [/nginx/i, "https://cdn.simpleicons.org/nginx/009639"],
  [/traefik/i, "https://cdn.simpleicons.org/traefikproxy/24A1C1"],
  [/node|next|nuxt/i, "https://cdn.simpleicons.org/nodedotjs/5FA04E"],
  [/python|django|flask|fastapi/i, "https://cdn.simpleicons.org/python/3776AB"],
  [/ruby|rails/i, "https://cdn.simpleicons.org/ruby/CC342D"],
  [/go|golang/i, "https://cdn.simpleicons.org/go/00ADD8"],
  [/rust/i, "https://cdn.simpleicons.org/rust/DEA584"],
  [/wordpress/i, "https://cdn.simpleicons.org/wordpress/21759B"],
  [/ghost/i, "https://cdn.simpleicons.org/ghost/15171A"],
  [/strapi/i, "https://cdn.simpleicons.org/strapi/4945FF"],
  [/minio/i, "https://cdn.simpleicons.org/minio/C72E49"],
  [/grafana/i, "https://cdn.simpleicons.org/grafana/F46800"],
  [/prometheus/i, "https://cdn.simpleicons.org/prometheus/E6522C"],
  [/gitea/i, "https://cdn.simpleicons.org/gitea/609926"],
  [/n8n/i, "https://cdn.simpleicons.org/n8n/EA4B71"],
  [/plausible/i, "https://cdn.simpleicons.org/plausibleanalytics/5850EC"],
  [/uptime.?kuma/i, "https://cdn.simpleicons.org/uptimekuma/5CDD8B"],
  [/adminer/i, null],
  [/caddy/i, "https://cdn.simpleicons.org/caddy/1F88C0"],
  [/vite|react/i, "https://cdn.simpleicons.org/vite/646CFF"],
];

export function detectProjectIcon(opts: {
  imageName?: string | null;
  gitUrl?: string | null;
  deployType?: string | null;
  name?: string | null;
  displayName?: string | null;
}): string | null {
  const haystack = [opts.imageName, opts.gitUrl, opts.deployType, opts.name, opts.displayName]
    .filter(Boolean)
    .join(" ");

  for (const [pattern, icon] of IMAGE_ICONS) {
    if (pattern.test(haystack) && icon) return icon;
  }

  // GitHub repo — use GitHub icon
  if (opts.gitUrl?.includes("github.com")) {
    return "https://cdn.simpleicons.org/github/8B949E";
  }

  // Docker compose/image generic
  if (opts.deployType === "compose" || opts.deployType === "image") {
    return "https://cdn.simpleicons.org/docker/2496ED";
  }

  return null;
}
