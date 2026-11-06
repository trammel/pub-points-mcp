// SPDX-License-Identifier: GPL-3.0-or-later
// Session file and logout revoke: review-fix-contract.md §9; review findings 6 and 7.
//
// Seams used: saveSession/loadSession/sessionPath read PUB_POINTS_CONFIG_DIR on each call, so
// each test points it at its own directory under os.tmpdir(). revokeRefreshToken takes a fetch
// as its third argument (auth.ts), which is the fetch seam this file uses; no other seam assumed.
// The end-to-end logout (revoke, then delete the file) is in binary.test.ts.
//
// The fake Cognito RevokeToken refuses a body without ClientId or Token
// (InvalidParameterException, HTTP 400), as the real one does.

import { TEST_CONFIG_DIR, TEST_XDG_CONFIG_HOME } from './backstop.ts'
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthError, loadSession, revokeRefreshToken, saveSession, sessionPath } from '../dist/auth.js'
import { field, nth, present, prop, thrownText } from './harness.ts'

/** One RevokeToken request the fake Cognito received. */
interface CognitoCall {
  url: string
  target: string | null
  body: unknown
}

const POSIX = process.platform !== 'win32'
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const SESSION = { email: 'member@example.com', refreshToken: 'refresh-fake-session', savedAt: '2026-11-05T00:00:00.000Z' }

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), `ppm-session-${process.pid}-`))
  process.env.PUB_POINTS_CONFIG_DIR = dir
  return dir
}

afterEach(() => {
  process.env.PUB_POINTS_CONFIG_DIR = TEST_CONFIG_DIR
  process.env.XDG_CONFIG_HOME = TEST_XDG_CONFIG_HOME
})

const mode = (path: string) => statSync(path).mode & 0o777

describe('saveSession (§9)', () => {
  test('writes the session where sessionPath says, and loadSession reads it back', async () => {
    const dir = freshDir()
    await saveSession(SESSION)
    assert.equal(sessionPath(), join(dir, 'session.json'))
    assert.deepEqual(await loadSession(), SESSION)
  })

  test('the file is 0600 and the directory 0700', { skip: !POSIX }, async () => {
    const dir = join(freshDir(), 'nested')
    process.env.PUB_POINTS_CONFIG_DIR = dir
    await saveSession(SESSION)
    assert.equal(mode(dir), 0o700)
    assert.equal(mode(join(dir, 'session.json')), 0o600)
  })

  // A folder that already exists may be one the user owns for other things (PUB_POINTS_CONFIG_DIR=$HOME),
  // so only a folder saveSession creates is tightened; the session file itself is 0600 either way.
  test('an existing 0755 folder is left at 0755, and the session file is still 0600', { skip: !POSIX }, async () => {
    const dir = freshDir()
    chmodSync(dir, 0o755)
    await saveSession(SESSION)
    assert.equal(mode(dir), 0o755)
    assert.equal(mode(join(dir, 'session.json')), 0o600)
  })

  test('a folder saveSession creates ends up 0700, even under a 0022 umask', { skip: !POSIX }, async () => {
    const dir = join(freshDir(), 'pub-points-mcp')
    process.env.PUB_POINTS_CONFIG_DIR = dir
    const previous = process.umask(0o022)
    try {
      await saveSession(SESSION)
    } finally {
      process.umask(previous)
    }
    assert.equal(mode(dir), 0o700)
  })

  // N2: the default folder (no PUB_POINTS_CONFIG_DIR) is this tool's own, so it is always 0700.
  // XDG_CONFIG_HOME points at a fresh temporary folder, never the real ~/.config.
  function defaultFolder() {
    const xdg = mkdtempSync(join(tmpdir(), `ppm-xdg-${process.pid}-`))
    chmodSync(xdg, 0o755)
    delete process.env.PUB_POINTS_CONFIG_DIR
    process.env.XDG_CONFIG_HOME = xdg
    return { xdg, dir: join(xdg, 'pub-points-mcp') }
  }

  test('the default folder that already exists at 0755 is tightened to 0700; its parent is not touched', { skip: !POSIX }, async () => {
    const { xdg, dir } = defaultFolder()
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    await saveSession(SESSION)
    assert.equal(sessionPath(), join(dir, 'session.json'))
    assert.equal(mode(dir), 0o700)
    assert.equal(mode(xdg), 0o755)
    assert.equal(mode(join(dir, 'session.json')), 0o600)
  })

  test('the default folder, when missing, is created at 0700', { skip: !POSIX }, async () => {
    const { xdg, dir } = defaultFolder()
    await saveSession(SESSION)
    assert.equal(mode(dir), 0o700)
    assert.equal(mode(xdg), 0o755)
  })

  test('replaces the file by rename (a new inode), leaving no temporary file', { skip: !POSIX }, async () => {
    const dir = freshDir()
    await saveSession(SESSION)
    const before = statSync(join(dir, 'session.json')).ino
    await saveSession({ ...SESSION, refreshToken: 'refresh-fake-rotated' })
    assert.notEqual(statSync(join(dir, 'session.json')).ino, before)
    const saved: unknown = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'))
    assert.equal(field(saved, 'refreshToken'), 'refresh-fake-rotated')
    assert.deepEqual(readdirSync(dir), ['session.json'])
  })

  test('a failed rename throws and leaves no temporary file behind', async () => {
    const dir = freshDir()
    mkdirSync(join(dir, 'session.json'))
    writeFileSync(join(dir, 'session.json', 'keep'), 'x')
    await assert.rejects(saveSession(SESSION))
    assert.deepEqual(readdirSync(dir), ['session.json'])
  })
})

