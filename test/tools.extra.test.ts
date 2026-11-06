// SPDX-License-Identifier: GPL-3.0-or-later
// Tool-level checks beyond §10's minimum: ID and code validation (§9), offer branches (§3),
// partial preference failures and pre-write failures (§4), venue lookup notes and the offer
// search concurrency cap (§9), output schemas (§9), and the spending order filter (§5).
// Review findings 4, 9, 10, 11, 12 and 15.
//
// Seams assumed beyond §11: none. Read methods a test needs beyond the harness fake
// (searchOffers, searchVenues, getOrders) are added to that test's fake before the call;
// tools look the method up on the client at call time.

import './backstop.ts'
import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AuthError } from '../dist/auth.js'
import { ApiError } from '../dist/api.js'
import type { OfferDetails, OrderDetails, OrderFilter, OrderSummary } from '../dist/api.js'
import { connect, defaultState, field, nth, present, record, records, structuredField, structuredOf, textOf } from './harness.ts'
import type { FakeState, Harness } from './harness.ts'

const INPUT_VALIDATION = /Input validation error/

async function preview(h: Harness, tool: string, args: Record<string, unknown>) {
  const result = await h.call(tool, args)
  assert.equal(structuredField(result, 'status'), 'confirmation_required', textOf(result))
  return structuredOf(result)
}

// ---- finding 4: ID and code validation ----

describe('ID validation (§9)', () => {
  const BAD_IDS = ['..', 'a/b', '../offer-inapp', 'x'.repeat(65), '', 'offer inapp', 'offer%2F1']
  const ID_TOOLS = [
    { tool: 'pub_points_activate_offer', field: 'offerId' },
    { tool: 'pub_points_redeem_points', field: 'rewardId' },
    { tool: 'pub_points_add_favourite_venue', field: 'venueId' },
    { tool: 'pub_points_remove_favourite_venue', field: 'venueId' },
    { tool: 'pub_points_offer_details', field: 'offerId' },
    { tool: 'pub_points_order_details', field: 'orderId' },
  ]
  for (const { tool, field } of ID_TOOLS) {
    for (const bad of BAD_IDS) {
      test(`${tool} rejects ${field}=${JSON.stringify(bad.length > 20 ? `${bad.length} chars` : bad)} before any client call`, async (t) => {
        const h = await connect(t)
        const result = await h.call(tool, { [field]: bad })
        assert.equal(result.isError, true)
        assert.match(textOf(result), INPUT_VALIDATION)
        assert.deepEqual(h.fake.reads, [])
        assert.deepEqual(h.fake.writes, [])
      })
    }
  }

  test('a 64-character id with dashes passes validation and reaches the client', async (t) => {
    const h = await connect(t)
    const id = `a-${'b'.repeat(62)}`
    assert.equal(id.length, 64)
    const result = await h.call('pub_points_activate_offer', { offerId: id })
    assert.doesNotMatch(textOf(result), INPUT_VALIDATION)
    assert.deepEqual(
      h.fake.reads.map((r) => [r.method, r.args[0]]),
      [['getOfferDetails', id]]
    )
  })

  test('pub_points_venue_offers rejects a list holding one bad venue id', async (t) => {
    const h = await connect(t)
    const result = await h.call('pub_points_venue_offers', { venueIds: ['venue-1', '../venue-2'] })
    assert.equal(result.isError, true)
    assert.match(textOf(result), INPUT_VALIDATION)
    assert.deepEqual(h.fake.reads, [])
  })
})

describe('code validation (§9)', () => {
  const CODE_TOOLS = ['pub_points_redeem_code', 'pub_points_join_organisation', 'pub_points_check_code']
  const BAD_CODES = [' abc-123 ', 'PROMO 1', 'A'.repeat(33), '   ', '../PROMO1', 'PRÖMO1']
  for (const tool of CODE_TOOLS) {
    for (const bad of BAD_CODES) {
      test(`${tool} rejects code ${JSON.stringify(bad.length > 20 ? `${bad.length} chars` : bad)} before any client call`, async (t) => {
        const h = await connect(t)
        const result = await h.call(tool, { code: bad })
        assert.equal(result.isError, true)
        assert.match(textOf(result), INPUT_VALIDATION)
        assert.deepEqual(h.fake.reads, [])
      })
    }
  }

  test('a code is trimmed and upper-cased before it reaches the client', async (t) => {
    const h = await connect(t)
    await preview(h, 'pub_points_redeem_code', { code: '  promo1 ' })
    assert.equal(nth(h.fake.reads, 0).method, 'checkCode')
    assert.equal(nth(h.fake.reads, 0).args[0], 'PROMO1')
  })

  test('a 32-character code passes validation', async (t) => {
    const h = await connect(t)
    const result = await h.call('pub_points_check_code', { code: 'a'.repeat(32) })
    assert.doesNotMatch(textOf(result), INPUT_VALIDATION)
    assert.equal(nth(h.fake.reads, 0).args[0], 'A'.repeat(32))
  })
})

