// SPDX-License-Identifier: GPL-3.0-or-later
// Token refresh and the 401 retry: review-fix-contract.md §9 (refresh save failure) and the §11
// TokenProvider/PubPointsClient seams; test item 10.
//
// Seams used (§11): new TokenProvider({ fetch, loadSession, saveSession }) and
// new PubPointsClient(tokens, { fetch }). Beyond §11, this file assumes nothing.
//
// No network: test/backstop.ts replaces globalThis.fetch with a function that records the call
// and throws, removes THEPASS_EMAIL/THEPASS_PASSWORD, and points PUB_POINTS_CONFIG_DIR at a
// temporary directory, before dist/ loads.
//
// The fake Cognito refuses what InitiateAuth refuses on the paths used here (AWS Cognito API
// reference, InitiateAuth errors): an unknown X-Amz-Target (UnknownOperationException), a body
// without ClientId or AuthFlow (InvalidParameterException) and a refresh token it did not issue
// (NotAuthorizedException), each as HTTP 400 with `__type` and `message`.

import './backstop.ts'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { TokenProvider } from '../dist/auth.js'
import { PubPointsClient, ApiError } from '../dist/api.js'
import type { StoredSession, TokenProviderDeps } from '../dist/auth.js'
import { messageOf, nth, prop, thrownText, urlText } from './harness.ts'

/** A canned answer for one API call, by call order. */
type ApiResponder = (net: FakeNetwork) => Response

interface FakeNetwork {
  cognitoCalls: { target: string | null; body: unknown }[]
  apiCalls: { url: string; authorization: string | null; method: string }[]
  /** Every ID token Cognito issued, in order. */
  tokens: string[]
  fetch: typeof fetch
}

const COGNITO_HOST = 'cognito-idp.ap-southeast-2.amazonaws.com'
const SESSION: StoredSession = { email: 'member@example.com', refreshToken: 'refresh-fake-1', savedAt: '2026-11-01T00:00:00.000Z' }

