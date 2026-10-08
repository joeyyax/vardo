// Preloaded into the server: stamps each request with its TCP peer, replacing any client-sent value (#889).
import http from "node:http";

const NAME = "x-vardo-peer";
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, ...rest) {
  if (event === "request" && req && req.headers) {
    const peer = (req.socket && req.socket.remoteAddress) || "";
    req.headers[NAME] = peer;
    const raw = req.rawHeaders || [];
    for (let i = raw.length - 2; i >= 0; i -= 2) {
      if (String(raw[i]).toLowerCase() === NAME) raw.splice(i, 2);
    }
    raw.push(NAME, peer);
  }
  return emit.call(this, event, req, ...rest);
};
