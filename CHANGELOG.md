# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-06

First release.

### Added

- Sign-in with The Pass email and password (Cognito SRP); only a refresh token is stored, written atomically with 0600 permissions in a 0700 folder. A session file that cannot be read or parsed is reported, not treated as signed out.
- `login`, `status`, `doctor` and `logout` commands. `logout` revokes the refresh token with Cognito before deleting the file. Every hint names the pinned install spec, `npx -y github:trammel/pub-points-mcp#v0.1.0 <command>`.
- Read tools: points summary, all discounts, points rewards, credit, account activity, spending summary, orders, order receipts, tiers, referral code and program rules, home-screen promotions, offers by status, offer details with venues, group discounts with their venues, favourite venues, venue search with open-now status and opening hours, profile, communication preferences, code check and health check. Offers, orders, venue search and rewards also return `structuredContent` with an `outputSchema`.
- Spending totals come from every completed order in the range, filtered by the API. Activity reads back to the requested start date, up to 2,000 records, and says when it stopped short.
- Action tools: activate offer, redeem points for credit, redeem a code, join an organisation, claim the birthday gift, add or remove a favourite venue, change communication preferences. Each checks the request against account state first, then confirms the exact action with the user: through MCP elicitation when the client supports it (a question that times out or fails cancels the action), otherwise with a single-use `confirmationToken` that expires after 5 minutes and is bound to the tool, its arguments and the values the check found (such as the reward's cost or the venue).
- A write that may or may not have gone through (timeout, network error, HTTP 5xx) is reported as "may have been applied", naming the read tool to check with. A failed balance read after a successful write no longer turns the result into an error.
- Read-only mode (`--read-only` or `PUB_POINTS_READ_ONLY=1`), which leaves every action tool out. Unknown options and unrecognised `PUB_POINTS_READ_ONLY` values stop the server with exit code 2. The server prints its mode on startup.
- `doctor` command and `pub_points_doctor` tool: checks The Pass still accepts the client version this server targets, and checks each endpoint group still returns the fields the tools read, through the same response schemas the tools use.
- Every request times out after 15 seconds and is cancelled when the MCP client cancels the tool call. Responses are validated; errors show the API's message and HTTP status, never a raw response body.
- `PUB_POINTS_TIMEZONE` (default `Australia/Sydney`) for date filters, month grouping and the UTC offset sent to the API. `THEPASS_API_URL` must be `https://`.
- A clear sign-in error for accounts linked to Google or Apple, which The Pass does not allow to sign in with a password.

### Development

- ESLint (typescript-eslint strict, type-checked) and Prettier, both run by `npm test`.
- Tests are TypeScript, type-checked and linted with the same rules as the source, so a fixture that doesn't match the real types fails to compile.
- Coverage floor that only moves up (`coverage-floor.json`, raised with `npm run coverage:ratchet`), at 95.7% of lines after a test backfill of the read tools (626 tests).
- knip (unused files, exports and dependencies), publint (package.json), and a smoke test that installs the packed tarball and runs it.
- GitHub Actions CI on Node 22 and 24, with `npm audit` of runtime dependencies; Dependabot for npm and Actions updates.

[Unreleased]: https://github.com/trammel/pub-points-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/trammel/pub-points-mcp/releases/tag/v0.1.0
