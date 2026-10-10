# Linked instances

Linked instances are Vardo consoles paired over the mesh (`lib/mesh/`). Each pair shares a WireGuard tunnel and a bearer token in each direction. Admins manage them under **Admin settings → Instances**.

## One MCP connection for every instance

One MCP client entry, pointed at any instance's `/api/mcp`, can run tools on every instance linked to it.

### Turn it on

1. **On the instance you connect to:** an instance admin, signed in, opens **User settings → API tokens** and turns on **Linked instances** for their token. A token can't grant this to itself or another token.
2. **On each instance it should reach:** an instance admin, signed in, opens **Admin settings → Instances**, picks the calling peer's menu and chooses **Accept MCP calls**. Without this the peer refuses every forwarded call.
3. **On each instance it should reach:** the same person needs an account with the same verified email. Calls run as that account.

### Use it

- `vardo_list_instances` lists this instance and its directly linked peers: name, URL, type, canary role, version, health and status.
- Every other tool takes an optional `instance`: a name or id from that list. Leave it out to run here.
- Results carry an `instance` field naming where they ran and how (`tunnel` or `public`).

```json
{ "name": "vardo_list_apps", "arguments": { "instance": "prod", "limit": 10 } }
```

### How a call runs elsewhere

1. The console resolves `instance` to a directly linked peer. Peers seen only through a hub are refused.
2. It POSTs the tool name, arguments, the caller's verified email and the token's scope to the peer's `/api/v1/mesh/mcp-call`. The request carries the peer's bearer token and an HMAC signature over the method, path, body hash, timestamp and a nonce.
3. It sends over the tunnel when a quick probe answers, else over the peer's public URL, only if that's HTTPS. A call is never sent twice.
4. The peer checks the signature, the 60-second clock window and the nonce, then **Accept MCP calls**. It maps the email to a verified local user and runs the same tool handler under the forwarded scope, intersected with that user's role there.

Forwarded calls land in the organization the peer is bound to. A token with **All my organizations** reaches every organization the mapped user belongs to there. The instance-admin scope applies there only while the mapped user is an instance admin there too. A forwarded call can't be forwarded again.

Both sides record the call in the activity log: "ran an MCP tool on a linked instance" on the origin, and "ran an MCP tool from a linked instance via {peer}" on the target.

### Trust

**Accept MCP calls** trusts the calling instance to vouch for who's calling. If that instance is compromised, it can act here as any user with a verified email, up to that user's role. Turn it on only for instances you trust as much as this one.
