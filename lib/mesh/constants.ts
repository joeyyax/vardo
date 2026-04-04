// ---------------------------------------------------------------------------
// Mesh networking constants
// ---------------------------------------------------------------------------

/** Name of the Wireguard Docker container. */
export const WG_CONTAINER = process.env.VARDO_WG_CONTAINER || "vardo-wireguard";

/** IP of the frontend container on the mesh Docker network (fixed in docker-compose.yml). */
export const FRONTEND_MESH_IP = process.env.VARDO_MESH_FRONTEND_IP || "10.88.0.3";

/** Port the Vardo console listens on, used for mesh peer API URLs and iptables forwarding. */
export const CONSOLE_PORT = process.env.VARDO_CONSOLE_PORT || "3000";
