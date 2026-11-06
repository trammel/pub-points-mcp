// SPDX-License-Identifier: GPL-3.0-or-later
// PubPointsClient's read and write methods against a fake network: the path, method, query and
// body each sends, what it returns after parsing, and the empty, missing and malformed answers.
// Paging stop rules, the Algolia key retry and error text are in api.test.ts.
//
// Seam: new PubPointsClient(tokens, { fetch }). `tokens` hands out a fixed ID token. As the real
// services do, the fake API refuses a request without a Bearer token (401) except under
// /public/, and the fake Algolia refuses one without its application id and key headers (403).

import './backstop.ts'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, PubPointsClient, ResponseShapeError } from '../dist/api.js'
import type { OfferDetails } from '../dist/api.js'
import type { IdTokenSource } from '../dist/auth.js'
import { field, nth, record, urlText } from './harness.ts'

const TOKENS: IdTokenSource = { getIdToken: () => Promise.resolve('id-token-fake') }
const API_HOST = 'api.prod.v1.avc.eonx.com'
// URL lower-cases the host
const ALGOLIA_HOST = '84cp50nob1-dsn.algolia.net'
const UTC_OFFSET = /^[+-]\d{2}:\d{2}$/

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface Call {
  host: string
  method: string
  path: string
  url: URL
  headers: Headers
  body: unknown
}

/** Answers a request; `n` counts calls to the same method and path, from 1. */
type Route = (call: Call, n: number) => Response

/**
 * Routes are keyed "METHOD /path" for the API and "ALGOLIA /path" for Algolia. An unknown route
 * is a 404. Every call is recorded, including refused ones.
 */
function fakeNetwork(routes: Record<string, Route>, tokens: IdTokenSource = TOKENS) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const answer = (input: string | URL | Request, init: RequestInit): Response => {
    const url = new URL(urlText(input))
    const headers = new Headers(init.headers)
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    const call: Call = { host: url.host, method: init.method ?? 'GET', path: url.pathname, url, headers, body }
    calls.push(call)
    const key = `${url.host === ALGOLIA_HOST ? 'ALGOLIA' : call.method} ${url.pathname}`
    const n = (counts.get(key) ?? 0) + 1
    counts.set(key, n)
    if (url.host === ALGOLIA_HOST) {
      if (!headers.get('X-Algolia-Application-Id') || !headers.get('X-Algolia-API-Key')) return json(403, { message: 'Invalid key' })
    } else if (url.host !== API_HOST) {
      return json(404, { message: 'unknown host' })
    } else if (!url.pathname.startsWith('/public/') && !/^Bearer \S+$/.test(headers.get('Authorization') ?? '')) {
      return json(401, { message: 'JWT Token not found' })
    }
    const route = routes[key]
    return route ? route(call, n) : json(404, { message: `no route for ${key}` })
  }
  const fetch = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
    new Promise((resolve) => {
      resolve(answer(input, init))
    })
  return { calls, client: new PubPointsClient(tokens, { fetch }) }
}

const ok =
  (body: unknown): Route =>
  () =>
    json(200, body)

/** The one call made, or a failure naming how many there were. */
function only(calls: Call[]): Call {
  assert.equal(calls.length, 1, JSON.stringify(calls.map((c) => `${c.method} ${c.path}`)))
  return nth(calls, 0)
}

// ---- account reads ----

