// SPDX-License-Identifier: GPL-3.0-or-later
// runDoctor's single-record checks, which reuse ids found by the list checks before them, and
// the rule that doctor only reads. Asked for by the lead after the code-review round.
//
// Seams used: runDoctor(client, signal) takes any object with the client methods; the session
// check reads PUB_POINTS_CONFIG_DIR, so each test points it at its own directory.

import { TEST_CONFIG_DIR } from './backstop.ts'
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDoctor } from '../dist/doctor.js'
import { AuthError } from '../dist/auth.js'
import type { BirthdayGift, OrderDetails, PubPointsApi } from '../dist/api.js'
import type { CheckResult } from '../dist/doctor.js'
import { present } from './harness.ts'
import type { WriteMethod } from './harness.ts'

afterEach(() => {
  process.env.PUB_POINTS_CONFIG_DIR = TEST_CONFIG_DIR
})

function signedIn() {
  const dir = mkdtempSync(join(tmpdir(), `ppm-doctor-${process.pid}-`))
  writeFileSync(
    join(dir, 'session.json'),
    JSON.stringify({ email: 'member@example.com', refreshToken: 'refresh-fake-doctor', savedAt: '2026-11-05T00:00:00.000Z' })
  )
  process.env.PUB_POINTS_CONFIG_DIR = dir
}

/** One recorded client call: the method name and its arguments without the AbortSignal. */
type DoctorCall = [string, unknown[]]

/** A method doctor never reads; runDoctor fails the run if it is called. */
function notServed(method: keyof PubPointsApi): () => Promise<never> {
  return () => Promise.reject(new TypeError(`the doctor fake does not serve ${method}`))
}

/** A client whose every read answers with the fields doctor checks; `lists: false` makes every list empty. */
function doctorClient({
  lists = true,
  birthday = { value: 1000 },
  fail = {},
}: { lists?: boolean; birthday?: BirthdayGift | null; fail?: Partial<Record<keyof PubPointsApi, Error>> } = {}) {
  const calls: DoctorCall[] = []
  const writes: DoctorCall[] = []
  const rec =
    <A extends unknown[], R>(name: keyof PubPointsApi, fn: (...args: A) => R) =>
    (...args: A): Promise<R> =>
      new Promise((resolve) => {
        calls.push([name, args.filter((a) => !(a instanceof AbortSignal))])
        const err = fail[name]
        if (err) throw err
        resolve(fn(...args))
      })
  const refuse =
    (method: WriteMethod) =>
    (...args: unknown[]): Promise<never> => {
      writes.push([method, args])
      return Promise.reject(new Error(`doctor must not call ${method}`))
    }
  const client: PubPointsApi & { calls: DoctorCall[]; writes: DoctorCall[] } = {
    calls,
    writes,
    checkAppVersion: rec('checkAppVersion', () => ({ updateType: 'none' })),
    getPublicSettings: rec('getPublicSettings', () => ({})),
    getBalances: rec('getBalances', () => ({ pointsBalance: 1500, creditBalance: 2500 })),
    getCustomerTier: rec('getCustomerTier', () => ({ tier: { name: 'Gold', benefits: [] }, spendAmount: 100 })),
    getTiers: rec('getTiers', () => ({ items: [{ name: 'Gold', benefits: [] }] })),
    getPointsExchangeRates: rec('getPointsExchangeRates', () => ({
      items: [{ id: 'reward-a', pointsAmount: 1000, creditAmount: 1000 }],
    })),
    getAvailableCredits: rec('getAvailableCredits', () => [{ id: 'credit-1' }]),
    getActivities: rec('getActivities', () => ({
      items: [{ id: 'a1', type: 'order', createdAt: '2026-11-01T00:00:00Z', data: {} }],
      truncated: false,
    })),
    getOrders: rec('getOrders', () => ({
      orders: lists
        ? [{ id: 'o1', chargeAmount: 1000, status: 'completed', venue: { id: 'venue-1' }, createdAt: '2026-11-01T00:00:00Z' }]
        : [],
      complete: true,
    })),
    getCustomerOrganisations: rec('getCustomerOrganisations', () =>
      lists ? [{ id: 'm1', organisation: { id: 'org-1', name: 'Acme' } }] : []
    ),
    searchOffers: rec('searchOffers', () =>
      lists
        ? [
            {
              id: 'offer-1',
              activated: false,
              strategy: 'credit',
              value: 500,
              activationStrategy: 'in_app',
              displaySettings: { title: 'Chips' },
            },
          ]
        : []
    ),
    getFavouriteVenues: rec('getFavouriteVenues', () => []),
    getCommunicationPreferences: rec('getCommunicationPreferences', () => []),
    getReferralCode: rec('getReferralCode', () => ({ code: 'FRIEND1' })),
    searchVenues: rec('searchVenues', () =>
      lists ? [{ objectID: 'venue-1', title: 'The Local', openingHours: { hours: {}, text: [] } }] : []
    ),
    getOfferDetails: rec('getOfferDetails', (id: string) => ({ id, activated: false, strategy: 'credit', value: 500 })),
    getOrder: rec('getOrder', (id: string) => ({ id, createdAt: '2026-11-01T00:00:00Z' })),
    getCustomerOrganisation: rec('getCustomerOrganisation', (id: string) => ({ id, organisation: { id: 'org-1', name: 'Acme' } })),
    getVenuesByIds: rec('getVenuesByIds', (ids: string[]) => ids.map((id) => ({ objectID: id, title: 'The Local' }))),
    getProfile: rec('getProfile', () => ({ email: 'member@example.com' })),
    getBirthdayGift: rec('getBirthdayGift', () => birthday),
    getPromoTiles: notServed('getPromoTiles'),
    getOfferVenueIds: notServed('getOfferVenueIds'),
    checkCode: notServed('checkCode'),
    activateOffer: refuse('activateOffer'),
    redeemPoints: refuse('redeemPoints'),
    redeemGiftVoucher: refuse('redeemGiftVoucher'),
    redeemPromoCode: refuse('redeemPromoCode'),
    joinOrganisation: refuse('joinOrganisation'),
    activateOfferCode: refuse('activateOfferCode'),
    redeemFriendReferralCode: refuse('redeemFriendReferralCode'),
    redeemBirthdayGift: refuse('redeemBirthdayGift'),
    addCommunicationPreference: refuse('addCommunicationPreference'),
    removeCommunicationPreference: refuse('removeCommunicationPreference'),
    addFavouriteVenue: refuse('addFavouriteVenue'),
    removeFavouriteVenue: refuse('removeFavouriteVenue'),
  }
  return client
}

