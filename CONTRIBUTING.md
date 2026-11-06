# Contributing

## Build and test

```sh
nvm use                    # Node version from .nvmrc; tests need Node 22.18 or newer (runs .ts directly)
npm install
npm test                   # every gate below, in order; CI runs the same
npm run lint               # ESLint with typescript-eslint's strict type-checked rules
npm run format             # rewrites files in Prettier style (npm test only checks)
npm run coverage:ratchet   # raises coverage-floor.json after you add tests
npm run smoke              # packs, installs the tarball into an empty folder, runs it (needs the npm registry)
npm run doctor             # live check against The Pass; needs a signed-in session
```

`npm test` runs: build, typecheck (source, tests and scripts), ESLint, Prettier check, publint (package.json), knip (unused files, exports and dependencies), then the tests with coverage held to `coverage-floor.json`.

### Coverage floor

The floor only moves up. `npm test` fails if coverage drops below it, and also if coverage rises more than 1 point above it: then run `npm run coverage:ratchet` and commit the new `coverage-floor.json` with your tests, so later changes cannot give the gain back.

The floor is checked on the Node major in `.nvmrc` only, because V8 counts coverage differently between Node majors. The coverage run executes test files one at a time, because Node's merged coverage depends on the order parallel test processes finish. On other versions the tests still run and must pass; run the ratchet on the `.nvmrc` version.

Tests never touch the network or your real session. `test/backstop.ts` (import it first in a new test file) makes any `fetch` throw and points the session folder at a temporary directory. `test/no-network-preload.ts` does the same for the server processes `test/binary.test.ts` starts.

Rule choices that differ from the presets are explained in `eslint.config.mjs`. Markdown is not run through Prettier.

Source is TypeScript in `src/`, compiled to `dist/`. [How it works](docs/how-it-works.md) lists every endpoint the server calls.

## Changes that touch the account

Never test an action tool against a real account without the account owner's say-so. Use the fake client from `makeFakeClient` in `test/harness.ts`.

## Sharing a build

```sh
npm pack          # makes pub-points-mcp-<version>.tgz
```

[Installing from a tarball](docs/configuration.md#installing-from-a-tarball) explains how the recipient uses it.

## Releasing

1. Bump `version` in `package.json` and run `npm install` to update `npm-shrinkwrap.json`.
2. Update every `github:trammel/pub-points-mcp#v<version>` in `README.md` and `docs/`. `npm test` fails until they all match `package.json`.
3. Move the `[Unreleased]` entries in `CHANGELOG.md` under the new version, and add its compare link.
4. Commit, then tag `v<version>` and push the tag. The install commands point at the tag.