// ---- finding 10: offer branches ----

describe('activate offer branches', () => {
  function withOffer(patch: Partial<OfferDetails>) {
    const state = defaultState()
    state.offers['offer-x'] = {
      ...structuredClone(state.offers['offer-inapp']),
      id: 'offer-x',
      displaySettings: { title: 'Pint Deal' },
      ...patch,
    }
    return state
  }

  test('an instant reward is redeemed, and the result says so', async (t) => {
    const h = await connect(t, { state: withOffer({ type: 'instant_reward', activationStrategy: undefined }) })
    const sc = await preview(h, 'pub_points_activate_offer', { offerId: 'offer-x' })
    const done = await h.call('pub_points_activate_offer', { offerId: 'offer-x', confirmationToken: sc.confirmationToken })
    assert.match(textOf(done), /^Done:/)
    assert.ok(textOf(done).includes('redeemed'), textOf(done))
    assert.deepEqual(
      h.fake.writes.map((w) => [w.method, field(w.args[0], 'id')]),
      [['activateOffer', 'offer-x']]
    )
  })

  test('an instant reward already marked activated can still be redeemed', async (t) => {
    const h = await connect(t, { state: withOffer({ type: 'instant_reward', activated: true }) })
    const sc = await preview(h, 'pub_points_activate_offer', { offerId: 'offer-x' })
    assert.equal(typeof sc.confirmationToken, 'string')
  })

  test('an in-app offer already activated is a non-error "unchanged" with no token and no write', async (t) => {
    const h = await connect(t, { state: withOffer({ activated: true }) })
    const result = await h.call('pub_points_activate_offer', { offerId: 'offer-x' })
    assert.notEqual(result.isError, true, textOf(result))
    assert.equal(structuredField(result, 'status'), 'unchanged')
    assert.equal(structuredField(result, 'confirmationToken'), undefined)
    assert.ok(textOf(result).includes('Pint Deal'), textOf(result))
    assert.equal(h.fake.writes.length, 0)
  })

  test('an offer whose per-customer limit is reached is refused with no token and no write', async (t) => {
    const h = await connect(t, { state: withOffer({ limitPerCustomerReached: true }) })
    const result = await h.call('pub_points_activate_offer', { offerId: 'offer-x' })
    assert.equal(result.isError, true)
    assert.ok(textOf(result).includes('limit'), textOf(result))
    assert.equal(structuredField(result, 'confirmationToken'), undefined)
    assert.equal(h.fake.writes.length, 0)
  })

  test('an unknown offer id surfaces the API 404 with no write', async (t) => {
    const h = await connect(t)
    const result = await h.call('pub_points_activate_offer', { offerId: 'offer-missing' })
    assert.equal(result.isError, true)
    assert.ok(textOf(result).includes('HTTP 404'), textOf(result))
    assert.equal(h.fake.writes.length, 0)
  })
})

// ---- finding 11: one preference change succeeds, the other fails ----

describe('partial preference change (§4)', () => {
  const ARGS = { turnOn: ['push_offers'], turnOff: ['email_news'] }

  test('add succeeds, remove fails on the network: error naming both outcomes and the read tool', async (t) => {
    const state = defaultState()
    state.writeErrors.removeCommunicationPreference = new TypeError('fetch failed')
    const h = await connect(t, { state })
    const sc = await preview(h, 'pub_points_set_communication_preferences', ARGS)
    const result = await h.call('pub_points_set_communication_preferences', { ...ARGS, confirmationToken: sc.confirmationToken })
    assert.equal(result.isError, true)
    const text = textOf(result)
    assert.equal(h.fake.writes.length, 2)
    const lines = text.split('\n')
    const onLine = lines.find((l) => /offers on/i.test(l))
    const offLine = lines.find((l) => /news off/i.test(l))
    assert.ok(onLine?.includes('done') && !onLine.includes('may have'), text)
    assert.ok(offLine?.includes('may have been applied'), text)
    assert.ok(text.includes('Check with pub_points_communication_preferences before trying again.'), text)
  })

  test('remove is refused with a 4xx: that line says not done, not "may have been applied"', async (t) => {
    const state = defaultState()
    state.writeErrors.removeCommunicationPreference = new ApiError(
      'Preference not found (HTTP 404 on DELETE /communication-preferences/pref-1)',
      404
    )
    const h = await connect(t, { state })
    const sc = await preview(h, 'pub_points_set_communication_preferences', ARGS)
    const result = await h.call('pub_points_set_communication_preferences', { ...ARGS, confirmationToken: sc.confirmationToken })
    assert.equal(result.isError, true)
    const offLine = textOf(result)
      .split('\n')
      .find((l) => /news off/i.test(l))
    assert.ok(offLine && offLine.includes('not done') && !offLine.includes('may have been applied'), textOf(result))
  })
})