const byName = (results: CheckResult[]) => new Map(results.map((r) => [r.name, r]))
const signal = () => new AbortController().signal

describe('runDoctor single-record checks', () => {
  test('use the ids the list checks found, and all pass', async () => {
    signedIn()
    const client = doctorClient()
    const results = byName(await runDoctor(client, signal()))
    for (const name of ['Offer details', 'Order receipt', 'Group details', 'Venue lookup', 'Profile', 'Birthday gift']) {
      assert.equal(results.get(name)?.status, 'ok', `${name}: ${JSON.stringify(results.get(name))}`)
    }
    const argsOf = (method: string) => client.calls.find(([m]) => m === method)?.[1]
    assert.deepEqual(argsOf('getOfferDetails'), ['offer-1'])
    assert.deepEqual(argsOf('getOrder'), ['o1'])
    assert.deepEqual(argsOf('getCustomerOrganisation'), ['m1'])
    assert.deepEqual(argsOf('getVenuesByIds'), [['venue-1']])
  })

  test('with empty lists they are skipped with a reason, not failed, and not called', async () => {
    signedIn()
    const client = doctorClient({ lists: false })
    const results = byName(await runDoctor(client, signal()))
    for (const name of ['Offer details', 'Order receipt', 'Group details', 'Venue lookup']) {
      const r = results.get(name)
      assert.equal(r?.status, 'skip', `${name}: ${JSON.stringify(r)}`)
      assert.match(present(r, name).detail, /no \w+ id from/)
    }
    for (const method of ['getOfferDetails', 'getOrder', 'getCustomerOrganisation', 'getVenuesByIds']) {
      assert.ok(!client.calls.some(([m]) => m === method), method)
    }
  })

  test('no birthday gift right now is a skip', async () => {
    signedIn()
    const results = byName(await runDoctor(doctorClient({ birthday: null }), signal()))
    assert.equal(results.get('Birthday gift')?.status, 'skip')
  })

  test('a response missing a checked field fails and names the field', async () => {
    signedIn()
    const client = doctorClient()
    client.getOrder = (id) => {
      // The API dropped createdAt: build the receipt, then remove the field doctor checks for.
      const receipt: OrderDetails = { id, createdAt: '2026-11-01T00:00:00Z' }
      Reflect.deleteProperty(receipt, 'createdAt')
      return Promise.resolve(receipt)
    }
    const r = present(byName(await runDoctor(client, signal())).get('Order receipt'), 'Order receipt')
    assert.equal(r.status, 'fail')
    assert.ok(r.detail.includes('createdAt'), r.detail)
  })

  test('a sign-in failure stops the run at that check', async () => {
    signedIn()
    const client = doctorClient({ fail: { getTiers: new AuthError('Session refresh failed.') } })
    const results = await runDoctor(client, signal())
    assert.equal(present(results.at(-1), 'last result').name, 'Tiers list')
    assert.equal(present(results.at(-1), 'last result').status, 'fail')
    assert.ok(!client.calls.some(([m]) => m === 'getPointsExchangeRates'))
  })

  test('without a session it checks only the public endpoints', async () => {
    process.env.PUB_POINTS_CONFIG_DIR = mkdtempSync(join(tmpdir(), `ppm-doctor-${process.pid}-`))
    const client = doctorClient()
    const results = await runDoctor(client, signal())
    assert.equal(present(results.at(-1), 'last result').name, 'Signed in')
    assert.equal(present(results.at(-1), 'last result').status, 'skip')
    assert.deepEqual(
      client.calls.map(([m]) => m),
      ['checkAppVersion', 'getPublicSettings']
    )
  })

  test('doctor never calls a write method', async () => {
    signedIn()
    const client = doctorClient()
    await runDoctor(client, signal())
    assert.deepEqual(client.writes, [])
  })
})
