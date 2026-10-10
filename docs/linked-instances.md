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

## Auto deploy without a public webhook

A GitHub App sends its webhooks to one URL. The instance at that URL relays each push and pull request event to every linked instance that accepts relays from it, so an instance GitHub can't reach still deploys on push. Any instance can relay and any can receive, public or private. A poller covers whatever a relay misses.

### Turn it on

1. **On the instance GitHub reaches:** set the GitHub App's webhook URL to its `/api/v1/github/webhook`, and install the App on every repo the other instances deploy.
2. **On each instance that should receive:** an instance admin, signed in, opens **Admin settings → Instances**, picks the sending peer's menu and chooses **Accept relayed webhooks**. The next heartbeat, or the toggle itself, tells the sender.
3. **Optional:** bind the sending peer to an organization on the receiver. Relays then deploy only that organization's apps; unbound, they reach every organization.

### How a relay runs

1. The instance GitHub reaches checks GitHub's signature, handles its own apps, then relays the event after it answers GitHub.
2. The relay goes to every directly linked peer that accepts relays from it, all at once. Each peer gets 2 seconds for the tunnel probe and 10 seconds for the call, so a slow or offline peer can't hold up the rest.
3. The event names the event type, repo, clone URLs, branch and ref, head SHA, delivery id and, for a pull request, its number, action, head repo and author. It also carries GitHub's raw body and `X-Hub-Signature-256` when the body is under 256 KB. It never carries code, commit messages, credentials or commands.
4. It's sent with the peer's bearer token and an HMAC signature over the method, path, body hash, timestamp and a nonce, over the tunnel when it answers, else the peer's HTTPS public URL.
5. The receiver checks the signature, the clock window, the nonce and **Accept relayed webhooks**. When it holds the same webhook secret and the relay carries GitHub's body, it re-verifies GitHub's signature and refuses a summary that disagrees.
6. It matches its own apps exactly as a direct webhook would: auto deploy on, same repo, same configured branch. Pull requests create or tear down previews, and fork PRs are refused. Each deploy fetches from the git host with the receiver's own credentials.

Each instance handles a GitHub delivery id once, for an hour, whether it arrives from GitHub or a relay. GitHub's **Redeliver** reuses the id, so a redelivery inside that hour is skipped.

A relayed event is handled locally and never relayed again, so relays can't loop or multiply across the mesh. Peers seen only through a hub don't get relays: link them directly to the instance GitHub reaches. Hub-forwarding would add a second hop and extend trust to an instance the receiver never paired with.

Both sides record each relay. The sender logs "relayed a GitHub webhook to a linked instance" in the organizations its GitHub installation is linked to. The receiver logs "received a relayed GitHub webhook" on each app it deploys. **Admin settings → Instances** shows each peer's last relay in each direction and its result.

### Polling

Every instance also polls. Every 5 minutes by default, it runs `git ls-remote` on the branch of each auto-deploy git app and deploys a head it hasn't seen. Set the interval, or turn it off, under **Admin settings → General → Auto deploy**.

- It uses the app's GitHub App token, deploy key or stored credentials, passed through env and never argv.
- It checks up to 25 due apps a minute, three at a time.
- It skips parked and stopped apps, apps with a deploy queued or running, and heads any deploy already carries.
- It doesn't retry a head that failed; the next push retries.
- It records the first head it sees for an app with no deploy history as a baseline instead of deploying it.
- It backs off a git host that errors, doubling from the interval up to an hour.
- It runs a full pass 90 seconds after the console starts and 30 seconds after the link to a peer comes back.

The app's **Settings** page lists the triggers that apply to it (webhook, relay and poll) and when it was last checked for changes.