describe('account reads', () => {
  test('getProfile reads GET /customers/me with the ID token', async () => {
    const net = fakeNetwork({ 'GET /customers/me': ok({ firstName: 'Sam', email: 'sam@example.com', extra: 'kept' }) })
    const profile = await net.client.getProfile()
    assert.equal(profile.firstName, 'Sam')
    assert.equal(profile.email, 'sam@example.com')
    assert.equal(only(net.calls).headers.get('Authorization'), 'Bearer id-token-fake')
  })

  test('getReferralCode reads GET /customers/me/referral-code', async () => {
    const net = fakeNetwork({ 'GET /customers/me/referral-code': ok({ code: 'MATE42', limitReached: true }) })
    assert.deepEqual(await net.client.getReferralCode(), { code: 'MATE42', limitReached: true })
  })

  test('getPublicSettings sends no ID token and turns decimal strings into numbers', async () => {
    const net = fakeNetwork({
      'GET /public/settings': ok({ signUpBonusAmount: '1000', externalPurchasesPointsEarnRate: '0.05', pointsCreditExpiryPeriod: 'P6M' }),
    })
    const settings = await net.client.getPublicSettings()
    assert.equal(settings.signUpBonusAmount, 1000)
    assert.equal(settings.externalPurchasesPointsEarnRate, 0.05)
    assert.equal(settings.pointsCreditExpiryPeriod, 'P6M')
    assert.equal(only(net.calls).headers.get('Authorization'), null)
  })

  test('checkAppVersion posts the version as an android client, with no ID token', async () => {
    const net = fakeNetwork({ 'POST /public/mobile-app-update-check': ok({ updateType: 'soft' }) })
    assert.deepEqual(await net.client.checkAppVersion('9.9.9'), { updateType: 'soft' })
    const call = only(net.calls)
    assert.deepEqual(call.body, { appVersion: '9.9.9', deviceOs: 'android' })
    assert.equal(call.headers.get('Authorization'), null)
  })

  test('getPromoTiles reads GET /available-tiles', async () => {
    const net = fakeNetwork({ 'GET /available-tiles': ok({ items: [{ id: 'p1', title: 'Happy hour' }] }) })
    const tiles = await net.client.getPromoTiles()
    assert.deepEqual(
      tiles.items.map((t) => t.title),
      ['Happy hour']
    )
  })

  test('getBalances, getCustomerTier, getTiers and getPointsExchangeRates parse amounts sent as strings', async () => {
    const net = fakeNetwork({
      'GET /customer-balances': ok({ pointsBalance: '1500', creditBalance: '2500.00', pointsExpireAt: null }),
      'GET /customers/me/tier': ok({ spendAmount: '45000', tier: { name: 'Silver', spendAmountTo: '100000' }, nextTier: { name: 'Gold' } }),
      'GET /tiers': ok({ items: [{ name: 'Silver', level: 1, spendAmountFrom: '0' }] }),
      'GET /points-exchange-rates': ok({ items: [{ id: 'reward-a', pointsAmount: '1000', creditAmount: '1000' }] }),
    })
    const balances = await net.client.getBalances()
    assert.equal(balances.pointsBalance, 1500)
    assert.equal(balances.creditBalance, 2500)
    const tier = await net.client.getCustomerTier()
    assert.equal(tier.spendAmount, 45000)
    assert.equal(tier.tier.spendAmountTo, 100000)
    assert.equal(tier.nextTier?.name, 'Gold')
    assert.equal(nth((await net.client.getTiers()).items, 0).spendAmountFrom, 0)
    const rate = nth((await net.client.getPointsExchangeRates()).items, 0)
    assert.equal(rate.pointsAmount, 1000)
    assert.equal(rate.creditAmount, 1000)
  })

  test('getFavouriteVenues and getCommunicationPreferences return the page items', async () => {
    const net = fakeNetwork({
      'GET /favourite-venues': ok({ items: [{ id: 'fav-1', venue: { id: 'venue-1' } }] }),
      'GET /communication-preferences': ok({ items: [{ id: 'pref-1', type: 'email_news' }] }),
    })
    assert.deepEqual(await net.client.getFavouriteVenues(), [{ id: 'fav-1', venue: { id: 'venue-1' } }])
    assert.deepEqual(await net.client.getCommunicationPreferences(), [{ id: 'pref-1', type: 'email_news' }])
  })
})

// ---- organisations ----

describe('organisations', () => {
  test('getCustomerOrganisations leaves out hidden groups', async () => {
    const net = fakeNetwork({
      'GET /customer-organisations': ok({
        items: [
          { id: 'cm-1', organisation: { id: 'org-1', name: 'Acme Club', hidden: false } },
          { id: 'cm-2', organisation: { id: 'org-2', name: 'Secret Staff', hidden: true } },
          { id: 'cm-3', organisation: { id: 'org-3', name: 'Uni Staff' } },
        ],
      }),
    })
    assert.deepEqual(
      (await net.client.getCustomerOrganisations()).map((m) => m.id),
      ['cm-1', 'cm-3']
    )
  })

  test('getCustomerOrganisation reads one membership by id, with its venues', async () => {
    const net = fakeNetwork({
      'GET /customer-organisations/cm-1': ok({
        id: 'cm-1',
        organisation: { id: 'org-1', name: 'Acme Club', discountVenues: [{ id: 'venue-1' }] },
      }),
    })
    const details = await net.client.getCustomerOrganisation('cm-1')
    assert.deepEqual(details.organisation.discountVenues, [{ id: 'venue-1' }])
  })
})

