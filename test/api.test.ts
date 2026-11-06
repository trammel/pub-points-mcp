// SPDX-License-Identifier: GPL-3.0-or-later
// PubPointsClient against a fake network: paging stop rules (§5), Algolia key retry (§9), error
// text without raw bodies (§9), the utcOffset the client sends (§9), and date() / utcOffset()
// helpers. Review findings 8, 9 and 15.
//
// Seams used (§11): new PubPointsClient(tokens, { fetch }). `tokens` is a plain object with
// getIdToken(), standing in for TokenProvider; no Cognito call is involved.
//
// The fake API refuses a request without a Bearer token (401), and the fake Algolia refuses one
// without X-Algolia-Application-Id and X-Algolia-API-Key (403), as the real services do.

import './backstop.ts'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { PubPointsClient, ApiError, ACTIVITY_CAP } from '../dist/api.js'
import type { OrderFilter } from '../dist/api.js'
import type { IdTokenSource } from '../dist/auth.js'
import { date } from '../dist/format.js'
import { utcOffset } from '../dist/dates.js'
import { connect, messageOf, nth, present, textOf, thrownText, urlText } from './harness.ts'

/** Hands out a fixed ID token, with no Cognito behind it. */
const TOKENS: IdTokenSource = { getIdToken: () => Promise.resolve('id-token-fake') }
// URL lower-cases the host, so compare in lower case
const ALGOLIA_HOST = '84CP50NOB1-dsn.algolia.net'.toLowerCase()

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * `api(path, url, n)` answers API calls (n counts calls to that path); `algolia(url, headers, n)`
 * answers Algolia calls. Every call is recorded in `calls`.
 */
interface FakeNetworkOptions {
  api?: (path: string, url: URL, n: number) => Response
  algolia?: (url: URL, headers: Headers, n: number) => Response
}

interface RecordedCall {
  host: string
  path: string
  url: URL
  headers: Headers
  method: string
  body: unknown
}

type FakeNetwork = ReturnType<typeof fakeNetwork>

