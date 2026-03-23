export {
  generateKeypair,
  buildWgConfig,
  writeWgConfig,
  syncConfig,
  isWireguardRunning,
  getWgStatus,
} from "./wireguard";
export type { WgPeer } from "./wireguard";
export { allocateIp, HUB_IP } from "./ip-allocator";