// ---- orders ----

describe('getOrder', () => {
  test('reads GET /orders/<id> and parses its amounts', async () => {
    const net = fakeNetwork({
      'GET /orders/o-1': ok({ id: 'o-1', createdAt: '2026-10-15T02:00:00Z', items: [{ name: 'Pint', amountWithTax: '1200' }] }),
    })
    const order = await net.client.getOrder('o-1')
    assert.equal(nth(order.items ?? [], 0).amountWithTax, 1200)
  })

  test('an id is encoded, so it cannot reach another path', async () => {
    const net = fakeNetwork({})
    await assert.rejects(net.client.getOrder('../customers/me'), ApiError)
    assert.equal(only(net.calls).path, '/orders/..%2Fcustomers%2Fme')
  })
})

// ---- offers ----

describe('offers', () => {
  test('getOfferDetails sends the time zone offset in the query', async () => {
    const net = fakeNetwork({
      'GET /available-offers/offer-1': ok({ id: 'offer-1', activated: false, strategy: 'credit', value: '500', activationCode: 'C1' }),
    })
    const details = await net.client.getOfferDetails('offer-1')
    assert.equal(details.value, 500)
    assert.equal(details.activationCode, 'C1')
    assert.match(only(net.calls).url.searchParams.get('location[utcOffset]') ?? '', UTC_OFFSET)
  })

  test('getOfferVenueIds asks for the venues of that one offer and returns their ids', async () => {
    const net = fakeNetwork({ 'POST /available-offers/search': ok({ venues: [{ id: 'venue-1' }, { id: 'venue-2' }] }) })
    assert.deepEqual(await net.client.getOfferVenueIds('offer-1'), ['venue-1', 'venue-2'])
    const body = record(only(net.calls).body, 'body')
    assert.deepEqual(body.offers, ['offer-1'])
    assert.deepEqual(body.properties, ['venues'])
    assert.deepEqual(body.types, ['single_step', 'multi_step', 'instant_reward'])
    assert.match(String(field(body.location, 'utcOffset')), UTC_OFFSET)
  })

  test('getOfferVenueIds with no venues in the answer is an empty list', async () => {
    const net = fakeNetwork({ 'POST /available-offers/search': ok({ venues: null }) })
    assert.deepEqual(await net.client.getOfferVenueIds('offer-1'), [])
  })

  function offerJson(id: string) {
    return { id, activated: false, strategy: 'credit', value: '500' }
  }

  /** Answers the instant-reward search with `instant` and the single/multi-step one with `regular`. */
  function searchByType(instant: unknown, regular: unknown): Route {
    return (call) => {
      const types = field(call.body, 'types')
      return json(200, Array.isArray(types) && types.includes('instant_reward') ? instant : regular)
    }
  }

  test('searchOffers runs one search for instant rewards and one for other offers, instant rewards first, no repeats', async () => {
    const net = fakeNetwork({
      'POST /available-offers/search': searchByType(
        { offers: [offerJson('ir-1'), offerJson('both')] },
        { offers: [offerJson('both'), offerJson('ss-1')] }
      ),
    })
    const offers = await net.client.searchOffers({}, undefined)
    assert.deepEqual(
      offers.map((o) => o.id),
      ['ir-1', 'both', 'ss-1']
    )
    assert.deepEqual(net.calls.map((c) => field(c.body, 'types')).sort(), [['instant_reward'], ['single_step', 'multi_step']].sort())
  })

  test('searchOffers sends the coordinate as strings, venues (at most 200), groups and the limit', async () => {
    const net = fakeNetwork({ 'POST /available-offers/search': ok({ offers: [] }) })
    const venues = Array.from({ length: 250 }, (_, i) => `venue-${i}`)
    await net.client.searchOffers({ venues, organisations: ['org-1'], limit: 7 }, { latitude: -33.87, longitude: 151.21 })
    assert.equal(net.calls.length, 2)
    for (const call of net.calls) {
      const body = record(call.body, 'body')
      assert.equal(field(body.location, 'latitude'), '-33.87')
      assert.equal(field(body.location, 'longitude'), '151.21')
      assert.match(String(field(body.location, 'utcOffset')), UTC_OFFSET)
      assert.ok(Array.isArray(body.venues) && body.venues.length === 200, 'venues capped at 200')
      assert.deepEqual(body.organisations, ['org-1'])
      assert.deepEqual(body.limits, { offers: 7 })
    }
  })

  test('searchOffers with no filter sends no venues, groups, limit or coordinate', async () => {
    const net = fakeNetwork({ 'POST /available-offers/search': ok({ offers: null }) })
    assert.deepEqual(await net.client.searchOffers({}, undefined), [])
    for (const call of net.calls) {
      const body = record(call.body, 'body')
      for (const key of ['venues', 'organisations', 'limits']) assert.ok(!(key in body), key)
      assert.deepEqual(Object.keys(record(body.location, 'location')), ['utcOffset'])
    }
  })

  test('checkCode posts the code to /code-info', async () => {
    const net = fakeNetwork({ 'POST /code-info': ok({ type: 'promo_code' }) })
    assert.deepEqual(await net.client.checkCode('PROMO1'), { type: 'promo_code' })
    assert.deepEqual(only(net.calls).body, { code: 'PROMO1' })
  })
})

