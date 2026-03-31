import type { SecurityFinding } from "./types";

type PortRule = {
  ports: number[];
  severity: SecurityFinding["severity"];
  title: string;
  description: string;
};

/**
 * Ports that should never be publicly exposed.
 * Grouped by category for clear messaging.
 */
const PORT_RULES: PortRule[] = [
  {
    ports: [5432, 5433],
    severity: "critical",
    title: "PostgreSQL port publicly exposed",
    description:
      "Port 5432/5433 (PostgreSQL) is mapped to the host. Database ports should not be publicly accessible.",
  },
  {
    ports: [3306, 3307],
    severity: "critical",
    title: "MySQL/MariaDB port publicly exposed",
    description:
      "Port 3306/3307 (MySQL/MariaDB) is mapped to the host. Database ports should not be publicly accessible.",
  },
  {
    ports: [6379, 6380],
    severity: "critical",
    title: "Redis port publicly exposed",
    description:
      "Port 6379/6380 (Redis) is mapped to the host. Redis has no authentication by default and should not be publicly accessible.",
  },
  {
    ports: [27017, 27018, 27019],
    severity: "critical",
    title: "MongoDB port publicly exposed",
    description:
      "Port 27017-27019 (MongoDB) is mapped to the host. Database ports should not be publicly accessible.",
  },
  {
    ports: [5984],
    severity: "critical",
    title: "CouchDB port publicly exposed",
    description:
      "Port 5984 (CouchDB) is mapped to the host. Database ports should not be publicly accessible.",
  },
  {
    ports: [9200, 9300],
    severity: "critical",
    title: "Elasticsearch port publicly exposed",
    description:
      "Port 9200/9300 (Elasticsearch) is mapped to the host. Elasticsearch has no authentication by default and should not be publicly accessible.",
  },
  {
    ports: [5672, 15672],
    severity: "warning",
    title: "RabbitMQ port publicly exposed",
    description:
      "Port 5672/15672 (RabbitMQ) is mapped to the host. Message broker ports should be kept internal.",
  },
  {
    ports: [2375, 2376],
    severity: "critical",
    title: "Docker daemon port publicly exposed",
    description:
      "Port 2375/2376 (Docker daemon) is mapped to the host. This grants full control of the host. Remove this immediately.",
  },
  {
    ports: [9000],
    severity: "warning",
    title: "Debug/admin port publicly exposed",
    description:
      "Port 9000 is mapped to the host. If this is a debugger or admin panel, it should not be publicly accessible.",
  },
  {
    ports: [5900],
    severity: "warning",
    title: "VNC port publicly exposed",
    description:
      "Port 5900 (VNC) is mapped to the host. Remote desktop access should not be publicly accessible.",
  },
  {
    ports: [22],
    severity: "warning",
    title: "SSH port publicly exposed via container",
    description:
      "Port 22 (SSH) is mapped to the host from a container. Ensure this is intentional and properly secured.",
  },
];

const portMap = new Map<number, PortRule>();
for (const rule of PORT_RULES) {
  for (const port of rule.ports) {
    portMap.set(port, rule);
  }
}

type ExposedPort = {
  internal: number;
  external?: number;
};

/**
 * Check an app's exposed port configuration for sensitive or dangerous ports.
 * This is a static check against the configured port mappings — no active scanning.
 */
export function checkExposedPorts(exposedPorts: ExposedPort[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const reported = new Set<string>();

  for (const { internal } of exposedPorts) {
    const rule = portMap.get(internal);
    if (!rule) continue;

    // Deduplicate by title in case multiple ports match the same rule
    if (reported.has(rule.title)) continue;
    reported.add(rule.title);

    findings.push({
      type: "exposed-port",
      severity: rule.severity,
      title: rule.title,
      description: rule.description,
      detail: String(internal),
    });
  }

  return findings;
}
