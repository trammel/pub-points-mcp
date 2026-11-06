# Troubleshooting

## Tools fail with missing fields or unexpected responses

The Pass can change its API without notice. Run:

```sh
npx -y github:trammel/pub-points-mcp#v0.1.0 doctor
```

It checks whether The Pass still accepts the client version this server targets (12.11.8), using The Pass's update-check endpoint. Then it calls each endpoint group through the same code the tools use, and names any field the tools rely on that has gone missing or changed type. A failed check exits with code 1. The same check is available to the assistant as `pub_points_doctor`.

Include the `doctor` output when you [open an issue](https://github.com/trammel/pub-points-mcp/issues).

## "Not signed in"

Run `login` in a terminal, not through the assistant:

```sh
npx -y github:trammel/pub-points-mcp#v0.1.0 login
```

Then check it with `status`. The MCP server reads the same session file, so it needs no restart.

## Google and Apple accounts

If you joined The Pass with "Continue with Google" or "Continue with Apple", The Pass accepts only that sign-in for your email, and it returns to the app rather than to this tool. `login` says so when it sees such an account. There is no workaround in this server.

## The session file can't be read

A session file that exists but cannot be read or parsed is reported as an error, not treated as signed out, so a broken file is never silently replaced. Fix its permissions, or run `logout` and then `login`.

## The server won't start

Exit code 2 means a usage or configuration error: an unknown option, a bad `PUB_POINTS_READ_ONLY` value, or a `THEPASS_API_URL` that isn't `https://`. The message on stderr names which. See [configuration](configuration.md).

## An action "may have been applied"

The write timed out or failed with a network or server error, so its outcome is unknown. Check with the read tool the message names before trying again. See [confirmations](confirmations.md#when-the-outcome-is-unknown).