// ---- finding 12: failures before the write ----

describe('failures before the write (§4)', () => {
  test('a sign-in failure while checking account state: error, no write, no token', async (t) => {
    const state = defaultState()
    state.readErrors.getBalances = new AuthError('Not signed in to The Pass.')
    const h = await connect(t, { state })
    const result = await h.call('pub_points_redeem_points', { rewardId: 'reward-a' })
    assert.equal(result.isError, true)
    assert.ok(textOf(result).includes('Not signed in'), textOf(result))
    assert.equal(structuredField(result, 'confirmationToken'), undefined)
    assert.equal(h.fake.writes.length, 0)
  })

  test('a sign-in failure on the write call itself is "not applied", never "may have been applied"', async (t) => {
    const state = defaultState()
    state.writeErrors.redeemPoints = new AuthError('Session refresh failed (Invalid Refresh Token).')
    const h = await connect(t, { state })
    const sc = await preview(h, 'pub_points_redeem_points', { rewardId: 'reward-a' })
    const result = await h.call('pub_points_redeem_points', { rewardId: 'reward-a', confirmationToken: sc.confirmationToken })
    assert.equal(result.isError, true)
    assert.ok(textOf(result).includes('Session refresh failed'), textOf(result))
    assert.ok(!textOf(result).includes('may have been applied'), textOf(result))
  })
})

// ---- finding 9 (tool side): a failed venue lookup is visible ----

describe('venue names unavailable (§9)', () => {
  test('favourite venues: a failed lookup adds the note with the reason, and still lists the ids', async (t) => {
    const state = defaultState()
    state.venueLookupError = new ApiError('Venue lookup failed (HTTP 503)', 503)
    const h = await connect(t, { state })
    const result = await h.call('pub_points_favourite_venues', {})
    const text = textOf(result)
    assert.ok(text.includes('(venue names unavailable: Venue lookup failed (HTTP 503))'), text)
    assert.ok(text.includes('venue-2'), text)
  })

  test('venue offers by id: a failed lookup adds the note', async (t) => {
    const state = defaultState()
    state.venueLookupError = new Error('algolia down')
    const h = await connect(t, { state })
    h.fake.searchOffers = () => Promise.resolve([])
    const text = textOf(await h.call('pub_points_venue_offers', { venueIds: ['venue-1'] }))
    assert.ok(text.includes('(venue names unavailable: algolia down)'), text)
  })

  test('spending: a failed lookup adds the note above the venue list', async (t) => {
    const state = defaultState()
    state.venueLookupError = new Error('algolia down')
    const h = await connect(t, { state })
    h.fake.getOrders = () =>
      Promise.resolve({
        orders: [
          {
            id: 'o1',
            status: 'completed',
            chargeAmount: 1000,
            earnedPointsAmount: 100,
            venue: { id: 'venue-1' },
            createdAt: '2026-10-15T02:00:00Z',
          },
        ],
        complete: true,
      })
    const text = textOf(await h.call('pub_points_spending', {}))
    assert.ok(text.includes('(venue names unavailable: algolia down)'), text)
  })
})

// ---- finding 15: concurrency cap ----

describe('venue offers concurrency (§9)', () => {
  test('at most 5 offer searches run at once, and all 12 venues are searched', async (t) => {
    const h = await connect(t)
    let inFlight = 0
    let peak = 0
    const searched: (string | undefined)[] = []
    h.fake.searchOffers = async (filter) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      searched.push(present(filter.venues, 'filter.venues')[0])
      await new Promise((r) => setTimeout(r, 15))
      inFlight--
      return []
    }
    const ids = Array.from({ length: 12 }, (_, i) => `venue-${i + 1}`)
    await h.call('pub_points_venue_offers', { venueIds: ids })
    assert.equal(peak, 5)
    assert.deepEqual([...searched].sort(), [...ids].sort())
  })
})

// ---- finding 15: output schemas ----