// ---- credit and birthday gift ----

describe('getAvailableCredits', () => {
  test('asks for unexpired credit with a balance, soonest expiry first', async () => {
    const net = fakeNetwork({ 'GET /credits': ok({ items: [{ id: 'c1', availableBalance: '500' }], pagination: { hasNextPage: false } }) })
    const credits = await net.client.getAvailableCredits()
    assert.equal(nth(credits, 0).availableBalance, 500)
    const params = only(net.calls).url.searchParams
    assert.equal(params.get('status[ne]'), 'expired')
    assert.equal(params.get('availableBalance[gt]'), '0')
    assert.equal(params.get('sort[expiresAt]'), 'asc')
  })

  test('stops after 10 pages of 100 even when the API says there are more', async () => {
    const net = fakeNetwork({
      'GET /credits': (_call, n) =>
        json(200, { items: Array.from({ length: 100 }, (_, i) => ({ id: `c${n}-${i}` })), pagination: { hasNextPage: n < 15 } }),
    })
    const credits = await net.client.getAvailableCredits()
    assert.equal(net.calls.length, 10)
    assert.equal(credits.length, 1000)
  })
})

describe('getBirthdayGift', () => {
  test('a gift is returned, asked for with the time zone offset', async () => {
    const net = fakeNetwork({ 'GET /customers/me/birthday-gift': ok({ value: 1000, cardTransactionRequirementMet: false }) })
    assert.deepEqual(await net.client.getBirthdayGift(), { value: 1000, cardTransactionRequirementMet: false })
    assert.match(only(net.calls).url.searchParams.get('location[utcOffset]') ?? '', UTC_OFFSET)
  })

  for (const status of [400, 404]) {
    test(`a ${status} means no gift right now: null`, async () => {
      const net = fakeNetwork({ 'GET /customers/me/birthday-gift': () => json(status, { message: 'No birthday gift' }) })
      assert.equal(await net.client.getBirthdayGift(), null)
    })
  }

  test('an empty 204 means no gift: null', async () => {
    const net = fakeNetwork({ 'GET /customers/me/birthday-gift': () => new Response(null, { status: 204 }) })
    assert.equal(await net.client.getBirthdayGift(), null)
  })

  test('a 500 is an error, not "no gift"', async () => {
    const net = fakeNetwork({ 'GET /customers/me/birthday-gift': () => json(500, { message: 'oops' }) })
    await assert.rejects(net.client.getBirthdayGift(), (err) => err instanceof ApiError && err.status === 500)
  })

  test('a gift of the wrong shape is an error, not "no gift"', async () => {
    const net = fakeNetwork({ 'GET /customers/me/birthday-gift': ok({ value: 'lots' }) })
    await assert.rejects(net.client.getBirthdayGift(), ResponseShapeError)
  })
})

