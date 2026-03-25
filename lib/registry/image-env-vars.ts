/**
 * Static registry mapping common Docker images to their expected environment variables.
 */

export interface ImageEnvVar {
  key: string;
  description: string;
  required: boolean;
  defaultValue?: string;
}

export interface ImageRegistryEntry {
  pattern: RegExp;
  displayName: string;
  description: string;
  defaultPort: number;
  envVars: ImageEnvVar[];
}

export const imageRegistry: ImageRegistryEntry[] = [
  {
    pattern: /^postgres$/,
    displayName: "PostgreSQL",
    description: "Open-source relational database",
    defaultPort: 5432,
    envVars: [
      {
        key: "POSTGRES_PASSWORD",
        description: "Superuser password",
        required: true,
      },
      {
        key: "POSTGRES_USER",
        description: "Superuser username",
        required: false,
        defaultValue: "postgres",
      },
      {
        key: "POSTGRES_DB",
        description: "Default database name",
        required: false,
        defaultValue: "postgres",
      },
    ],
  },
  {
    pattern: /^mysql$/,
    displayName: "MySQL",
    description: "Open-source relational database",
    defaultPort: 3306,
    envVars: [
      {
        key: "MYSQL_ROOT_PASSWORD",
        description: "Root user password",
        required: true,
      },
      {
        key: "MYSQL_DATABASE",
        description: "Database to create on startup",
        required: false,
      },
      {
        key: "MYSQL_USER",
        description: "Additional user to create",
        required: false,
      },
      {
        key: "MYSQL_PASSWORD",
        description: "Password for the additional user",
        required: false,
      },
    ],
  },
  {
    pattern: /^mariadb$/,
    displayName: "MariaDB",
    description: "Community-developed fork of MySQL",
    defaultPort: 3306,
    envVars: [
      {
        key: "MARIADB_ROOT_PASSWORD",
        description: "Root user password",
        required: true,
      },
      {
        key: "MARIADB_DATABASE",
        description: "Database to create on startup",
        required: false,
      },
      {
        key: "MARIADB_USER",
        description: "Additional user to create",
        required: false,
      },
      {
        key: "MARIADB_PASSWORD",
        description: "Password for the additional user",
        required: false,
      },
    ],
  },
  {
    pattern: /^redis$/,
    displayName: "Redis",
    description: "In-memory data structure store",
    defaultPort: 6379,
    envVars: [
      {
        key: "REDIS_PASSWORD",
        description: "Server authentication password",
        required: false,
      },
    ],
  },
  {
    pattern: /^mongo$/,
    displayName: "MongoDB",
    description: "Document-oriented NoSQL database",
    defaultPort: 27017,
    envVars: [
      {
        key: "MONGO_INITDB_ROOT_USERNAME",
        description: "Root username",
        required: false,
      },
      {
        key: "MONGO_INITDB_ROOT_PASSWORD",
        description: "Root password",
        required: false,
      },
    ],
  },
  {
    pattern: /^minio/,
    displayName: "MinIO",
    description: "S3-compatible object storage",
    defaultPort: 9000,
    envVars: [
      {
        key: "MINIO_ROOT_USER",
        description: "Root access key",
        required: true,
      },
      {
        key: "MINIO_ROOT_PASSWORD",
        description: "Root secret key",
        required: true,
      },
    ],
  },
  {
    pattern: /^adminer$/,
    displayName: "Adminer",
    description: "Database management web UI",
    defaultPort: 8080,
    envVars: [
      {
        key: "ADMINER_DEFAULT_SERVER",
        description: "Default database server to connect to",
        required: false,
      },
    ],
  },
  {
    pattern: /^mailhog/,
    displayName: "Mailhog",
    description: "Email testing tool with SMTP and web UI",
    defaultPort: 8025,
    envVars: [],
  },
  {
    pattern: /^traefik$/,
    displayName: "Traefik",
    description: "Cloud-native reverse proxy and load balancer",
    defaultPort: 80,
    envVars: [],
  },
  {
    pattern: /^nginx$/,
    displayName: "Nginx",
    description: "High-performance HTTP server and reverse proxy",
    defaultPort: 80,
    envVars: [],
  },
];

export function findImageEnvVars(
  imageName: string
): ImageRegistryEntry | null {
  const name = imageName.split(":")[0].split("/").pop() ?? "";
  return imageRegistry.find((entry) => entry.pattern.test(name)) ?? null;
}