describe('output schemas (§9)', () => {
  test('offers, orders, find_venues, rewards and every action tool declare an object outputSchema', async (t) => {
    const h = await connect(t)
    const { tools } = await h.client.listTools()
    const names = [
      'pub_points_offers',
      'pub_points_orders',
      'pub_points_find_venues',
      'pub_points_rewards',
      'pub_points_activate_offer',
      'pub_points_redeem_points',
      'pub_points_redeem_code',
      'pub_points_join_organisation',
      'pub_points_redeem_birthday_gift',
      'pub_points_set_communication_preferences',
      'pub_points_add_favourite_venue',
      'pub_points_remove_favourite_venue',
    ]
    for (const name of names) {
      const schema = tools.find((tool) => tool.name === name)?.outputSchema
      assert.equal(schema?.type, 'object', `${name} outputSchema`)
    }
  })

  test('an action tool outputSchema covers status, action, confirmationToken and expiresAt', async (t) => {
    const h = await connect(t)
    const { tools } = await h.client.listTools()
    const props = record(
      present(
        tools.find((tool) => tool.name === 'pub_points_redeem_points'),
        'pub_points_redeem_points'
      ).outputSchema?.properties,
      'outputSchema.properties'
    )
    for (const key of ['status', 'action', 'confirmationToken', 'expiresAt']) assert.ok(key in props, key)
  })

  test('pub_points_rewards returns structuredContent matching the fixture', async (t) => {
    const h = await connect(t)
    const result = await h.call('pub_points_rewards', {})
    assert.equal(structuredOf(result).pointsBalance, 1500)
    assert.deepEqual(
      records(structuredOf(result).rewards).map((r) => [r.id, r.canRedeemNow]),
      [
        ['reward-a', true],
        ['reward-b', true],
        ['reward-c', false],
      ]
    )
  })
})

// ---- §5 at the tool: what pub_points_spending asks the client for ----

describe('spending order filter (§5)', () => {
  test('asks for completed orders between the start and end of the given Sydney days', async (t) => {
    const h = await connect(t)
    const filters: OrderFilter[] = []
    h.fake.getOrders = (filter) => {
      filters.push(filter)
      return Promise.resolve({ orders: [], complete: true })
    }
    await h.call('pub_points_spending', { from: '2026-10-01', to: '2026-10-31' })
    assert.equal(filters.length, 1)
    const f = nth(filters, 0)
    assert.equal(f.status, 'completed')
    // 1 Oct 2026 00:00 in Sydney is AEST (+10): 30 Sep 14:00Z
    assert.equal(Date.parse(present(f.after, 'after')), Date.UTC(2026, 8, 30, 14, 0, 0))
    // 31 Oct 2026 23:59:59 in Sydney is AEDT (+11): 31 Oct 12:59:59Z
    assert.equal(Date.parse(present(f.before, 'before')), Date.UTC(2026, 9, 31, 12, 59, 59))
  })
})

// ---- redeem_points refuses amounts it cannot compare ----

describe('redeem points with a non-finite amount', () => {
  const CHANGES: [string, (s: FakeState) => void][] = [
    ['balance NaN', (s) => (s.balances.pointsBalance = Number.NaN)],
    ['balance Infinity', (s) => (s.balances.pointsBalance = Number.POSITIVE_INFINITY)],
    ['cost NaN', (s) => (nth(s.rates, 0).pointsAmount = Number.NaN)],
    ['cost -Infinity', (s) => (nth(s.rates, 0).pointsAmount = Number.NEGATIVE_INFINITY)],
  ]
  for (const [label, change] of CHANGES) {
    test(`${label}: refused, no token, no write`, async (t) => {
      const state = defaultState()
      change(state)
      const h = await connect(t, { state })
      const result = await h.call('pub_points_redeem_points', { rewardId: 'reward-a' })
      assert.equal(result.isError, true, textOf(result))
      assert.equal(structuredField(result, 'confirmationToken'), undefined)
      assert.equal(h.fake.writes.length, 0)
    })
  }
})

// ---- pub_points_orders: venueSearchCapped ----

