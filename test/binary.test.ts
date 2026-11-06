// SPDX-License-Identifier: GPL-3.0-or-later
// dist/index.js end to end: read-only wiring (§2), server instructions (§3), https enforcement
// (§9) and logout (§9). Review findings 1, 5, 7 and 15 (instructions).
//
// Every process is started as `node --import test/no-network-preload.ts dist/index.js …` with
// an isolated environment: no THEPASS_* or PUB_POINTS_* values from the shell, and
// PUB_POINTS_CONFIG_DIR at a fresh directory under os.tmpdir(). The preload replaces fetch, logs
// every call to a file, and answers only Cognito RevokeToken. No tool is ever called.
//
// Seams assumed beyond §11: none in src/. The preload is the test's own seam.

import './backstop.ts'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { TestContext } from 'node:test'
import { ACTION_TOOLS, nth, present } from './harness.ts'

/** One fetch the preload logged: see test/no-network-preload.ts. */
interface FetchEntry {
  url: string
  target: string | null
  body: string | null
}

type Sandbox = ReturnType<typeof sandbox>

function fetchEntry(line: string): FetchEntry {
  const value: unknown = JSON.parse(line)
  if (
    typeof value !== 'object' ||
    value === null ||
    !('url' in value) ||
    typeof value.url !== 'string' ||
    !('target' in value) ||
    (typeof value.target !== 'string' && value.target !== null) ||
    !('body' in value) ||
    (typeof value.body !== 'string' && value.body !== null)
  )
    throw new TypeError(`not a fetch log entry: ${line}`)
  return { url: value.url, target: value.target, body: value.body }
}

const INDEX = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const PRELOAD = new URL('./no-network-preload.ts', import.meta.url).href

function sandbox(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `ppm-binary-${process.pid}-`))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('THEPASS_') && !key.startsWith('PUB_POINTS_')) env[key] = value
  }
  const log = join(dir, 'fetch.log')
  writeFileSync(log, '')
  return {
    dir,
    log,
    env: { ...env, PUB_POINTS_CONFIG_DIR: dir, PPM_FETCH_LOG: log, ...extra },
    fetches: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(fetchEntry),
  }
}

function run(args: string[], box: Sandbox) {
  return spawnSync(process.execPath, ['--import', PRELOAD, INDEX, ...args], { env: box.env, input: '', encoding: 'utf8', timeout: 15_000 })
}

async function startServer(t: TestContext, args: string[], box: Sandbox) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', PRELOAD, INDEX, ...args],
    env: box.env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'binary-test', version: '0.0.0' })
  await client.connect(transport)
  t.after(() => client.close())
  return client
}

// ---- finding 1: read-only is wired through to the served tools ----

describe('serve over stdio (§2)', () => {
  const READ_ONLY_STARTS: [string, string[], Record<string, string>][] = [
    ['--read-only', ['--read-only'], {}],
    ['PUB_POINTS_READ_ONLY=1', [], { PUB_POINTS_READ_ONLY: '1' }],
    ['serve --read-only', ['serve', '--read-only'], {}],
  ]
  for (const [label, args, extra] of READ_ONLY_STARTS) {
    test(`${label}: tools/list returns 21 tools and no action tool`, async (t) => {
      const box = sandbox(extra)
      const client = await startServer(t, args, box)
      const { tools } = await client.listTools()
      const names = tools.map((tool) => tool.name)
      assert.equal(names.length, 21, names.join(', '))
      for (const action of ACTION_TOOLS) assert.ok(!names.includes(action), action)
      assert.deepEqual(box.fetches(), [])
    })
  }

  test('no flag and PUB_POINTS_READ_ONLY=0: tools/list returns 29 tools', async (t) => {
    const box = sandbox({ PUB_POINTS_READ_ONLY: '0' })
    const client = await startServer(t, [], box)
    const { tools } = await client.listTools()
    assert.equal(tools.length, 29)
    assert.deepEqual(box.fetches(), [])
  })

  // ---- finding 15: server instructions describe the confirmation model ----

  test('read-write instructions describe confirmation tokens and never confirm: true', async (t) => {
    const box = sandbox()
    const client = await startServer(t, [], box)
    const instructions = client.getInstructions() ?? ''
    assert.ok(instructions.includes('confirmationToken'), instructions)
    assert.ok(instructions.includes('may have been applied'), instructions)
    assert.doesNotMatch(instructions, /confirm\s*[:=]\s*true/)
    assert.ok(instructions.includes('npx -y github:trammel/pub-points-mcp#v0.1.0 login'), instructions)
  })

  test('read-only instructions say the server cannot change the account', async (t) => {
    const box = sandbox()
    const client = await startServer(t, ['--read-only'], box)
    const instructions = client.getInstructions() ?? ''
    assert.match(instructions, /read-only/)
    assert.ok(!instructions.includes('confirmationToken'), instructions)
  })
})

