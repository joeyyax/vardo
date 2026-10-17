import { HUB_IP } from "./ip-allocator";

/** Name of the Wireguard Docker container. */
export const WG_CONTAINER = process.env.VARDO_WG_CONTAINER || "vardo-wireguard";

/** Console mesh IP used when the live console's can't be found: the legacy fixed address. */
export const FRONTEND_MESH_IP = process.env.VARDO_MESH_FRONTEND_IP || "10.88.0.3";

/** The WireGuard container's address on the mesh Docker network. */
export const MESH_GATEWAY_IP = process.env.WIREGUARD_GATEWAY || "10.88.0.2";

/** Compose service running the console in the self-app's slots. */
export const CONSOLE_SERVICE = "frontend";

/** Port the Vardo console listens on, used for mesh peer API URLs and iptables forwarding. */
export const CONSOLE_PORT = process.env.VARDO_CONSOLE_PORT || "3000";

/** Container running the isolated BuildKit that linked instances' builds run in. */
export const MESH_BUILDER_CONTAINER = process.env.VARDO_MESH_BUILDER_CONTAINER || "vardo-mesh-builder";

/** Port the mesh builder answers on, on the tunnel address and inside its container. */
export const MESH_BUILDER_PORT = process.env.VARDO_MESH_BUILDER_PORT || "1234";

/** The name the builder's server certificate carries and clients verify. */
export const MESH_BUILDER_SERVER_NAME = "vardo-mesh-builder";

/** The builder's TLS files, inside its cache volume. */
export const MESH_BUILDER_TLS_DIR = "/home/user/.local/share/buildkit/vardo-tls";

/** The WireGuard tunnel subnet. */
export const MESH_SUBNET = `${HUB_IP.split(".").slice(0, 3).join(".")}.0/24`;