describe('orders venue filter cap', () => {
  const ORDERS: OrderSummary[] = [
    {
      id: 'o1',
      status: 'completed',
      chargeAmount: 1000,
      earnedPointsAmount: 100,
      venue: { id: 'venue-1' },
      createdAt: '2026-10-15T02:00:00Z',
    },
    {
      id: 'o2',
      status: 'completed',
      chargeAmount: 500,
      earnedPointsAmount: 50,
      venue: { id: 'venue-2' },
      createdAt: '2026-10-14T02:00:00Z',
    },
  ]

  const CAP_CASES: [string, { venue?: string }, boolean, boolean][] = [
    ['venue filter, scan stopped at the cap', { venue: 'local' }, false, true],
    ['venue filter, whole list scanned', { venue: 'local' }, true, false],
    ['no venue filter, more orders exist', {}, false, false],
  ]
  for (const [label, args, complete, capped] of CAP_CASES) {
    test(`${label}: venueSearchCapped=${capped}`, async (t) => {
      const h = await connect(t)
      h.fake.getOrders = () => Promise.resolve({ orders: ORDERS, complete })
      const result = await h.call('pub_points_orders', args)
      assert.equal(structuredOf(result).venueSearchCapped, capped)
      assert.equal(textOf(result).includes('were searched for'), capped, textOf(result))
      if (args.venue)
        assert.deepEqual(
          records(structuredOf(result).orders).map((o) => o.id),
          ['o1']
        )
    })
  }
})

// ---- pub_points_order_details: venue from orders within 60 s of the receipt ----

describe('order details venue lookup', () => {
  const RECEIPT: OrderDetails = { id: 'o-old', createdAt: '2025-03-01T08:30:00Z', items: [], totalAmountWithTax: 1200, chargeAmount: 1200 }

  function withOrders(t: TestContext, orders: OrderSummary[], details: OrderDetails = RECEIPT) {
    return connect(t).then((h) => {
      const filters: OrderFilter[] = []
      h.fake.getOrder = () => Promise.resolve(structuredClone(details))
      h.fake.getOrders = (filter) => {
        filters.push(filter)
        return Promise.resolve({ orders, complete: true })
      }
      return Object.assign(h, { filters })
    })
  }

  test('asks for orders from 60 s before to 60 s after the receipt time, and names the venue', async (t) => {
    const h = await withOrders(t, [
      { id: 'o-old', status: 'completed', chargeAmount: 1200, venue: { id: 'venue-1' }, createdAt: RECEIPT.createdAt },
    ])
    const text = textOf(await h.call('pub_points_order_details', { orderId: 'o-old' }))
    assert.equal(h.filters.length, 1)
    const window = nth(h.filters, 0)
    assert.equal(Date.parse(present(window.after, 'after')), Date.UTC(2025, 2, 1, 8, 29, 0))
    assert.equal(Date.parse(present(window.before, 'before')), Date.UTC(2025, 2, 1, 8, 31, 0))
    assert.ok(text.includes('The Local'), text)
    assert.ok(!text.includes('venue name unavailable'), text)
  })

  test('an order missing from that window gives a visible note, not a wrong venue', async (t) => {
    const h = await withOrders(t, [
      { id: 'o-other', status: 'completed', chargeAmount: 900, venue: { id: 'venue-2' }, createdAt: RECEIPT.createdAt },
    ])
    const text = textOf(await h.call('pub_points_order_details', { orderId: 'o-old' }))
    assert.ok(text.includes('venue name unavailable'), text)
    assert.ok(!text.includes('The Royal'), text)
  })

  test('a failed order lookup gives the venue-names note', async (t) => {
    const h = await connect(t)
    h.fake.getOrder = () => Promise.resolve(structuredClone(RECEIPT))
    h.fake.getOrders = () => Promise.reject(new ApiError('Service Unavailable (HTTP 503 on GET /orders)', 503))
    const text = textOf(await h.call('pub_points_order_details', { orderId: 'o-old' }))
    assert.ok(text.includes('(venue names unavailable: Service Unavailable (HTTP 503 on GET /orders))'), text)
  })
})

// ---- pub_points_redeem_birthday_gift refuses before any token ----

describe('birthday gift refusals', () => {
  const CASES: [string, FakeState['birthday'], string][] = [
    ['no gift', null, 'No birthday gift is available right now.'],
    ['a gift worth nothing', { value: 0 }, 'No birthday gift is available right now.'],
    [
      'a gift locked behind a card transaction',
      { value: 1000, cardTransactionRequirementMet: false },
      'The birthday gift is locked: it needs a card transaction through The Pass first.',
    ],
  ]
  for (const [label, birthday, message] of CASES) {
    test(`${label}: refused with the reason, no token, no write`, async (t) => {
      const state = defaultState()
      state.birthday = birthday
      const h = await connect(t, { state })
      const result = await h.call('pub_points_redeem_birthday_gift', {})
      assert.equal(result.isError, true)
      assert.equal(textOf(result), message)
      assert.equal(structuredField(result, 'confirmationToken'), undefined)
      assert.equal(h.fake.writes.length, 0)
    })
  }
})
