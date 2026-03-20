import { db } from "@/lib/db";
import { templates } from "@/lib/db/schema";
import { nanoid } from "nanoid";

const builtInTemplates = [
  {
    name: "postgres",
    displayName: "PostgreSQL",
    description: "Powerful open-source relational database",
    icon: "https://cdn.simpleicons.org/postgresql",
    category: "database" as const,
    source: "direct" as const,
    deployType: "image" as const,
    imageName: "postgres:16",
    defaultPort: 5432,
    defaultEnvVars: [
      { key: "POSTGRES_PASSWORD", description: "Superuser password", required: true },
      { key: "POSTGRES_USER", description: "Superuser name", required: false, defaultValue: "postgres" },
      { key: "POSTGRES_DB", description: "Default database name", required: false, defaultValue: "postgres" },
    ],
  },
  {
    name: "mysql",
    displayName: "MySQL",
    description: "Popular open-source relational database",
    icon: "https://cdn.simpleicons.org/mysql",
    category: "database" as const,
    source: "direct" as const,
    deployType: "image" as const,
    imageName: "mysql:8",
    defaultPort: 3306,
    defaultEnvVars: [
      { key: "MYSQL_ROOT_PASSWORD", description: "Root password", required: true },
      { key: "MYSQL_DATABASE", description: "Default database name", required: false },
      { key: "MYSQL_USER", description: "Additional user", required: false },
      { key: "MYSQL_PASSWORD", description: "Additional user password", required: false },
    ],
  },
  {
    name: "mariadb",
    displayName: "MariaDB",
    description: "Community-developed fork of MySQL",
    icon: "https://cdn.simpleicons.org/mariadb",
    category: "database" as const,
    source: "direct" as const,
    deployType: "image" as const,
    imageName: "mariadb:11",
    defaultPort: 3306,
    defaultEnvVars: [
      { key: "MARIADB_ROOT_PASSWORD", description: "Root password", required: true },
      { key: "MARIADB_DATABASE", description: "Default database name", required: false },
      { key: "MARIADB_USER", description: "Additional user", required: false },
      { key: "MARIADB_PASSWORD", description: "Additional user password", required: false },
    ],
  },
  {
    name: "redis",
    displayName: "Redis",
    description: "In-memory data store for caching and messaging",
    icon: "https://cdn.simpleicons.org/redis",
    category: "cache" as const,
    source: "direct" as const,
    deployType: "image" as const,
    imageName: "redis:7-alpine",
    defaultPort: 6379,
    defaultEnvVars: [
      { key: "REDIS_PASSWORD", description: "Optional password", required: false },
    ],
  },
  {
    name: "mongo",
    displayName: "MongoDB",
    description: "Document-oriented NoSQL database",
    icon: "https://cdn.simpleicons.org/mongodb",
    category: "database" as const,
    source: "direct" as const,
    deployType: "image" as const,
    imageName: "mongo:7",
    defaultPort: 27017,
    defaultEnvVars: [
      { key: "MONGO_INITDB_ROOT_USERNAME", description: "Root username", required: true },
      { key: "MONGO_INITDB_ROOT_PASSWORD", description: "Root password", required: true },
    ],
  },
  {
    name: "minio",
    displayName: "MinIO",
    description: "S3-compatible object storage",
    icon: "https://cdn.simpleicons.org/minio",
    category: "tool" as const,
    source: "direct" as const,
    deployType: "image" as const,
    imageName: "minio/minio:latest",
    defaultPort: 9000,
    defaultEnvVars: [
      { key: "MINIO_ROOT_USER", description: "Root access key", required: true },
      { key: "MINIO_ROOT_PASSWORD", description: "Root secret key", required: true },
    ],
  },
  {
    name: "adminer",
    displayName: "Adminer",
    description: "Lightweight database management UI",
    icon: null,
    category: "tool" as const,
    source: "direct" as const,
    deployType: "image" as const,
    imageName: "adminer:latest",
    defaultPort: 8080,
    defaultEnvVars: [
      { key: "ADMINER_DEFAULT_SERVER", description: "Default database server", required: false },
    ],
  },
  {
    name: "nginx",
    displayName: "Nginx",
    description: "High-performance web server and reverse proxy",
    icon: "https://cdn.simpleicons.org/nginx",
    category: "web" as const,
    source: "direct" as const,
    deployType: "image" as const,
    imageName: "nginx:alpine",
    defaultPort: 80,
    defaultEnvVars: [],
  },
  {
    name: "plausible",
    displayName: "Plausible Analytics",
    description: "Privacy-friendly web analytics",
    icon: "https://cdn.simpleicons.org/plausibleanalytics",
    category: "monitoring" as const,
    source: "git" as const,
    deployType: "compose" as const,
    gitUrl: "https://github.com/plausible/community-edition.git",
    gitBranch: "main",
    defaultPort: 8000,
    defaultEnvVars: [
      { key: "BASE_URL", description: "Public URL of your Plausible instance", required: true },
      { key: "SECRET_KEY_BASE", description: "Secret key for encryption", required: true },
    ],
  },
  {
    name: "uptime-kuma",
    displayName: "Uptime Kuma",
    description: "Self-hosted monitoring tool",
    icon: null,
    category: "monitoring" as const,
    source: "direct" as const,
    deployType: "image" as const,
    imageName: "louislam/uptime-kuma:1",
    defaultPort: 3001,
    defaultEnvVars: [],
    defaultVolumes: [
      { name: "data", mountPath: "/app/data", description: "Uptime Kuma data" },
    ],
  },
  // ── Web / App templates ──
  {
    name: "wordpress",
    displayName: "WordPress",
    description: "Popular CMS with MySQL database",
    icon: "https://cdn.simpleicons.org/wordpress",
    category: "web" as const,
    source: "direct" as const,
    deployType: "compose" as const,
    composeContent: `services:
  wordpress:
    image: wordpress:latest
    ports:
      - "80:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: \${WORDPRESS_DB_PASSWORD}
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - wp-content:/var/www/html/wp-content
  db:
    image: mysql:8
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wordpress
      MYSQL_PASSWORD: \${WORDPRESS_DB_PASSWORD}
    volumes:
      - db-data:/var/lib/mysql
volumes:
  wp-content:
  db-data:`,
    defaultPort: 80,
    defaultEnvVars: [
      { key: "WORDPRESS_DB_PASSWORD", description: "WordPress database password", required: true },
      { key: "MYSQL_ROOT_PASSWORD", description: "MySQL root password", required: true },
    ],
    defaultVolumes: [
      { name: "wp-content", mountPath: "/var/www/html/wp-content", description: "WordPress themes, plugins, and uploads" },
      { name: "db-data", mountPath: "/var/lib/mysql", description: "MySQL database files" },
    ],
  },
  {
    name: "ghost",
    displayName: "Ghost",
    description: "Professional publishing platform",
    icon: "https://cdn.simpleicons.org/ghost",
    category: "web" as const,
    source: "direct" as const,
    deployType: "image" as const,
    imageName: "ghost:5-alpine",
    defaultPort: 2368,
    defaultEnvVars: [
      { key: "url", description: "Public URL of your Ghost site", required: true },
      { key: "database__client", description: "Database client", required: false, defaultValue: "sqlite3" },
    ],
    defaultVolumes: [
      { name: "content", mountPath: "/var/lib/ghost/content", description: "Ghost content and images" },
    ],
  },
  {
    name: "nextjs",
    displayName: "Next.js",
    description: "React framework — deploy from a repo",
    icon: "https://cdn.simpleicons.org/nextdotjs",
    category: "web" as const,
    source: "git" as const,
    deployType: "nixpacks" as const,
    defaultPort: 3000,
    defaultEnvVars: [
      { key: "NODE_ENV", description: "Environment", required: false, defaultValue: "production" },
    ],
  },
  {
    name: "vite",
    displayName: "Vite / React",
    description: "Fast frontend build tool — deploy from a repo",
    icon: "https://cdn.simpleicons.org/vite",
    category: "web" as const,
    source: "git" as const,
    deployType: "nixpacks" as const,
    defaultPort: 3000,
    defaultEnvVars: [],
  },
  {
    name: "strapi",
    displayName: "Strapi",
    description: "Open-source headless CMS",
    icon: "https://cdn.simpleicons.org/strapi",
    category: "web" as const,
    source: "direct" as const,
    deployType: "image" as const,
    imageName: "strapi/strapi:latest",
    defaultPort: 1337,
    defaultEnvVars: [
      { key: "DATABASE_CLIENT", description: "Database type", required: false, defaultValue: "sqlite" },
      { key: "APP_KEYS", description: "Application keys (comma-separated)", required: true },
      { key: "API_TOKEN_SALT", description: "API token salt", required: true },
      { key: "ADMIN_JWT_SECRET", description: "Admin JWT secret", required: true },
    ],
    defaultVolumes: [
      { name: "uploads", mountPath: "/opt/app/public/uploads", description: "Media uploads" },
    ],
  },
  {
    name: "gitea",
    displayName: "Gitea",
    description: "Lightweight self-hosted Git service",
    icon: "https://cdn.simpleicons.org/gitea",
    category: "tool" as const,
    source: "direct" as const,
    deployType: "image" as const,
    imageName: "gitea/gitea:latest",
    defaultPort: 3000,
    defaultEnvVars: [],
    defaultVolumes: [
      { name: "data", mountPath: "/data", description: "Gitea repositories and config" },
    ],
  },
  {
    name: "n8n",
    displayName: "n8n",
    description: "Workflow automation tool",
    icon: "https://cdn.simpleicons.org/n8n",
    category: "tool" as const,
    source: "direct" as const,
    deployType: "image" as const,
    imageName: "n8nio/n8n:latest",
    defaultPort: 5678,
    defaultEnvVars: [
      { key: "N8N_BASIC_AUTH_USER", description: "Basic auth username", required: false },
      { key: "N8N_BASIC_AUTH_PASSWORD", description: "Basic auth password", required: false },
    ],
    defaultVolumes: [
      { name: "data", mountPath: "/home/node/.n8n", description: "n8n workflows and credentials" },
    ],
  },
];

export async function seedTemplates() {
  for (const tmpl of builtInTemplates) {
    await db
      .insert(templates)
      .values({
        id: nanoid(),
        ...tmpl,
        isBuiltIn: true,
      })
      .onConflictDoUpdate({
        target: templates.name,
        set: {
          displayName: tmpl.displayName,
          description: tmpl.description,
          icon: tmpl.icon,
          category: tmpl.category,
          source: tmpl.source,
          deployType: tmpl.deployType,
          imageName: tmpl.imageName ?? null,
          gitUrl: tmpl.gitUrl ?? null,
          gitBranch: tmpl.gitBranch ?? null,
          defaultPort: tmpl.defaultPort ?? null,
          defaultEnvVars: tmpl.defaultEnvVars,
          defaultVolumes: ((tmpl as Record<string, unknown>).defaultVolumes as { name: string; mountPath: string; description: string }[] | undefined) ?? null,
          composeContent: (tmpl as { composeContent?: string }).composeContent ?? null,
          updatedAt: new Date(),
        },
      });
  }
}