function fakeNetwork({ api = () => json(404, { message: 'no route' }), algolia = () => json(404, {}) }: FakeNetworkOptions = {}) {
  const calls: RecordedCall[] = []
  const counts = new Map<string, number>()
  const answer = (url: string | URL | Request, init: RequestInit): Response => {
    const u = new URL(urlText(url))
    const headers = new Headers(init.headers)
    calls.push({ host: u.host, path: u.pathname, url: u, headers, method: init.method ?? 'GET', body: init.body })
    const n = (counts.get(u.pathname) ?? 0) + 1
    counts.set(u.pathname, n)
    if (u.host === ALGOLIA_HOST) {
      if (!headers.get('X-Algolia-Application-Id') || !headers.get('X-Algolia-API-Key'))
        return json(403, { message: 'Invalid Application-ID or API key' })
      return algolia(u, headers, n)
    }
    if (!/^Bearer \S+$/.test(headers.get('Authorization') ?? '')) return json(401, { message: 'JWT Token not found' })
    return api(u.pathname, u, n)
  }
  return {
    calls,
    fetch: (url: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
      new Promise((resolve) => {
        resolve(answer(url, init))
      }),
  }
}

function page(items: unknown[], hasNextPage: boolean) {
  return json(200, { items, pagination: { hasNextPage } })
}

function order(i: number) {
  return {
    id: `o${i}`,
    status: 'completed',
    chargeAmount: '1000',
    earnedPointsAmount: '100',
    venue: { id: 'v1' },
    createdAt: '2026-10-15T02:00:00Z',
  }
}

function activity(i: number, createdAt: string) {
  return { id: `a${i}`, type: 'order', createdAt, data: {} }
}

const apiCalls = (net: FakeNetwork, path: string) => net.calls.filter((c) => c.host !== ALGOLIA_HOST && c.path === path)

// ---- finding 8: paging ----

// The fakes below end the list themselves after a few extra pages (hasNextPage false), so a
// missing stop rule shows up as a wrong call count instead of a loop that never yields.
describe('orders paging (§5)', { timeout: 10_000 }, () => {
  const FILTER: OrderFilter = { after: '2026-10-01T00:00:00+10:00', before: '2026-10-31T23:59:59+11:00', status: 'completed', max: 500 }

  test('sends status=completed and createdAt[after]/[before] on every page, and stops when hasNextPage is false', async () => {
    const net = fakeNetwork({ api: (_p, _u, n) => (n === 1 ? page([order(1), order(2)], true) : page([order(3)], false)) })
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    const { orders, complete } = await client.getOrders(FILTER)
    assert.deepEqual(
      orders.map((o) => o.id),
      ['o1', 'o2', 'o3']
    )
    assert.equal(complete, true)
    const calls = apiCalls(net, '/orders')
    assert.equal(calls.length, 2)
    calls.forEach((c, i) => {
      const q = c.url.searchParams
      assert.equal(q.get('status'), 'completed')
      assert.equal(q.get('createdAt[after]'), FILTER.after)
      assert.equal(q.get('createdAt[before]'), FILTER.before)
      assert.equal(q.get('page'), String(i + 1))
    })
  })

  test('stops on an empty page even when hasNextPage is true', async () => {
    const net = fakeNetwork({ api: (_p, _u, n) => (n === 1 ? page([order(1)], true) : page([], n < 5)) })
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    const { orders } = await client.getOrders(FILTER)
    assert.equal(orders.length, 1)
    assert.equal(apiCalls(net, '/orders').length, 2)
  })

  test('stops at max and reports the list as incomplete', async () => {
    let next = 0
    const net = fakeNetwork({
      api: (_p, _u, n) =>
        page(
          Array.from({ length: 100 }, () => order(++next)),
          n < 5
        ),
    })
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    const { orders, complete } = await client.getOrders({ ...FILTER, max: 150 })
    assert.equal(orders.length, 150)
    assert.equal(complete, false)
    assert.equal(apiCalls(net, '/orders').length, 2)
  })
})

describe('activity paging (§5)', { timeout: 10_000 }, () => {
  test('ACTIVITY_CAP is 2,000', () => {
    assert.equal(ACTIVITY_CAP, 2000)
  })

  test('without a start date, stops at 2,000 records and reports truncation', async () => {
    let next = 0
    const net = fakeNetwork({
      api: (_p, _u, n) =>
        page(
          Array.from({ length: 100 }, () => activity(++next, new Date(Date.UTC(2026, 10, 1) - next * 60_000).toISOString())),
          n < 25
        ),
    })
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    const { items, truncated } = await client.getActivities(undefined)
    assert.equal(items.length, 2000)
    assert.equal(truncated, true)
    assert.equal(apiCalls(net, '/activities').length, 20)
  })

  test('stops at the page that reaches back before the start date, without truncation', async () => {
    const net = fakeNetwork({
      api: (_p, _u, n) =>
        n === 1
          ? page([activity(1, '2026-10-20T00:00:00Z'), activity(2, '2026-10-10T00:00:00Z')], true)
          : page([activity(3 + 2 * (n - 2), '2026-10-02T00:00:00Z'), activity(4 + 2 * (n - 2), '2026-09-28T00:00:00Z')], n < 5),
    })
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    const { items, truncated } = await client.getActivities('2026-10-01T00:00:00Z')
    assert.equal(apiCalls(net, '/activities').length, 2)
    assert.equal(truncated, false)
    assert.deepEqual(
      items.map((a) => a.id),
      ['a1', 'a2', 'a3', 'a4']
    )
  })

  test('the end of history is not truncation', async () => {
    const net = fakeNetwork({ api: () => page([activity(1, '2026-10-20T00:00:00Z')], false) })
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    assert.equal((await client.getActivities(undefined)).truncated, false)
  })

  test('pub_points_activity says when the list was truncated', async (t) => {
    const h = await connect(t)
    h.fake.getActivities = () =>
      Promise.resolve({
        items: [activity(1, '2026-10-20T00:00:00Z'), activity(2, '2026-09-28T03:00:00Z')],
        truncated: true,
      })
    const text = textOf(await h.call('pub_points_activity', {}))
    assert.match(text, /truncated/i)
    assert.ok(text.includes('2,000'), text)
    assert.match(text, /28 Sept? 2026/)
  })
})

// ---- amounts: numeric strings become numbers; anything else is a shape error ----

describe('amount schema (§7)', () => {
  /** `pointsBalance` is the raw JSON value the API sends, before the schema parses it. */
  function balances(pointsBalance: unknown) {
    const net = fakeNetwork({ api: () => json(200, { pointsBalance, creditBalance: '2500', pointsExpireAt: null }) })
    return new PubPointsClient(TOKENS, { fetch: net.fetch }).getBalances()
  }

  const AMOUNTS: [string | number, number][] = [
    ['1500.00', 1500],
    ['1500', 1500],
    [1500, 1500],
    ['-12.5', -12.5],
    ['0', 0],
  ]
  for (const [raw, expected] of AMOUNTS) {
    test(`${JSON.stringify(raw)} parses to ${expected}`, async () => {
      assert.equal((await balances(raw)).pointsBalance, expected)
    })
  }

  for (const raw of ['1,500', '', ' 1500', '1500 points', '1e3', 'NaN', 'Infinity', '.5']) {
    test(`${JSON.stringify(raw)} fails validation, naming the endpoint`, async () => {
      await assert.rejects(balances(raw), (err) => {
        assert.ok(err instanceof ApiError, thrownText(err))
        assert.ok(err.message.includes('/customer-balances'), err.message)
        return true
      })
    })
  }
})

// ---- finding 9: Algolia key retry ----

describe('Algolia key retry (§9)', () => {
  function keysAndAlgolia(first: () => Response, second = () => json(200, { results: [{ objectID: 'venue-1', title: 'The Local' }] })) {
    let keys = 0
    return fakeNetwork({
      api: (path) => {
        if (path !== '/algolia-api-keys') return json(404, { message: 'no route' })
        keys += 1
        return json(200, { secret: `algolia-key-fake-${keys}`, venueIndexName: 'venues_fake' })
      },
      algolia: (_u, _h, n) => (n === 1 ? first() : second()),
    })
  }

  for (const status of [401, 403]) {
    test(`a ${status} drops the cached key, fetches a new one and retries once`, async () => {
      const net = keysAndAlgolia(() => json(status, { message: 'expired key' }))
      const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
      const venues = await client.getVenuesByIds(['venue-1'])
      assert.deepEqual(
        venues.map((v) => v.title),
        ['The Local']
      )
      const algolia = net.calls.filter((c) => c.host === ALGOLIA_HOST)
      assert.equal(algolia.length, 2)
      assert.equal(nth(algolia, 0).headers.get('X-Algolia-API-Key'), 'algolia-key-fake-1')
      assert.equal(nth(algolia, 1).headers.get('X-Algolia-API-Key'), 'algolia-key-fake-2')
      assert.equal(apiCalls(net, '/algolia-api-keys').length, 2)
    })
  }

  test('a second 403 is not retried again', async () => {
    const forbidden = () => json(403, { message: 'still no' })
    const net = keysAndAlgolia(forbidden, forbidden)
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    await assert.rejects(client.getVenuesByIds(['venue-1']), (err) => err instanceof ApiError && err.status === 403)
    assert.equal(net.calls.filter((c) => c.host === ALGOLIA_HOST).length, 2)
  })

  test('a 500 is not a key problem: no new key and no retry', async () => {
    const net = keysAndAlgolia(() => json(500, { message: 'oops' }))
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    await assert.rejects(client.getVenuesByIds(['venue-1']), (err) => err instanceof ApiError && err.status === 500)
    assert.equal(net.calls.filter((c) => c.host === ALGOLIA_HOST).length, 1)
    assert.equal(apiCalls(net, '/algolia-api-keys').length, 1)
  })

  test('a good key is reused across lookups', async () => {
    const net = keysAndAlgolia(
      () => json(200, { results: [{ objectID: 'venue-1' }] }),
      () => json(200, { results: [{ objectID: 'venue-1' }] })
    )
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    await client.getVenuesByIds(['venue-1'])
    await client.getVenuesByIds(['venue-1'])
    assert.equal(apiCalls(net, '/algolia-api-keys').length, 1)
  })
})

// ---- finding 15: error text never carries a raw body ----

describe('error text (§9)', () => {
  test('a non-JSON 500 body is not echoed', async () => {
    const net = fakeNetwork({ api: () => new Response('<html>SECRET-INTERNAL stack trace</html>', { status: 500 }) })
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    await assert.rejects(client.getBalances(), (err) => {
      assert.ok(err instanceof ApiError)
      assert.ok(err.message.includes('HTTP 500'), err.message)
      assert.ok(!err.message.includes('SECRET-INTERNAL'), err.message)
      return true
    })
  })

  test("a JSON error shows the API's message and status, not the other fields", async () => {
    const net = fakeNetwork({ api: () => json(400, { message: 'Bad thing', trace: 'SECRET-TRACE', input: 'SECRET-INPUT' }) })
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    await assert.rejects(client.redeemPoints('reward-a'), (err) => {
      const message = messageOf(err)
      assert.ok(message.includes('Bad thing'), message)
      assert.ok(message.includes('HTTP 400'), message)
      assert.ok(!message.includes('SECRET'), message)
      return true
    })
  })

  test('a JSON error with only `detail` uses it', async () => {
    const net = fakeNetwork({ api: () => json(422, { detail: 'Not enough points', violations: ['SECRET-VIOLATION'] }) })
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    await assert.rejects(
      client.redeemPoints('reward-a'),
      (err) => messageOf(err).includes('Not enough points') && !messageOf(err).includes('SECRET')
    )
  })

  test('a query string is not echoed in the endpoint name', async () => {
    const net = fakeNetwork({ api: () => new Response('nope', { status: 503 }) })
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    await assert.rejects(
      client.getActivities(undefined),
      (err) => !messageOf(err).includes('perPage') && messageOf(err).includes('/activities')
    )
  })

  test('an Algolia error body is not echoed', async () => {
    const net = fakeNetwork({
      api: (path) =>
        path === '/algolia-api-keys' ? json(200, { secret: 'algolia-key-fake-1', venueIndexName: 'venues_fake' }) : json(404, {}),
      algolia: () => new Response('SECRET-ALGOLIA internals', { status: 500 }),
    })
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    await assert.rejects(client.getVenuesByIds(['venue-1']), (err) => !messageOf(err).includes('SECRET-ALGOLIA'))
  })

  test('a response of the wrong shape names the endpoint and not the value', async () => {
    const net = fakeNetwork({ api: () => json(200, { pointsBalance: { leaked: 'SECRET-SHAPE' }, creditBalance: '0' }) })
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    await assert.rejects(client.getBalances(), (err) => {
      assert.ok(err instanceof ApiError)
      assert.ok(err.message.includes('/customer-balances'), err.message)
      assert.ok(!err.message.includes('SECRET-SHAPE'), err.message)
      return true
    })
  })
})

// ---- finding 15: time zone helpers ----

/** Offset of a zone at an instant, read independently through Intl's longOffset name. */
function intlOffset(timeZone: string, at: Date) {
  const name = present(
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName'),
    'timeZoneName'
  ).value
  return name === 'GMT' ? '+00:00' : name.slice(3)
}

describe('utcOffset (§9)', () => {
  const OFFSETS: [string, string, string][] = [
    ['Australia/Sydney', '2026-07-01T00:00:00Z', '+10:00'],
    ['Australia/Sydney', '2026-01-15T00:00:00Z', '+11:00'],
    ['Australia/Adelaide', '2026-01-15T00:00:00Z', '+10:30'],
    ['Asia/Kolkata', '2026-01-15T00:00:00Z', '+05:30'],
    ['America/St_Johns', '2026-01-15T00:00:00Z', '-03:30'],
    ['UTC', '2026-01-15T00:00:00Z', '+00:00'],
  ]
  for (const [zone, iso, expected] of OFFSETS) {
    test(`${zone} at ${iso} is ${expected}`, () => {
      assert.equal(utcOffset(zone, new Date(iso)), expected)
    })
  }

  test('the client sends the configured zone (Australia/Sydney by default) offset for now', async () => {
    const net = fakeNetwork({
      api: () =>
        json(200, {
          id: 'offer-1',
          activated: false,
          strategy: 'credit',
          value: '500',
          startAt: '2026-01-01T00:00:00Z',
          endAt: '2099-01-01T00:00:00Z',
          limitPerCustomerReached: false,
        }),
    })
    const client = new PubPointsClient(TOKENS, { fetch: net.fetch })
    const before = intlOffset('Australia/Sydney', new Date())
    await client.getOfferDetails('offer-1')
    const after = intlOffset('Australia/Sydney', new Date())
    const sent = nth(net.calls, 0).url.searchParams.get('location[utcOffset]')
    const offsets: (string | null)[] = [before, after]
    assert.ok(offsets.includes(sent), `sent ${String(sent)}, Intl says ${before}`)
  })
})

describe('date() (§9)', () => {
  test('a missing value is "unknown" by default', () => {
    assert.equal(date(undefined), 'unknown')
    assert.equal(date(null), 'unknown')
    assert.equal(date(''), 'unknown')
  })

  test('a caller can name what missing means', () => {
    assert.equal(date(null, 'no expiry'), 'no expiry')
  })
})