function fakeJwt(name: string, expSeconds = Math.floor(Date.now() / 1000) + 3600) {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: name, exp: expSeconds })}.fakesig`
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * A fake network: Cognito InitiateAuth issues id-1, id-2, ... in order (after a short delay, so
 * concurrent callers overlap); the API accepts only the tokens in `api.accept`.
 */
function fakeNetwork({ rotateRefreshToken = false, apiResponses }: { rotateRefreshToken?: boolean; apiResponses?: ApiResponder[] } = {}) {
  const cognitoCalls: FakeNetwork['cognitoCalls'] = []
  const apiCalls: FakeNetwork['apiCalls'] = []
  let issued = 0
  const validRefresh = new Set([SESSION.refreshToken])
  const net: FakeNetwork = {
    cognitoCalls,
    apiCalls,
    tokens: [],
    fetch: async (url, init = {}) => {
      const u = new URL(urlText(url))
      const headers = new Headers(init.headers)
      if (u.host === COGNITO_HOST) {
        cognitoCalls.push({ target: headers.get('X-Amz-Target'), body: init.body })
        await new Promise((r) => setTimeout(r, 20))
        if (headers.get('X-Amz-Target') !== 'AWSCognitoIdentityProviderService.InitiateAuth') {
          return json(400, { __type: 'UnknownOperationException', message: 'Unknown operation' })
        }
        const body: unknown = JSON.parse(typeof init.body === 'string' ? init.body : '')
        if (!prop(body, 'ClientId') || !prop(body, 'AuthFlow'))
          return json(400, { __type: 'InvalidParameterException', message: 'Missing parameter' })
        const refreshToken = prop(prop(body, 'AuthParameters'), 'REFRESH_TOKEN')
        if (prop(body, 'AuthFlow') !== 'REFRESH_TOKEN_AUTH' || typeof refreshToken !== 'string' || !validRefresh.has(refreshToken)) {
          return json(400, { __type: 'NotAuthorizedException', message: 'Invalid Refresh Token' })
        }
        issued += 1
        const token = fakeJwt(`id-${issued}`)
        net.tokens.push(token)
        const result: { IdToken: string; ExpiresIn: number; TokenType: string; RefreshToken?: string } = {
          IdToken: token,
          ExpiresIn: 3600,
          TokenType: 'Bearer',
        }
        if (rotateRefreshToken) {
          const rotated = `refresh-fake-${issued + 1}`
          result.RefreshToken = rotated
          validRefresh.add(rotated)
        }
        return json(200, { AuthenticationResult: result, ChallengeParameters: {} })
      }
      apiCalls.push({ url: u.pathname, authorization: headers.get('Authorization'), method: init.method ?? 'GET' })
      const respond = apiResponses?.[apiCalls.length - 1]
      if (respond) return respond(net)
      return json(200, { pointsBalance: '1500.00', creditBalance: '2500', pointsExpireAt: null })
    },
  }
  return net
}

function provider(net: FakeNetwork, overrides: TokenProviderDeps = {}) {
  const saved: StoredSession[] = []
  const tokens = new TokenProvider({
    fetch: net.fetch,
    loadSession: () => Promise.resolve({ ...SESSION }),
    saveSession: (s) => {
      saved.push(s)
      return Promise.resolve()
    },
    ...overrides,
  })
  return { tokens, saved }
}

describe('TokenProvider refresh (item 10)', () => {
  test('concurrent getIdToken() calls share one refresh request', async () => {
    const net = fakeNetwork()
    const { tokens } = provider(net)
    const results = await Promise.all([tokens.getIdToken(), tokens.getIdToken(), tokens.getIdToken(), tokens.getIdToken()])
    assert.equal(net.cognitoCalls.length, 1)
    assert.deepEqual(results, Array(4).fill(net.tokens[0]))
  })

  test('a cached token is reused; forceRefresh fetches a new one', async () => {
    const net = fakeNetwork()
    const { tokens } = provider(net)
    const first = await tokens.getIdToken()
    assert.equal(await tokens.getIdToken(), first)
    assert.equal(net.cognitoCalls.length, 1)
    const forced = await tokens.getIdToken(true)
    assert.equal(net.cognitoCalls.length, 2)
    assert.notEqual(forced, first)
  })

  test('a failed refresh rejects every concurrent caller and the next call tries again', async () => {
    const net = fakeNetwork()
    let loads = 0
    const { tokens } = provider(net, {
      loadSession: () => Promise.resolve(++loads === 1 ? { ...SESSION, refreshToken: 'refresh-revoked' } : { ...SESSION }),
    })
    const settled = await Promise.allSettled([tokens.getIdToken(), tokens.getIdToken()])
    assert.deepEqual(
      settled.map((s) => s.status),
      ['rejected', 'rejected']
    )
    assert.equal(net.cognitoCalls.length, 1)
    assert.equal(await tokens.getIdToken(), net.tokens[0])
    assert.equal(net.cognitoCalls.length, 2)
  })

  test('a rotated refresh token is saved', async () => {
    const net = fakeNetwork({ rotateRefreshToken: true })
    const { tokens, saved } = provider(net)
    await tokens.getIdToken()
    assert.equal(saved.length, 1)
    assert.equal(nth(saved, 0).refreshToken, 'refresh-fake-2')
  })

  test('failing to save a rotated refresh token still returns the ID token (§9)', async () => {
    const net = fakeNetwork({ rotateRefreshToken: true })
    const attempts: StoredSession[] = []
    const { tokens } = provider(net, {
      saveSession: (s) => {
        attempts.push(s)
        return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      },
    })
    assert.equal(await tokens.getIdToken(), net.tokens[0])
    assert.equal(attempts.length, 1)
  })

  test('no stored session and no env credentials -> AuthError naming the install spec login command', async () => {
    const net = fakeNetwork()
    const { tokens } = provider(net, { loadSession: () => Promise.resolve(null) })
    await assert.rejects(tokens.getIdToken(), (err) => {
      const message = messageOf(err)
      assert.equal(prop(err, 'name'), 'AuthError')
      assert.ok(message.includes('npx -y github:trammel/pub-points-mcp#v0.1.0 login'), message)
      return true
    })
    assert.equal(net.cognitoCalls.length, 0)
  })
})

describe('PubPointsClient 401 retry (item 10)', () => {
  test('a 401 refreshes the token and retries exactly once', async () => {
    const net = fakeNetwork({ apiResponses: [() => json(401, { message: 'Expired token' })] })
    const { tokens } = provider(net)
    const client = new PubPointsClient(tokens, { fetch: net.fetch })
    const balances = await client.getBalances()
    assert.equal(balances.pointsBalance, 1500)
    assert.equal(net.apiCalls.length, 2)
    assert.equal(net.cognitoCalls.length, 2)
    assert.equal(nth(net.apiCalls, 0).authorization, `Bearer ${nth(net.tokens, 0)}`)
    assert.equal(nth(net.apiCalls, 1).authorization, `Bearer ${nth(net.tokens, 1)}`)
  })

  test('a second 401 is not retried again and surfaces as ApiError 401', async () => {
    const unauthorized = () => json(401, { message: 'Expired token' })
    const net = fakeNetwork({ apiResponses: [unauthorized, unauthorized, unauthorized] })
    const { tokens } = provider(net)
    const client = new PubPointsClient(tokens, { fetch: net.fetch })
    await assert.rejects(client.getBalances(), (err) => {
      assert.ok(err instanceof ApiError, thrownText(err))
      assert.equal(err.status, 401)
      return true
    })
    assert.equal(net.apiCalls.length, 2)
  })

  test('a write that gets 401 is retried once and sent at most twice', async () => {
    const net = fakeNetwork({
      apiResponses: [() => json(401, { message: 'Expired token' }), () => new Response(null, { status: 204 })],
    })
    const { tokens } = provider(net)
    const client = new PubPointsClient(tokens, { fetch: net.fetch })
    await client.redeemPoints('reward-a')
    assert.deepEqual(
      net.apiCalls.map((c) => [c.method, c.url]),
      [
        ['POST', '/points-redemptions'],
        ['POST', '/points-redemptions'],
      ]
    )
  })

  for (const status of [403, 500, 503]) {
    test(`HTTP ${status} is not retried`, async () => {
      const net = fakeNetwork({ apiResponses: [() => json(status, { message: `status ${status}` })] })
      const { tokens } = provider(net)
      const client = new PubPointsClient(tokens, { fetch: net.fetch })
      await assert.rejects(client.redeemPoints('reward-a'), (err) => err instanceof ApiError && err.status === status)
      assert.equal(net.apiCalls.length, 1)
      assert.equal(net.cognitoCalls.length, 1)
    })
  }
})

describe('TokenProvider failures a member sees', () => {
  test('no saved session and no credentials in the environment: tells the member to sign in, with no network call', async () => {
    const net = fakeNetwork()
    const { tokens } = provider(net, { loadSession: () => Promise.resolve(null) })
    await assert.rejects(tokens.getIdToken(), (err) => {
      assert.match(
        messageOf(err),
        /^Not signed in to The Pass\. Run `.*login` in a terminal \(or set THEPASS_EMAIL and THEPASS_PASSWORD\)\.$/
      )
      return true
    })
    assert.equal(net.cognitoCalls.length, 0)
  })

  test('a Cognito error that is not JSON is reported by status, without the body', async () => {
    const { tokens } = provider(fakeNetwork(), {
      fetch: () => Promise.resolve(new Response('<html>SECRET-GATEWAY</html>', { status: 502 })),
    })
    await assert.rejects(tokens.getIdToken(), (err) => {
      assert.match(messageOf(err), /^Session refresh failed \(HTTP 502\)\. Run `.*login` again\.$/)
      return true
    })
  })

  test('a 200 from Cognito that is not JSON is a refresh failure naming the status', async () => {
    const { tokens } = provider(fakeNetwork(), { fetch: () => Promise.resolve(new Response('not json', { status: 200 })) })
    await assert.rejects(tokens.getIdToken(), (err) => {
      assert.match(messageOf(err), /^Session refresh failed \(Cognito answered HTTP 200 with a body that is not JSON\)\./)
      assert.ok(!messageOf(err).includes('not json'), messageOf(err))
      return true
    })
  })

  test('a remembered device is sent with the refresh', async () => {
    const net = fakeNetwork()
    const { tokens } = provider(net, { loadSession: () => Promise.resolve({ ...SESSION, deviceKey: 'device-fake-1' }) })
    await tokens.getIdToken()
    const body: unknown = JSON.parse(String(nth(net.cognitoCalls, 0).body))
    assert.equal(prop(prop(body, 'AuthParameters'), 'DEVICE_KEY'), 'device-fake-1')
  })

  test('a caller whose request is already cancelled gets the cancellation at once', async () => {
    const net = fakeNetwork()
    const { tokens } = provider(net)
    const controller = new AbortController()
    controller.abort(new Error('caller went away'))
    await assert.rejects(tokens.getIdToken(false, controller.signal), (err) => messageOf(err) === 'caller went away')
    // The shared refresh may already be under way; a later caller still gets a token from it.
    assert.equal(await tokens.getIdToken(), nth(net.tokens, 0))
  })

  test('a caller cancelled while waiting gets the cancellation; the refresh still finishes for the others', async () => {
    const net = fakeNetwork()
    const { tokens } = provider(net)
    const controller = new AbortController()
    const cancelled = tokens.getIdToken(false, controller.signal)
    const other = tokens.getIdToken()
    controller.abort(new Error('caller went away'))
    await assert.rejects(cancelled, (err) => messageOf(err) === 'caller went away')
    assert.equal(await other, nth(net.tokens, 0))
    assert.equal(net.cognitoCalls.length, 1)
  })
})