// ---- answers a read cannot use ----

describe('answers a read cannot use', () => {
  test('an empty 200 body is an error naming the endpoint', async () => {
    const net = fakeNetwork({ 'GET /customers/me': () => new Response('', { status: 200 }) })
    await assert.rejects(net.client.getProfile(), (err) => {
      assert.ok(err instanceof ResponseShapeError)
      assert.equal(err.message, 'Unexpected empty response from GET /customers/me.')
      return true
    })
  })

  test('a 200 that is not JSON is an error naming the endpoint and status', async () => {
    const net = fakeNetwork({ 'GET /customers/me': () => new Response('<html>maintenance</html>', { status: 200 }) })
    await assert.rejects(net.client.getProfile(), (err) => {
      assert.ok(err instanceof ResponseShapeError)
      assert.equal(err.message, 'Unexpected response from GET /customers/me (not JSON, HTTP 200).')
      return true
    })
  })

  test('a known referral error code is explained in words', async () => {
    const net = fakeNetwork({ 'POST /customer-referral-code-redemptions': () => json(400, { code: 13001, message: 'raw message' }) })
    await assert.rejects(net.client.redeemFriendReferralCode('FRIEND1'), (err) => {
      assert.ok(err instanceof ApiError)
      assert.equal(err.message, 'You cannot use your own referral code. (HTTP 400 on POST /customer-referral-code-redemptions)')
      return true
    })
  })

  test('a JSON error body with no message is reported by endpoint and status', async () => {
    const net = fakeNetwork({ 'GET /customers/me': () => json(500, { other: 'x' }) })
    await assert.rejects(net.client.getProfile(), (err) => messageOf(err) === 'GET /customers/me failed: HTTP 500')
  })
})

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- venues (Algolia) ----