// ---- finding 5: THEPASS_API_URL must be https ----

describe('THEPASS_API_URL (§9)', () => {
  for (const command of ['status', 'serve', 'doctor']) {
    test(`${command} with an http:// URL exits 2 before any request`, () => {
      const box = sandbox({ THEPASS_API_URL: 'http://api.example.test' })
      writeFileSync(
        join(box.dir, 'session.json'),
        JSON.stringify({ email: 'member@example.com', refreshToken: 'refresh-fake-1', savedAt: '2026-11-05T00:00:00.000Z' })
      )
      const r = run([command], box)
      assert.equal(r.status, 2, `status ${r.status}; stderr: ${r.stderr}`)
      assert.match(r.stderr, /https:\/\//)
      assert.deepEqual(box.fetches(), [])
    })
  }

  test('an https:// URL is accepted (control)', () => {
    const box = sandbox({ THEPASS_API_URL: 'https://api.example.test' })
    const r = run(['status'], box)
    assert.notEqual(r.status, 2, r.stderr)
  })
})

// ---- finding 7: logout revokes, then deletes the file whatever the revoke did ----

describe('logout (§9)', () => {
  const SESSION = { email: 'member@example.com', refreshToken: 'refresh-fake-logout', savedAt: '2026-11-05T00:00:00.000Z' }

  function withSession(revoke: string) {
    const box = sandbox({ PPM_REVOKE: revoke })
    writeFileSync(join(box.dir, 'session.json'), JSON.stringify(SESSION), { mode: 0o600 })
    return box
  }

  function revokeCalls(box: Sandbox) {
    return box.fetches().filter((f) => f.target === 'AWSCognitoIdentityProviderService.RevokeToken')
  }

  test('a successful revoke sends ClientId and the refresh token, then deletes the file', () => {
    const box = withSession('ok')
    const r = run(['logout'], box)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(existsSync(join(box.dir, 'session.json')), false)
    const calls = revokeCalls(box)
    assert.equal(calls.length, 1)
    assert.deepEqual(JSON.parse(present(nth(calls, 0).body, 'body')), {
      ClientId: '51j5rt0ebmti4ddud4jn0rt8j6',
      Token: 'refresh-fake-logout',
    })
    assert.ok(!r.stderr.includes('could not revoke'), r.stderr)
    assert.equal(box.fetches().length, 1)
  })

  const REVOKE_FAILURES: [string, string][] = [
    ['fail', 'Refresh Token has been revoked'],
    ['throw', 'fetch failed'],
  ]
  for (const [revoke, reason] of REVOKE_FAILURES) {
    test(`a revoke that ${revoke === 'fail' ? 'is refused' : 'cannot connect'} is reported, and the file is still deleted`, () => {
      const box = withSession(revoke)
      const r = run(['logout'], box)
      assert.equal(r.status, 0, r.stderr)
      assert.equal(existsSync(join(box.dir, 'session.json')), false)
      const warning = r.stderr.split('\n').find((l) => l.includes('could not revoke'))
      assert.ok(warning?.includes(reason), r.stderr)
      assert.equal(revokeCalls(box).length, 1)
    })
  }

  test('no session: nothing to revoke, exits 0', () => {
    const box = sandbox({ PPM_REVOKE: 'ok' })
    const r = run(['logout'], box)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(box.fetches(), [])
  })

  test('a corrupt session file is reported and deleted without a revoke', () => {
    const box = sandbox({ PPM_REVOKE: 'ok' })
    writeFileSync(join(box.dir, 'session.json'), '{not json')
    const r = run(['logout'], box)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(existsSync(join(box.dir, 'session.json')), false)
    assert.match(r.stderr, /not valid JSON/)
    assert.deepEqual(box.fetches(), [])
  })
})
