/**
 * Detect app type, icon, and brand color from app metadata.
 * Single source of truth for type-based styling across the UI.
 */

type AppTypeInfo = {
  type: string;
  icon: string | null;
  color: string; // hex color
};

const APP_TYPES: { pattern: RegExp; type: string; icon: string | null; color: string }[] = [
  { pattern: /postgres/i, type: "postgresql", icon: "https://cdn.simpleicons.org/postgresql/4169E1", color: "#4169E1" },
  { pattern: /mysql/i, type: "mysql", icon: "https://cdn.simpleicons.org/mysql/4479A1", color: "#4479A1" },
  { pattern: /mariadb/i, type: "mariadb", icon: "https://cdn.simpleicons.org/mariadb/BA7257", color: "#BA7257" },
  { pattern: /redis/i, type: "redis", icon: "https://cdn.simpleicons.org/redis/FF4438", color: "#FF4438" },
  { pattern: /mongo/i, type: "mongodb", icon: "https://cdn.simpleicons.org/mongodb/47A248", color: "#47A248" },
  { pattern: /nginx/i, type: "nginx", icon: "https://cdn.simpleicons.org/nginx/009639", color: "#009639" },
  { pattern: /traefik/i, type: "traefik", icon: "https://cdn.simpleicons.org/traefikproxy/24A1C1", color: "#24A1C1" },
  { pattern: /next/i, type: "nextjs", icon: "https://cdn.simpleicons.org/nextdotjs/FFFFFF", color: "#FFFFFF" },
  { pattern: /nuxt/i, type: "nuxt", icon: "https://cdn.simpleicons.org/nuxtdotjs/00DC82", color: "#00DC82" },
  { pattern: /node/i, type: "node", icon: "https://cdn.simpleicons.org/nodedotjs/5FA04E", color: "#5FA04E" },
  { pattern: /python|django|flask|fastapi/i, type: "python", icon: "https://cdn.simpleicons.org/python/3776AB", color: "#3776AB" },
  { pattern: /ruby|rails/i, type: "ruby", icon: "https://cdn.simpleicons.org/ruby/CC342D", color: "#CC342D" },
  { pattern: /go|golang/i, type: "go", icon: "https://cdn.simpleicons.org/go/00ADD8", color: "#00ADD8" },
  { pattern: /rust/i, type: "rust", icon: "https://cdn.simpleicons.org/rust/DEA584", color: "#DEA584" },
  { pattern: /wordpress/i, type: "wordpress", icon: "https://cdn.simpleicons.org/wordpress/21759B", color: "#21759B" },
  { pattern: /ghost/i, type: "ghost", icon: "https://cdn.simpleicons.org/ghost/15171A", color: "#8B949E" },
  { pattern: /strapi/i, type: "strapi", icon: "https://cdn.simpleicons.org/strapi/4945FF", color: "#4945FF" },
  { pattern: /minio/i, type: "minio", icon: "https://cdn.simpleicons.org/minio/C72E49", color: "#C72E49" },
  { pattern: /grafana/i, type: "grafana", icon: "https://cdn.simpleicons.org/grafana/F46800", color: "#F46800" },
  { pattern: /prometheus/i, type: "prometheus", icon: "https://cdn.simpleicons.org/prometheus/E6522C", color: "#E6522C" },
  { pattern: /gitea/i, type: "gitea", icon: "https://cdn.simpleicons.org/gitea/609926", color: "#609926" },
  { pattern: /n8n/i, type: "n8n", icon: "https://cdn.simpleicons.org/n8n/EA4B71", color: "#EA4B71" },
  { pattern: /plausible/i, type: "plausible", icon: "https://cdn.simpleicons.org/plausibleanalytics/5850EC", color: "#5850EC" },
  { pattern: /uptime.?kuma/i, type: "uptimekuma", icon: "https://cdn.simpleicons.org/uptimekuma/5CDD8B", color: "#5CDD8B" },
  { pattern: /caddy/i, type: "caddy", icon: "https://cdn.simpleicons.org/caddy/1F88C0", color: "#1F88C0" },
  { pattern: /vite|react/i, type: "react", icon: "https://cdn.simpleicons.org/vite/646CFF", color: "#646CFF" },
];

const FALLBACK: AppTypeInfo = { type: "unknown", icon: null, color: "#a1a1aa" }; // zinc-400

/**
 * Detect app type, icon URL, and brand color from app metadata.
 * Falls back to project color if provided, otherwise zinc-400.
 */
export function detectAppType(opts: {
  imageName?: string | null;
  gitUrl?: string | null;
  deployType?: string | null;
  name?: string | null;
  displayName?: string | null;
  templateName?: string | null;
}, fallbackColor?: string): AppTypeInfo {
  const haystack = [opts.imageName, opts.gitUrl, opts.deployType, opts.name, opts.displayName, opts.templateName]
    .filter(Boolean)
    .join(" ");

  for (const entry of APP_TYPES) {
    if (entry.pattern.test(haystack)) {
      return { type: entry.type, icon: entry.icon, color: entry.color };
    }
  }

  // GitHub repo
  if (opts.gitUrl?.includes("github.com")) {
    return { type: "github", icon: "https://cdn.simpleicons.org/github/8B949E", color: fallbackColor || "#8B949E" };
  }

  // Docker generic
  if (opts.deployType === "compose" || opts.deployType === "image") {
    return { type: "docker", icon: "https://cdn.simpleicons.org/docker/2496ED", color: fallbackColor || "#2496ED" };
  }

  return { ...FALLBACK, color: fallbackColor || FALLBACK.color };
}