describe('venues', () => {
  const KEY = { secret: 'algolia-key-fake', venueIndexName: 'venues_fake' }

  test('searchVenues queries the venue index for Australian venues, 20 by default, with ranking info and no coordinate', async () => {
    const net = fakeNetwork({
      'POST /algolia-api-keys': ok(KEY),
      'ALGOLIA /1/indexes/venues_fake/query': ok({ hits: [{ objectID: 'venue-1' }] }),
    })
    const venues = await net.client.searchVenues('newtown', {})
    assert.deepEqual(
      venues.map((v) => v.objectID),
      ['venue-1']
    )
    const body = record(nth(net.calls, 1).body, 'body')
    assert.equal(body.query, 'newtown')
    assert.equal(body.filters, 'NOT region:"New Zealand"')
    assert.equal(body.hitsPerPage, 20)
    assert.equal(body.getRankingInfo, true)
    assert.ok(!('aroundLatLng' in body) && !('aroundRadius' in body), JSON.stringify(body))
    assert.equal(nth(net.calls, 1).headers.get('X-Algolia-API-Key'), 'algolia-key-fake')
  })

  test('searchVenues near a coordinate sends it with a 20 km radius by default, or the radius and limit given', async () => {
    const net = fakeNetwork({ 'POST /algolia-api-keys': ok(KEY), 'ALGOLIA /1/indexes/venues_fake/query': ok({ hits: null }) })
    assert.deepEqual(await net.client.searchVenues('', { near: { latitude: -33.9, longitude: 151.18 } }), [])
    await net.client.searchVenues('', { near: { latitude: -33.9, longitude: 151.18 }, radiusMetres: 2500, limit: 5 })
    const bodies = net.calls.filter((c) => c.host === ALGOLIA_HOST).map((c) => record(c.body, 'body'))
    assert.equal(nth(bodies, 0).aroundLatLng, '-33.9, 151.18')
    assert.equal(nth(bodies, 0).aroundRadius, 20_000)
    assert.equal(nth(bodies, 1).aroundRadius, 2500)
    assert.equal(nth(bodies, 1).hitsPerPage, 5)
  })

  test('getVenuesByIds with no ids makes no call at all', async () => {
    const net = fakeNetwork({})
    assert.deepEqual(await net.client.getVenuesByIds([]), [])
    assert.deepEqual(net.calls, [])
  })

  test('getVenuesByIds asks the venue index for each id and drops ids Algolia does not know', async () => {
    const net = fakeNetwork({
      'POST /algolia-api-keys': ok(KEY),
      'ALGOLIA /1/indexes/*/objects': ok({ results: [{ objectID: 'venue-1', title: 'The Local' }, null] }),
    })
    const venues = await net.client.getVenuesByIds(['venue-1', 'venue-gone'])
    assert.deepEqual(
      venues.map((v) => v.title),
      ['The Local']
    )
    assert.deepEqual(field(nth(net.calls, 1).body, 'requests'), [
      { indexName: 'venues_fake', objectID: 'venue-1' },
      { indexName: 'venues_fake', objectID: 'venue-gone' },
    ])
  })

  test('a key that expires within a minute is replaced before the next lookup', async () => {
    const soon = new Date(Date.now() + 30_000).toISOString()
    const net = fakeNetwork({
      'POST /algolia-api-keys': (_call, n) => json(200, { ...KEY, secret: `algolia-key-fake-${n}`, expiresAt: soon }),
      'ALGOLIA /1/indexes/*/objects': ok({ results: [] }),
    })
    await net.client.getVenuesByIds(['venue-1'])
    await net.client.getVenuesByIds(['venue-1'])
    const keys = net.calls.filter((c) => c.host === ALGOLIA_HOST).map((c) => c.headers.get('X-Algolia-API-Key'))
    assert.deepEqual(keys, ['algolia-key-fake-1', 'algolia-key-fake-2'])
  })

  test('a key valid for an hour is reused', async () => {
    const later = new Date(Date.now() + 3_600_000).toISOString()
    const net = fakeNetwork({
      'POST /algolia-api-keys': (_call, n) => json(200, { ...KEY, secret: `algolia-key-fake-${n}`, expiresAt: later }),
      'ALGOLIA /1/indexes/*/objects': ok({ results: [] }),
    })
    await net.client.getVenuesByIds(['venue-1'])
    await net.client.getVenuesByIds(['venue-1'])
    assert.equal(net.calls.filter((c) => c.path === '/algolia-api-keys').length, 1)
  })

  test("an Algolia error shows Algolia's message and the status", async () => {
    const net = fakeNetwork({
      'POST /algolia-api-keys': ok(KEY),
      'ALGOLIA /1/indexes/venues_fake/query': () => json(400, { message: 'Invalid filter' }),
    })
    await assert.rejects(net.client.searchVenues('x', {}), (err) => messageOf(err) === 'Venue search failed (Invalid filter, HTTP 400)')
  })

  test('an Algolia 200 that is not JSON is an error naming the call', async () => {
    const net = fakeNetwork({
      'POST /algolia-api-keys': ok(KEY),
      'ALGOLIA /1/indexes/*/objects': () => new Response('nope', { status: 200 }),
    })
    await assert.rejects(net.client.getVenuesByIds(['venue-1']), (err) => {
      assert.ok(err instanceof ResponseShapeError)
      assert.equal(err.message, 'Unexpected response from Venue lookup (not JSON).')
      return true
    })
  })
})

// ---- writes: what each sends ----

