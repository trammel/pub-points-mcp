// SPDX-License-Identifier: GPL-3.0-or-later
// Network and session backstop for every test process. Import it FIRST, before anything from
// dist/: dist/config.js reads THEPASS_API_URL and PUB_POINTS_TIMEZONE when it loads.
//
// - globalThis.fetch records the URL and throws, so code that ignores an injected client or
//   fetch fails the test instead of reaching The Pass, Cognito or Algolia.
// - PUB_POINTS_CONFIG_DIR points at a fresh directory under os.tmpdir(), so no test can read or
//   write the real session file. The directory is left behind on purpose (no recursive deletes).
// - Credentials and mode switches are removed from the environment, so nothing can fall back to
//   a password sign-in or pick up a read-only setting from the shell.
//
// node --test also loads this file on its own (it sits under test/); it declares no tests.

import { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const key of Object.keys(process.env)) {
  if (key.startsWith('THEPASS_') || key.startsWith('PUB_POINTS_')) Reflect.deleteProperty(process.env, key)
}
export const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), `ppm-test-${process.pid}-`))
process.env.PUB_POINTS_CONFIG_DIR = TEST_CONFIG_DIR
// The default folder (used when PUB_POINTS_CONFIG_DIR is unset) lives under XDG_CONFIG_HOME, so
// point that at the temporary folder too; a test that unsets PUB_POINTS_CONFIG_DIR never reaches ~/.config.
export const TEST_XDG_CONFIG_HOME = join(TEST_CONFIG_DIR, 'xdg')
process.env.XDG_CONFIG_HOME = TEST_XDG_CONFIG_HOME

/** Every URL anything in this process tried to fetch through the global fetch. */
const blockedFetchCalls: string[] = []

globalThis.fetch = (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  blockedFetchCalls.push(url)
  return Promise.reject(new TypeError(`network disabled in tests: ${url}`))
}

after(() => {
  assert.deepEqual(blockedFetchCalls, [], 'code under test called globalThis.fetch instead of an injected fake')
})
