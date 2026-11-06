# Configuration

## Adding it to your assistant

Sign in first with `npx -y github:trammel/pub-points-mcp#v0.1.0 login`. Then add the server to your client. Restart the client (or reload its MCP servers) afterwards.

**Claude Code**

```sh
claude mcp add pub-points -- npx -y github:trammel/pub-points-mcp#v0.1.0
```

**Claude Desktop** and **Cursor** use the same `mcpServers` format. Edit the file below, or open it from the app's settings (Claude Desktop: Settings → Developer → Edit Config; Cursor: Settings → MCP):

| Client | File |
|---|---|
| Claude Desktop on macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop on Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor, for every project | `~/.cursor/mcp.json` |
| Cursor, for one project | `.cursor/mcp.json` in the project |

```json
{
  "mcpServers": {
    "pub-points": {
      "command": "npx",
      "args": ["-y", "github:trammel/pub-points-mcp#v0.1.0"]
    }
  }
}
```

If the file already has an `mcpServers` object, add the `"pub-points"` entry inside it.

**VS Code** uses a different format: a top-level `servers` object, and each server needs `"type": "stdio"`. Put it in `.vscode/mcp.json` in a workspace, or in your user profile (Command Palette → "MCP: Open User Configuration"):

```json
{
  "servers": {
    "pub-points": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:trammel/pub-points-mcp#v0.1.0"]
    }
  }
}
```

For read-only mode, add `"--read-only"` to the end of `args` in any of these.

## Where the session is stored

`login` checks your password using Cognito SRP, the same method the app uses, so the password is never sent as plain text and is not stored. Only a refresh token is saved, at:

- Linux and macOS: `~/.config/pub-points-mcp/session.json` (file mode 0600, folder mode 0700)
- Windows: `%APPDATA%\pub-points-mcp\session.json`. Unix file modes do nothing on Windows, so the file is protected only by your user profile's permissions.

Set `PUB_POINTS_CONFIG_DIR` to put it somewhere else.

`logout` revokes the refresh token with Cognito, then deletes the file:

```sh
npx -y github:trammel/pub-points-mcp#v0.1.0 logout
```

## Read-only mode

To make sure nothing can be activated, redeemed or changed, start the server with `--read-only`, or set `PUB_POINTS_READ_ONLY` to `1`, `true`, `yes` or `on` in its `env`. The action tools are then not offered to the assistant at all; `pub_points_check_code` still says what a code is. The server prints which mode it is in to stderr when it starts.

```sh
claude mcp add pub-points -- npx -y github:trammel/pub-points-mcp#v0.1.0 --read-only
```

The switch is strict, so a typo cannot quietly leave the action tools on: an unknown option (such as `--readonly`), `--read-only=1`, or a `PUB_POINTS_READ_ONLY` value other than `1/true/yes/on` or `0/false/no/off` or empty stops the server with a usage error (exit code 2).

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PUB_POINTS_READ_ONLY` | off | See [read-only mode](#read-only-mode) |
| `PUB_POINTS_TIMEZONE` | `Australia/Sydney` | Time zone for date filters (`from`/`to`), month grouping, shown dates, and the UTC offset sent to The Pass |
| `PUB_POINTS_CONFIG_DIR` | see [above](#where-the-session-is-stored) | Where the session file lives |
| `THEPASS_EMAIL`, `THEPASS_PASSWORD` | unset | Sign in without `login`; see [below](#machines-with-no-interactive-sign-in) |
| `THEPASS_API_URL` | `https://api.prod.v1.avc.eonx.com` | API base URL, for testing against another deployment. Must start with `https://`, since every request carries your ID token; anything else stops the server at startup |

## Machines with no interactive sign-in

> [!WARNING]
> This stores your password in plain text in the MCP client's config file. Use `login` wherever you can.

For a machine with no interactive sign-in, such as CI or a container, you can set `THEPASS_EMAIL` and `THEPASS_PASSWORD` in the server's `env`. The server then signs in by itself whenever it has no session or the refresh token has expired.

## Installing from a tarball

Someone can send you a release as `pub-points-mcp-<version>.tgz` (made with `npm pack`; see [CONTRIBUTING](../CONTRIBUTING.md)). Use it in place of the `github:` spec:

```sh
npx -y --package=/path/to/pub-points-mcp-<version>.tgz pub-points-mcp login
```

In your MCP client, the command is `npx -y --package=/path/to/pub-points-mcp-<version>.tgz pub-points-mcp`. Or run `npm install -g` on the tarball once and use `pub-points-mcp` as the command.

## Commands

| Command | What it does |
|---|---|
| `serve [--read-only]` | Runs the MCP server on stdio. The default when no command is given; this is what MCP clients launch |
| `login` | Signs in once and stores a refresh token |
| `status` | Prints your points summary in the terminal |
| `doctor` | Checks the API still matches what the tools expect; see [troubleshooting](troubleshooting.md) |
| `logout` | Revokes and deletes the stored session |
| `--help`, `--version` | Usage, and the package version |

Exit codes: 0 success, 1 failure (including a failed `doctor` check), 2 usage or configuration error, 130 interrupted.