describe('writes send the request the app sends', () => {
  const OFFER: OfferDetails = { id: 'offer-1', activated: false, strategy: 'credit', value: 500, type: 'single_step' }

  test('activateOffer activates an in-app offer', async () => {
    const net = fakeNetwork({ 'POST /in-app-offer-customer-activations': () => new Response(null, { status: 204 }) })
    assert.equal(await net.client.activateOffer(OFFER), 'activated')
    assert.deepEqual(only(net.calls).body, { offer: '/offers/offer-1' })
  })

  test('activateOffer redeems an instant reward, with the time zone offset', async () => {
    const net = fakeNetwork({ 'POST /instant-reward-offer-redemptions': () => new Response(null, { status: 204 }) })
    assert.equal(await net.client.activateOffer({ ...OFFER, type: 'instant_reward' }), 'redeemed')
    const body = record(only(net.calls).body, 'body')
    assert.equal(body.offer, '/offers/offer-1')
    assert.match(String(field(body.location, 'utcOffset')), UTC_OFFSET)
  })

  const WRITES: [string, string, (c: PubPointsClient) => Promise<unknown>, unknown][] = [
    [
      'redeemPoints',
      'POST /points-redemptions',
      (c) => c.redeemPoints('reward-a'),
      { pointsExchangeRate: '/points-exchange-rates/reward-a' },
    ],
    ['redeemGiftVoucher', 'POST /gift-voucher-redemptions', (c) => c.redeemGiftVoucher('GIFT123'), { code: 'GIFT123' }],
    ['redeemPromoCode', 'POST /promo-code-redemptions', (c) => c.redeemPromoCode('PROMO1'), { promoCode: '/promo-codes/PROMO1' }],
    ['joinOrganisation', 'POST /customer-organisations', (c) => c.joinOrganisation('GROUP1'), { code: 'GROUP1' }],
    ['activateOfferCode', 'POST /code-offer-customer-activations', (c) => c.activateOfferCode('OFFER1'), { code: 'OFFER1' }],
    [
      'redeemFriendReferralCode',
      'POST /customer-referral-code-redemptions',
      (c) => c.redeemFriendReferralCode('FRIEND1'),
      { code: 'FRIEND1' },
    ],
    ['addFavouriteVenue', 'POST /favourite-venues', (c) => c.addFavouriteVenue('venue-1'), { venue: '/venues/venue-1' }],
    ['removeFavouriteVenue', 'DELETE /favourite-venues/fav-9', (c) => c.removeFavouriteVenue('fav-9'), undefined],
    [
      'addCommunicationPreference',
      'POST /communication-preferences',
      (c) => c.addCommunicationPreference('sms_offers'),
      { type: 'sms_offers' },
    ],
    [
      'removeCommunicationPreference',
      'DELETE /communication-preferences/pref-1',
      (c) => c.removeCommunicationPreference('pref-1'),
      undefined,
    ],
  ]
  for (const [name, route, run, body] of WRITES) {
    test(`${name} sends ${route} with ${JSON.stringify(body)}`, async () => {
      const net = fakeNetwork({ [route]: () => new Response(null, { status: 204 }) })
      await run(net.client)
      const call = only(net.calls)
      assert.equal(`${call.method} ${call.path}`, route)
      assert.deepEqual(call.body, body)
      assert.equal(call.headers.get('Authorization'), 'Bearer id-token-fake')
    })
  }

  test('redeemBirthdayGift posts the time zone offset', async () => {
    const net = fakeNetwork({ 'POST /customers/me/birthday-gift/redemptions': () => new Response(null, { status: 204 }) })
    await net.client.redeemBirthdayGift()
    assert.match(String(field(field(only(net.calls).body, 'location'), 'utcOffset')), UTC_OFFSET)
  })

  test('the redemption answers are parsed: gift voucher credit, promo discount, group joined, offer activated', async () => {
    const net = fakeNetwork({
      'POST /gift-voucher-redemptions': ok({ credit: { availableBalance: '5000' } }),
      'POST /promo-code-redemptions': ok({ discount: { value: 10 } }),
      'POST /customer-organisations': ok({ organisation: { name: 'Acme Club', discount: 10 } }),
      'POST /code-offer-customer-activations': ok({ offer: { displaySettings: { title: 'Code Offer' } } }),
    })
    assert.equal((await net.client.redeemGiftVoucher('GIFT123'))?.credit?.availableBalance, 5000)
    assert.equal((await net.client.redeemPromoCode('PROMO1'))?.discount?.value, 10)
    assert.equal((await net.client.joinOrganisation('GROUP1'))?.organisation?.name, 'Acme Club')
    assert.equal((await net.client.activateOfferCode('OFFER1'))?.offer?.displaySettings?.title, 'Code Offer')
  })
})

/** Guards the fake itself: outside /public/ it answers nothing that carries no ID token. */
test('the fake API refuses a request without an ID token outside /public/', async () => {
  const net = fakeNetwork({ 'GET /customers/me': ok({}), 'GET /public/settings': ok({}) }, { getIdToken: () => Promise.resolve('') })
  await assert.rejects(net.client.getProfile(), (err) => err instanceof ApiError && err.status === 401)
  assert.deepEqual(await net.client.getPublicSettings(), {})
})
