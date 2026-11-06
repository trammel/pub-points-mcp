// SPDX-License-Identifier: GPL-3.0-or-later
// CLI parsing and startup: review-fix-contract.md §2; test item 2.
//
// Seams assumed beyond §11:
// - parseCli([], {}) returns command 'serve' (no positional = serve, as the existing usage text
//   says). The contract lists 'serve' in the union but does not state the default.
// - The process tests run `node dist/index.js` with PUB_POINTS_CONFIG_DIR pointed at an empty
//   temporary directory, no THEPASS_* credentials, and THEPASS_API_URL at a closed local port,
//   so nothing can reach the live API. No tool is ever called.

import './backstop.ts'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { thrownText } from './harness.ts'

const INDEX = fileURLToPath(new URL('../dist/index.js', import.meta.url))
// Every started binary gets the no-network preload, as in binary.test.ts.
const PRELOAD = new URL('./no-network-preload.ts', import.meta.url).href
const EMPTY_CONFIG_DIR = mkdtempSync(join(tmpdir(), `ppm-cli-test-${process.pid}-`))

async function cli() {
  try {
    return await import('../dist/cli.js')
  } catch (err) {
    throw new Error(`dist/cli.js must export parseCli and UsageError (contract §2): ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    })
  }
}

async function assertUsageError(fn: () => unknown, messageIncludes: string[] = []) {
  const { UsageError } = await cli()
  assert.throws(fn, (err) => {
    assert.ok(err instanceof UsageError, `expected UsageError, got ${thrownText(err)}`)
    for (const s of messageIncludes) assert.ok(err.message.includes(s), `"${err.message}" should mention ${s}`)
    return true
  })
}

describe('parseCli flags and commands', () => {
  test('no arguments: serve, read-write', async () => {
    const { parseCli } = await cli()
    assert.deepEqual(parseCli([], {}), { command: 'serve', readOnly: false })
  })

  test('--read-only sets readOnly', async () => {
    const { parseCli } = await cli()
    assert.deepEqual(parseCli(['--read-only'], {}), { command: 'serve', readOnly: true })
    assert.deepEqual(parseCli(['serve', '--read-only'], {}), { command: 'serve', readOnly: true })
  })

  for (const command of ['serve', 'login', 'status', 'doctor', 'logout']) {
    test(`positional ${command} selects that command`, async () => {
      const { parseCli } = await cli()
      assert.equal(parseCli([command], {}).command, command)
    })
  }

  const HELP_AND_VERSION: [[string], string][] = [
    [['--help'], 'help'],
    [['-h'], 'help'],
    [['--version'], 'version'],
    [['-v'], 'version'],
  ]
  for (const [argv, command] of HELP_AND_VERSION) {
    test(`${argv[0]} selects ${command}`, async () => {
      const { parseCli } = await cli()
      assert.equal(parseCli(argv, {}).command, command)
    })
  }

  const BAD_ARGV = [
    ['--readonly'],
    ['--read-only=1'],
    ['--read-only=true'],
    ['-x'],
    ['--Read-Only'],
    ['serv'],
    ['serve', 'login'],
    ['status', 'extra'],
  ]
  for (const argv of BAD_ARGV) {
    test(`${JSON.stringify(argv)} throws UsageError`, async () => {
      const { parseCli } = await cli()
      await assertUsageError(() => parseCli(argv, {}))
    })
  }
})

describe('PUB_POINTS_READ_ONLY', () => {
  const TRUTHY = ['1', 'true', 'yes', 'on', 'TRUE', 'Yes', 'ON', ' on ', '\ttrue\n']
  const FALSY = ['0', 'false', 'no', 'off', 'FALSE', 'No', ' off ', '', '   ']
  const INVALID = ['y', 'maybe', 'n', '2', 'enabled', 'true1', 'o n']

  for (const value of TRUTHY) {
    test(`${JSON.stringify(value)} -> read-only`, async () => {
      const { parseCli } = await cli()
      assert.equal(parseCli([], { PUB_POINTS_READ_ONLY: value }).readOnly, true)
    })
  }

  for (const value of FALSY) {
    test(`${JSON.stringify(value)} -> read-write`, async () => {
      const { parseCli } = await cli()
      assert.equal(parseCli([], { PUB_POINTS_READ_ONLY: value }).readOnly, false)
    })
  }

  test('unset -> read-write', async () => {
    const { parseCli } = await cli()
    assert.equal(parseCli([], { PUB_POINTS_READ_ONLY: undefined }).readOnly, false)
    assert.equal(parseCli([], { OTHER: '1' }).readOnly, false)
  })

  for (const value of INVALID) {
    test(`${JSON.stringify(value)} throws UsageError naming the variable and allowed values`, async () => {
      const { parseCli } = await cli()
      await assertUsageError(() => parseCli([], { PUB_POINTS_READ_ONLY: value }), ['PUB_POINTS_READ_ONLY', 'true', 'false'])
    })
  }

  test('--read-only wins over a falsy value', async () => {
    const { parseCli } = await cli()
    assert.equal(parseCli(['--read-only'], { PUB_POINTS_READ_ONLY: '0' }).readOnly, true)
  })

  test('parseCli reads the env it is given, not process.env', async () => {
    const { parseCli } = await cli()
    const saved = process.env.PUB_POINTS_READ_ONLY
    process.env.PUB_POINTS_READ_ONLY = '1'
    try {
      assert.equal(parseCli([], {}).readOnly, false)
    } finally {
      if (saved === undefined) delete process.env.PUB_POINTS_READ_ONLY
      else process.env.PUB_POINTS_READ_ONLY = saved
    }
  })
})

// ---- the binary ----

function isolatedEnv(extra: Record<string, string> = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('THEPASS_') && !key.startsWith('PUB_POINTS_'))
  )
  return {
    ...env,
    PUB_POINTS_CONFIG_DIR: EMPTY_CONFIG_DIR,
    THEPASS_API_URL: 'https://127.0.0.1:9',
    ...extra,
  }
}

/**
 * Runs serve until `line` appears on stderr (or 10 s pass), then stops it the way an MCP client does: close stdin and
 * wait for the process to exit, with SIGTERM only if it is still running 5 s later. Resolves once the child has exited,
 * so its coverage is always written and counted (a killed child's coverage is lost at random).
 */
function serveUntil(args: string[], env: Record<string, string | undefined>, line: string) {
  return new Promise<{ stderr: string; code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const child = spawn(process.execPath, ['--import', PRELOAD, INDEX, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    let killTimer: NodeJS.Timeout | undefined
    const stop = () => {
      clearTimeout(startTimer)
      child.stdin.end()
      killTimer ??= setTimeout(() => child.kill('SIGTERM'), 5_000)
    }
    const startTimer = setTimeout(stop, 10_000)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.includes(line)) stop()
    })
    child.on('exit', (code, signal) => {
      clearTimeout(startTimer)
      clearTimeout(killTimer)
      resolve({ stderr, code, signal })
    })
  })
}

/** A stdio MCP server must exit cleanly once its client closes stdin, without needing a signal. */
function assertExitedOnStdinClose(code: number | null, signal: NodeJS.Signals | null, stderr: string) {
  assert.equal(signal, null, `serve was still running 5 s after stdin closed and had to be killed. stderr:\n${stderr}`)
  assert.equal(code, 0, stderr)
}

describe('index.js', () => {
  const BAD_STARTS: [string, string[], Record<string, string>, string[]][] = [
    ['unknown flag --readonly', ['--readonly'], {}, ['Usage']],
    ['--read-only=1', ['--read-only=1'], {}, ['Usage']],
    ['unknown command', ['serv'], {}, ['Usage']],
    ['invalid PUB_POINTS_READ_ONLY', [], { PUB_POINTS_READ_ONLY: 'maybe' }, ['PUB_POINTS_READ_ONLY', 'Usage']],
  ]
  for (const [label, args, extra, mentions] of BAD_STARTS) {
    test(`${label}: exits 2 with the message and usage on stderr`, () => {
      const r = spawnSync(process.execPath, ['--import', PRELOAD, INDEX, ...args], {
        env: isolatedEnv(extra),
        input: '',
        encoding: 'utf8',
        timeout: 10_000,
      })
      assert.equal(r.status, 2, `status ${String(r.status)} signal ${String(r.signal)}; stderr: ${r.stderr}`)
      for (const s of mentions) assert.ok(r.stderr.includes(s), `stderr should mention ${s}: ${r.stderr}`)
    })
  }

  test('serve --read-only logs read-only mode on startup', async () => {
    const line = 'pub-points-mcp: read-only mode (action tools disabled)'
    const { stderr, code, signal } = await serveUntil(['--read-only'], isolatedEnv(), line)
    assert.ok(stderr.includes(line), stderr)
    assertExitedOnStdinClose(code, signal, stderr)
  })

  test('PUB_POINTS_READ_ONLY=1 logs read-only mode on startup', async () => {
    const line = 'pub-points-mcp: read-only mode (action tools disabled)'
    const { stderr, code, signal } = await serveUntil([], isolatedEnv({ PUB_POINTS_READ_ONLY: '1' }), line)
    assert.ok(stderr.includes(line), stderr)
    assertExitedOnStdinClose(code, signal, stderr)
  })

  test('serve logs read-write mode on startup', async () => {
    const line = 'pub-points-mcp: read-write mode (action tools need confirmation)'
    const { stderr, code, signal } = await serveUntil([], isolatedEnv(), line)
    assert.ok(stderr.includes(line), stderr)
    assert.ok(!stderr.includes('read-only mode'), stderr)
    assertExitedOnStdinClose(code, signal, stderr)
  })

  test('serve exits by itself when the client closes stdin', async () => {
    const { code, signal, stderr } = await serveUntil([], isolatedEnv(), 'pub-points-mcp: read-write mode')
    assertExitedOnStdinClose(code, signal, stderr)
  })
})
