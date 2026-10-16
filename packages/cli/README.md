# vardo

Runs a Vardo console's MCP tools from the command line. Each tool is a command: `vardo_deploy_app` is `vardo deploy-app`. The commands come from the console at run time, so new tools show up without a new release.

## Install

```bash
npx vardo --help
# or
npm i -g vardo
```

Needs Node 22 or later.

## Log in

Create an API token in the console at `/user/settings/tokens`. A token sees the tools its scope allows; `doctor` needs the admin scope. Then:

```bash
vardo login vardo.example.com
```

The token is read from a hidden prompt, or from stdin when it's piped:

```bash
op read op://vault/vardo/token | vardo login vardo.example.com
```

Instances are saved in `~/.config/vardo/config.json`, readable by you only. The first one you log in to is the default.

```bash
vardo instances               # list saved instances
vardo use homelab             # change the default
vardo --use homelab list-apps # run against another one once
vardo logout homelab
```

`VARDO_URL` and `VARDO_TOKEN` override the saved instance, for CI.

## Examples

```bash
vardo doctor
vardo doctor --instance jy0                  # a linked instance
vardo list-apps --limit 10
vardo list-apps --json | jq '.apps[].name'
vardo deploy-app --app-id abc123
vardo set-env-vars --app-id abc123 --content @.env.production
op read op://vault/app/env | vardo set-env-vars --app-id abc123 --content -
vardo update-domain --app-id abc123 --domain-id d1 --redirect-to null
vardo deploy-app --help                      # a command's flags
```

Flags come from each tool's input schema: `appId` is `--app-id`, booleans are switches (`--no-enabled` turns one off), arrays repeat or take a comma list and objects take JSON. Any flag that takes text also takes `@path` to read a file or `-` to read stdin, so secrets stay out of your shell history.

## Output and exit codes

Commands print the tool's text. `--json` prints the structured result instead.

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | The tool returned an error or the console couldn't be reached |
| 2 | The command was typed wrong or there's no instance to talk to |
