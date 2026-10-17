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

/** Container running the mesh SSH endpoint for linked instances' builds. */
export const MESH_SSH_CONTAINER = process.env.VARDO_MESH_SSH_CONTAINER || "vardo-mesh-ssh";

/** Port the mesh SSH endpoint answers on, on the tunnel address and inside its container. */
export const MESH_SSH_PORT = process.env.VARDO_MESH_SSH_PORT || "22";

/** The only user the mesh SSH endpoint lets in. */
export const MESH_SSH_USER = "vardo";