describe('loadSession (§9)', () => {
  test('no file: null', async () => {
    freshDir()
    assert.equal(await loadSession(), null)
  })

  test('corrupt JSON: AuthError naming the file', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'session.json'), '{"email": "member@example.com", "refreshTok')
    await assert.rejects(loadSession(), (err) => {
      assert.ok(err instanceof AuthError, thrownText(err))
      assert.ok(err.message.includes(join(dir, 'session.json')), err.message)
      return true
    })
  })

  test('JSON without a refresh token: AuthError', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ email: 'member@example.com', savedAt: SESSION.savedAt }))
    await assert.rejects(loadSession(), AuthError)
  })

  test('a directory where the file should be: AuthError, not null', async () => {
    const dir = freshDir()
    mkdirSync(join(dir, 'session.json'))
    await assert.rejects(loadSession(), AuthError)
  })

  test('an unreadable file: AuthError, not null', { skip: !POSIX || IS_ROOT }, async () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'session.json'), JSON.stringify(SESSION))
    chmodSync(join(dir, 'session.json'), 0o000)
    await assert.rejects(loadSession(), AuthError)
  })
})

// ---- finding 7: RevokeToken ----

function fakeCognito(answer: () => Response) {
  const calls: CognitoCall[] = []
  return {
    calls,
    fetch: (url: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
      new Promise((resolve) => {
        resolve(answerRequest(url, init))
      }),
  }

  function answerRequest(url: string | URL | Request, init: RequestInit): Response {
    const headers = new Headers(init.headers)
    if (typeof init.body !== 'string') throw new TypeError('RevokeToken body must be a JSON string')
    const body: unknown = JSON.parse(init.body)
    calls.push({ url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, target: headers.get('X-Amz-Target'), body })
    if (headers.get('X-Amz-Target') !== 'AWSCognitoIdentityProviderService.RevokeToken') {
      return new Response(JSON.stringify({ __type: 'UnknownOperationException', message: 'Unknown operation' }), { status: 400 })
    }
    if (!prop(body, 'ClientId') || !prop(body, 'Token')) {
      return new Response(JSON.stringify({ __type: 'InvalidParameterException', message: 'Missing ClientId or Token' }), { status: 400 })
    }
    return answer()
  }
}

describe('revokeRefreshToken (§9)', () => {
  test('sends RevokeToken to Cognito with the public client id and the refresh token only', async () => {
    const cognito = fakeCognito(() => new Response('{}', { status: 200 }))
    const failure = await revokeRefreshToken(SESSION, new AbortController().signal, cognito.fetch)
    assert.equal(failure, null)
    assert.equal(cognito.calls.length, 1)
    const call = nth(cognito.calls, 0)
    assert.equal(new URL(call.url).host, 'cognito-idp.ap-southeast-2.amazonaws.com')
    assert.deepEqual(call.body, { ClientId: '51j5rt0ebmti4ddud4jn0rt8j6', Token: 'refresh-fake-session' })
  })

  test('a refusal is returned as a reason, not thrown', async () => {
    const cognito = fakeCognito(
      () => new Response(JSON.stringify({ __type: 'NotAuthorizedException', message: 'Refresh Token has been revoked' }), { status: 400 })
    )
    const failure = await revokeRefreshToken(SESSION, new AbortController().signal, cognito.fetch)
    assert.equal(typeof failure, 'string')
    const reason = present(failure, 'failure')
    assert.ok(reason.includes('Refresh Token has been revoked') || reason.includes('NotAuthorizedException'), reason)
  })

  test('a network error is returned as a reason, not thrown', async () => {
    const failure = await revokeRefreshToken(SESSION, new AbortController().signal, () => Promise.reject(new TypeError('fetch failed')))
    assert.ok(typeof failure === 'string' && failure.includes('fetch failed'), String(failure))
  })
})
