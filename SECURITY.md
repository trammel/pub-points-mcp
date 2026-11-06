# Security

## Reporting a problem

Report security problems privately through [GitHub's private vulnerability reporting](https://github.com/trammel/pub-points-mcp/security/advisories/new), not in a public issue.

## What this server stores and sends

- **Stored:** a Cognito refresh token, in a session file readable only by you (see [configuration](docs/configuration.md#where-the-session-is-stored)). Not your password, unless you put `THEPASS_PASSWORD` in your MCP client's config.
- **Sent:** requests to AWS Cognito, The Pass API and Algolia only (listed in [how it works](docs/how-it-works.md)). `THEPASS_API_URL` must be `https://`.
- **Shown to the assistant:** your account data, including name, email, mobile, date of birth and the last four digits of your preferred card. Your MCP client may send this to its model provider.

## Account changes

Action tools confirm each change with you before sending it ([confirmations](docs/confirmations.md)). Run with `--read-only` to remove them.
