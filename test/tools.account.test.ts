// SPDX-License-Identifier: GPL-3.0-or-later
// The read tools registered in tools-account.ts, through a real MCP client against the fake
// client: activity, spending, tiers, referral, promotions, offer details, offers, orders, order
// details, group discounts, favourite venues, profile and communication preferences. Expected
// lines are written out from each fixture, never rebuilt with the formatters the tools use.
//
// Dates are shown in Australia/Sydney (the default zone). Fixture instants sit at 01:00 to 02:00
// UTC, which is mid-morning the same calendar day in Sydney all year. September is avoided:
// en-AU spells it "Sept", which would make a line depend on the ICU version.

import './backstop.ts'
import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../dist/api.js'
import type {
  Activity,
  ActivityPage,
  CustomerOrganisation,
  CustomerOrganisationDetails,
  Offer,
  OrderDetails,
  OrderFilter,
  OrderList,
  OrderSummary,
  Profile,
  PublicSettings,
} from '../dist/api.js'
import { connect, defaultState, nth, present, records, structuredOf, textOf } from './harness.ts'

function offer(id: string, patch: Partial<Offer>): Offer {
  return {
    id,
    activated: false,
    strategy: 'credit',
    activationStrategy: 'auto',
    type: 'single_step',
    value: 500,
    startAt: '2026-01-01T00:00:00Z',
    endAt: null,
    displaySettings: { title: id },
    ...patch,
  }
}

// ---- pub_points_activity ----

describe('pub_points_activity', () => {
  const ACTIVITIES: Activity[] = [
    {
      id: 'a1',
      type: 'order',
      createdAt: '2026-10-20T01:00:00Z',
      data: { venue: 'The Local', amount: '1500', points: '150', status: 'completed' },
    },
    { id: 'a2', type: 'points_redemption', createdAt: '2026-10-10T01:00:00Z', data: { amount: '1000', points: '1000' } },
    { id: 'a3', type: 'order', createdAt: '2026-08-25T01:00:00Z', data: { venue: 'The Royal', amount: '2000', points: '200' } },
    {
      id: 'a4',
      type: 'customer_tier_change',
      createdAt: '2026-08-01T01:00:00Z',
      data: { tier: { name: 'Gold' }, transitionPointsAmount: 500 },
    },
  ]
  const LINES = {
    a1: '- 20 Oct 2026 Order: The Local, $15.00, +150 points',
    a2: '- 10 Oct 2026 Points redeemed for credit: $10.00, -1,000 points',
    a3: '- 25 Aug 2026 Order: The Royal, $20.00, +200 points',
    a4: '- 1 Aug 2026 Tier change: to Gold, +500 points bonus',
  }

  async function withActivity(t: TestContext, page: ActivityPage = { items: ACTIVITIES, truncated: false }) {
    const h = await connect(t)
    const since: (string | undefined)[] = []
    h.fake.getActivities = (from) => {
      since.push(from)
      return Promise.resolve(structuredClone(page))
    }
    return Object.assign(h, { since })
  }

  test('every record, newest first, read from the start of history when no date is given', async (t) => {
    const h = await withActivity(t)
    const text = textOf(await h.call('pub_points_activity', {}))
    assert.equal(text, [LINES.a1, LINES.a2, LINES.a3, LINES.a4].join('\n'))
    assert.deepEqual(h.since, [undefined])
  })

  test('types keeps only those activity types', async (t) => {
    const h = await withActivity(t)
    const text = textOf(await h.call('pub_points_activity', { types: ['order'] }))
    assert.equal(text, [LINES.a1, LINES.a3].join('\n'))
  })

  test('from and to keep records whose Sydney day is in range, and reading starts at the start of "from"', async (t) => {
    const h = await withActivity(t)
    const text = textOf(await h.call('pub_points_activity', { from: '2026-08-25', to: '2026-10-10' }))
    assert.equal(text, [LINES.a2, LINES.a3].join('\n'))
    // 25 Aug 2026 00:00 in Sydney is AEST (+10): 24 Aug 14:00Z
    assert.equal(Date.parse(present(h.since[0], 'since')), Date.UTC(2026, 7, 24, 14, 0, 0))
  })

  test('venue keeps records whose venue name contains the text, ignoring case', async (t) => {
    const h = await withActivity(t)
    const text = textOf(await h.call('pub_points_activity', { venue: 'ROYAL' }))
    assert.equal(text, LINES.a3)
  })

  test('limit shows the newest records and says how many more matched', async (t) => {
    const h = await withActivity(t)
    const text = textOf(await h.call('pub_points_activity', { limit: 2 }))
    assert.equal(text, [LINES.a1, LINES.a2, '(2 more; raise limit or narrow the dates)'].join('\n'))
  })

  test('a limit equal to the number of matches has no "more" line', async (t) => {
    const h = await withActivity(t)
    const text = textOf(await h.call('pub_points_activity', { limit: 4 }))
    assert.ok(!text.includes('more;'), text)
  })

  test('no match says so', async (t) => {
    const h = await withActivity(t)
    assert.equal(textOf(await h.call('pub_points_activity', { venue: 'nowhere' })), 'No matching activity.')
  })

  test('no match in a truncated read says so and still explains the truncation', async (t) => {
    const h = await withActivity(t, { items: ACTIVITIES, truncated: true })
    const lines = textOf(await h.call('pub_points_activity', { venue: 'nowhere' })).split('\n')
    assert.equal(lines[0], 'No matching activity.')
    assert.match(nth(lines, 1), /^\(Truncated: only the newest 2,000 records were read, back to 1 Aug 2026;/)
  })

  test('a date that is not YYYY-MM-DD is refused before any read', async (t) => {
    const h = await withActivity(t)
    const result = await h.call('pub_points_activity', { from: '1/8/2026' })
    assert.equal(result.isError, true)
    assert.deepEqual(h.since, [])
  })
})

// ---- pub_points_spending ----

describe('pub_points_spending', () => {
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
      chargeAmount: 3000,
      earnedPointsAmount: 300,
      venue: { id: 'venue-2' },
      createdAt: '2026-10-01T02:00:00Z',
    },
    {
      id: 'o3',
      status: 'completed',
      chargeAmount: 500,
      earnedPointsAmount: 50,
      venue: { id: 'venue-1' },
      createdAt: '2026-08-10T02:00:00Z',
    },
    {
      id: 'o4',
      status: 'reversed',
      chargeAmount: 9999,
      earnedPointsAmount: 999,
      venue: { id: 'venue-2' },
      createdAt: '2026-10-02T02:00:00Z',
    },
  ]

  async function withOrders(t: TestContext, list: OrderList = { orders: ORDERS, complete: true }) {
    const h = await connect(t)
    const filters: OrderFilter[] = []
    h.fake.getOrders = (filter) => {
      filters.push(filter)
      return Promise.resolve(structuredClone(list))
    }
    return Object.assign(h, { filters })
  }

  test('totals, average, points, top venues by spend and months in order; reversed orders left out', async (t) => {
    const h = await withOrders(t)
    // Completed: 1000 + 3000 + 500 = 4500 cents over 3 orders (average 1500); points 450.
    // The Royal 3000 (1 order), The Local 1500 (2 orders); Aug 500 (1), Oct 4000 (2).
    assert.equal(
      textOf(await h.call('pub_points_spending', {})),
      [
        'Orders: 3',
        'Total spent: $45.00 (average $15.00)',
        'Points earned: 450 points',
        '',
        '## Top venues',
        '- The Royal: $30.00 over 1 order',
        '- The Local: $15.00 over 2 orders',
        '',
        '## By month',
        '- 2026-08: $5.00 (1)',
        '- 2026-10: $40.00 (2)',
      ].join('\n')
    )
  })

  test('asks for up to 20,000 completed orders, with no date bounds when none are given', async (t) => {
    const h = await withOrders(t)
    await h.call('pub_points_spending', {})
    assert.deepEqual(h.filters, [{ after: undefined, before: undefined, status: 'completed', max: 20_000 }])
  })

  test('the period shows in the first line: "start" or "today" stands in for a missing bound', async (t) => {
    const cases: [Record<string, string>, string][] = [
      [{ from: '2026-08-01' }, 'Orders (2026-08-01 to today): 3'],
      [{ to: '2026-10-31' }, 'Orders (start to 2026-10-31): 3'],
      [{ from: '2026-08-01', to: '2026-10-31' }, 'Orders (2026-08-01 to 2026-10-31): 3'],
    ]
    for (const [args, first] of cases) {
      const h = await withOrders(t)
      assert.equal(textOf(await h.call('pub_points_spending', args)).split('\n')[0], first, JSON.stringify(args))
    }
  })

  test('topVenues limits the venue list', async (t) => {
    const h = await withOrders(t)
    const text = textOf(await h.call('pub_points_spending', { topVenues: 1 }))
    assert.ok(text.includes('## Top venues\n- The Royal: $30.00 over 1 order\n\n'), text)
  })

  test('an incomplete order list says the total counts only the newest 20,000', async (t) => {
    const h = await withOrders(t, { orders: ORDERS, complete: false })
    const text = textOf(await h.call('pub_points_spending', {}))
    assert.ok(text.includes('(Only the newest 20,000 orders were counted; give a later "from" for a complete total.)'), text)
  })

  test('a complete order list has no cap note', async (t) => {
    const h = await withOrders(t)
    assert.ok(!textOf(await h.call('pub_points_spending', {})).includes('Only the newest'))
  })

  test('a venue the lookup does not know shows its id; an order with no venue is "Unknown venue"', async (t) => {
    const h = await withOrders(t, {
      orders: [
        { id: 'o5', status: 'completed', chargeAmount: 700, venue: { id: 'venue-9' }, createdAt: '2026-10-15T02:00:00Z' },
        { id: 'o6', status: 'completed', chargeAmount: 200, venue: null, createdAt: '2026-10-15T02:00:00Z' },
      ],
      complete: true,
    })
    const text = textOf(await h.call('pub_points_spending', {}))
    assert.ok(text.includes('- venue id venue-9: $7.00 over 1 order'), text)
    assert.ok(text.includes('- Unknown venue: $2.00 over 1 order'), text)
    assert.ok(text.includes('Points earned: 0 points'), text)
  })

  test('no completed orders says so', async (t) => {
    const h = await withOrders(t, { orders: [], complete: true })
    assert.equal(textOf(await h.call('pub_points_spending', {})), 'No completed orders in that period.')
  })

  test('a failed order read is an error', async (t) => {
    const h = await connect(t)
    h.fake.getOrders = () => Promise.reject(new Error('orders down'))
    const result = await h.call('pub_points_spending', {})
    assert.equal(result.isError, true)
    assert.equal(textOf(result), 'orders down')
  })
})

// ---- pub_points_tiers ----

describe('pub_points_tiers', () => {
  const TIERS = {
    items: [
      { name: 'Gold', level: 2, benefits: [{ title: 'Free pint', description: 'One a <i>month</i>' }] },
      { name: 'Mystery' },
      { name: 'Silver', level: 1, benefits: [] },
    ],
  }

  test('every tier lowest level first, the member tier marked, and tiers with no level last', async (t) => {
    const h = await connect(t)
    h.fake.getTiers = () => Promise.resolve(structuredClone(TIERS))
    h.fake.getCustomerTier = () => Promise.resolve({ spendAmount: 0, tier: { name: 'Silver' } })
    assert.equal(
      textOf(await h.call('pub_points_tiers', {})),
      [
        '## Silver (your tier)',
        '(no benefits listed)',
        '',
        '## Gold',
        '- Free pint: One a month',
        '',
        '## Mystery',
        '(no benefits listed)',
        '',
      ].join('\n')
    )
  })

  test("a failed read of the member's tier still lists every tier, with none marked", async (t) => {
    const h = await connect(t)
    h.fake.getTiers = () => Promise.resolve(structuredClone(TIERS))
    const result = await h.call('pub_points_tiers', {})
    assert.notEqual(result.isError, true)
    assert.ok(!textOf(result).includes('(your tier)'), textOf(result))
    assert.equal(textOf(result).match(/^## /gm)?.length, 3)
  })

  test('a failed tier list is an error', async (t) => {
    const h = await connect(t)
    const result = await h.call('pub_points_tiers', {})
    assert.equal(result.isError, true)
    assert.match(textOf(result), /getTiers/)
  })
})

// ---- pub_points_referral ----

describe('pub_points_referral', () => {
  const SETTINGS: PublicSettings = {
    signUpBonusAmount: 1000,
    externalPurchasesPointsEarnRate: 0.05,
    refereeRewardPointsAmount: 500,
    referrerRewardPointsAmount: 1000,
    referralCodeRedemptionLimit: 10,
    pointsCreditExpiryPeriod: 'P6M',
    giftVoucherCreditExpiryPeriod: 'P3Y',
    refundCreditExpiryPeriod: 'P1Y2M',
  }

  test('the code, what it earns each side, and the program rules', async (t) => {
    const h = await connect(t)
    h.fake.getReferralCode = () => Promise.resolve({ code: 'MATE42', limitReached: false })
    h.fake.getPublicSettings = () => Promise.resolve({ ...SETTINGS })
    assert.equal(
      textOf(await h.call('pub_points_referral', {})),
      [
        '## Your referral code',
        'Code: MATE42',
        'You get 1,000 points and your friend gets 500 points when they join with it, up to 10 friends.',
        '',
        '## Program rules',
        'Sign-up bonus: $10.00 credit',
        'Points on external purchases: 5 points per $1',
        'Credit from points expires after 6 months',
        'Gift voucher credit expires after 3 years',
        'Refund credit expires after 1 year 2 months',
        '',
      ].join('\n')
    )
  })

  test('a code at its limit says it no longer earns points', async (t) => {
    const h = await connect(t)
    h.fake.getReferralCode = () => Promise.resolve({ code: 'MATE42', limitReached: true })
    h.fake.getPublicSettings = () => Promise.resolve({ ...SETTINGS })
    const text = textOf(await h.call('pub_points_referral', {}))
    assert.ok(text.includes('Code: MATE42 (limit reached; it no longer earns points)\n'), text)
  })

  test('no redemption limit in the settings leaves the limit out rather than guessing', async (t) => {
    const h = await connect(t)
    h.fake.getReferralCode = () => Promise.resolve({ code: 'MATE42' })
    h.fake.getPublicSettings = () => Promise.resolve({ ...SETTINGS, referralCodeRedemptionLimit: null })
    const text = textOf(await h.call('pub_points_referral', {}))
    assert.ok(!text.includes('up to'), text)
    assert.ok(!text.includes('?'), text)
    assert.ok(text.includes('when they join with it.'), text)
  })

  test('failed settings: the code alone, and the rules section marked unavailable', async (t) => {
    const h = await connect(t)
    h.fake.getReferralCode = () => Promise.resolve({ code: 'MATE42' })
    h.fake.getPublicSettings = () => Promise.reject(new Error('settings down'))
    assert.equal(
      textOf(await h.call('pub_points_referral', {})),
      ['## Your referral code', 'Code: MATE42', '', '## Program rules', '(unavailable: settings down)', ''].join('\n')
    )
  })

  test('a failed code read marks the code unavailable and still shows the rules', async (t) => {
    const h = await connect(t)
    h.fake.getReferralCode = () => Promise.reject(new Error('code down'))
    h.fake.getPublicSettings = () => Promise.resolve({ ...SETTINGS })
    const text = textOf(await h.call('pub_points_referral', {}))
    assert.ok(text.startsWith('## Your referral code\n(unavailable: code down)\n\n## Program rules\nSign-up bonus: $10.00 credit'), text)
  })
})

// ---- pub_points_promotions ----

describe('pub_points_promotions', () => {
  test('each tile with HTML stripped, its subtitle and link; an untitled tile says so', async (t) => {
    const h = await connect(t)
    h.fake.getPromoTiles = () =>
      Promise.resolve({
        items: [
          { id: 'p1', title: '<b>Happy</b> hour', subtitle: 'Half&amp;half', link: 'https://promo.example/happy' },
          { id: 'p2', title: null },
        ],
      })
    assert.equal(textOf(await h.call('pub_points_promotions', {})), '- Happy hour: Half&half (https://promo.example/happy)\n- (untitled)')
  })

  test('no tiles says so', async (t) => {
    const h = await connect(t)
    h.fake.getPromoTiles = () => Promise.resolve({ items: [] })
    assert.equal(textOf(await h.call('pub_points_promotions', {})), 'No promotions right now.')
  })
})

// ---- pub_points_offer_details ----

describe('pub_points_offer_details', () => {
  async function withVenueIds(t: TestContext, ids: string[], state = defaultState()) {
    const h = await connect(t, { state })
    h.fake.getOfferVenueIds = () => Promise.resolve([...ids])
    return h
  }

  test('an in-app offer: title, value, dates, status, how to activate and its venues', async (t) => {
    const h = await withVenueIds(t, ['venue-1', 'venue-9'])
    assert.equal(
      textOf(await h.call('pub_points_offer_details', { offerId: 'offer-inapp' })),
      [
        '# Free Chips',
        'Value: $5.00 credit',
        'Valid: 1 Jan 2026 to 1 Jan 2099',
        'Status: not activated',
        'How it works: Activate it in the app (or with pub_points_activate_offer) before ordering.',
        '',
        '## Venues (2)',
        '- The Local (venue id venue-1)',
        '- venue id venue-9',
      ].join('\n')
    )
  })

  test('an instant reward with a code, reward expiry, description and terms shows each', async (t) => {
    const state = defaultState()
    state.offers['offer-ir'] = {
      ...state.offers['offer-inapp'],
      id: 'offer-ir',
      type: 'instant_reward',
      activated: true,
      limitPerCustomerReached: true,
      endAt: null,
      activationCode: 'CHIPS5',
      rewardExpiresAt: '2026-12-24T01:00:00Z',
      displaySettings: { title: 'Chips Now', description: '<p>Free&nbsp;chips</p>', termsAndConditions: 'One per <b>visit</b>' },
    }
    const h = await withVenueIds(t, [], state)
    assert.equal(
      textOf(await h.call('pub_points_offer_details', { offerId: 'offer-ir' })),
      [
        '# Chips Now',
        'Value: $5.00 credit',
        'Valid: 1 Jan 2026 to no end date',
        'Status: activated, limit reached',
        'How it works: Instant reward: redeem it to receive the reward now.',
        'Activation code: CHIPS5',
        'Reward expires: 24 Dec 2026',
        '',
        'Free chips',
        '',
        'Terms: One per visit',
        '',
        '## Venues (0)',
      ].join('\n')
    )
  })

  test('how it works follows the activation strategy: code, automatic', async (t) => {
    const cases: [string | null, string][] = [
      ['code', 'How it works: Activates with a code (use pub_points_redeem_code).'],
      ['auto', 'How it works: Applies automatically to eligible orders.'],
      [null, 'How it works: Applies automatically to eligible orders.'],
    ]
    for (const [activationStrategy, line] of cases) {
      const state = defaultState()
      state.offers['offer-x'] = { ...state.offers['offer-inapp'], id: 'offer-x', activationStrategy }
      const h = await withVenueIds(t, [], state)
      const text = textOf(await h.call('pub_points_offer_details', { offerId: 'offer-x' }))
      assert.ok(text.includes(`\n${line}\n`), `${String(activationStrategy)}: ${text}`)
    }
  })

  test('the heading falls back to the offer name, then the id', async (t) => {
    const state = defaultState()
    state.offers['offer-named'] = { ...state.offers['offer-inapp'], id: 'offer-named', name: 'Named Offer', displaySettings: null }
    state.offers['offer-bare'] = { ...state.offers['offer-inapp'], id: 'offer-bare', displaySettings: {} }
    const h = await withVenueIds(t, [], state)
    assert.match(textOf(await h.call('pub_points_offer_details', { offerId: 'offer-named' })), /^# Named Offer\n/)
    assert.match(textOf(await h.call('pub_points_offer_details', { offerId: 'offer-bare' })), /^# offer-bare\n/)
  })

  test('maxVenues caps the venue list, looks up only those, and counts the rest', async (t) => {
    const h = await withVenueIds(t, ['venue-1', 'venue-2', 'venue-3'])
    const text = textOf(await h.call('pub_points_offer_details', { offerId: 'offer-inapp', maxVenues: 1 }))
    assert.ok(text.endsWith('## Venues (3)\n- The Local (venue id venue-1)\n(2 more)'), text)
    const lookups = h.fake.reads.filter((r) => r.method === 'getVenuesByIds')
    assert.deepEqual(
      lookups.map((r) => r.args[0]),
      [['venue-1']]
    )
  })

  test('a failed venue lookup adds the note and still lists the venue ids', async (t) => {
    const state = defaultState()
    state.venueLookupError = new Error('algolia down')
    const h = await withVenueIds(t, ['venue-1'], state)
    const text = textOf(await h.call('pub_points_offer_details', { offerId: 'offer-inapp' }))
    assert.ok(text.endsWith('## Venues (1)\n(venue names unavailable: algolia down)\n- venue id venue-1'), text)
  })

  test('an unknown offer is an error carrying the API 404', async (t) => {
    const h = await withVenueIds(t, [])
    const result = await h.call('pub_points_offer_details', { offerId: 'offer-gone' })
    assert.equal(result.isError, true)
    assert.equal(textOf(result), 'Offer not found (HTTP 404 on GET /available-offers/offer-gone)')
  })
})

// ---- pub_points_offers ----

describe('pub_points_offers', () => {
  const OFFERS: Offer[] = [
    offer('o-inapp', { activationStrategy: 'in_app', displaySettings: { title: 'Free Chips' } }),
    offer('o-auto', { displaySettings: { title: 'Auto Wings' } }),
    offer('o-on', {
      activated: true,
      strategy: 'discount',
      value: 10,
      limitPerCustomerReached: true,
      endAt: '2026-12-31T01:00:00Z',
      displaySettings: { title: 'Pint Deal' },
    }),
    offer('o-tile', { startAt: null, displaySettings: { title: '', tileTitle: 'Tile Only' } }),
  ]

  async function withOffers(t: TestContext) {
    const h = await connect(t)
    h.fake.searchOffers = () => Promise.resolve(structuredClone(OFFERS))
    return h
  }

  test('all: a header with counts and one line per offer', async (t) => {
    const h = await withOffers(t)
    const result = await h.call('pub_points_offers', {})
    const lines = textOf(result).split('\n')
    assert.equal(lines[0], '4 offers shown (1 activated, 3 not activated)')
    assert.equal(lines.length, 5)
    assert.equal(lines[3], '- Pint Deal: 10% off; 1 Jan 2026 to 31 Dec 2026 [activated, limit reached] (id o-on)')
    assert.deepEqual(structuredOf(result).shown, 4)
    assert.deepEqual(structuredOf(result).activated, 1)
    assert.deepEqual(structuredOf(result).notActivated, 3)
  })

  test('activated and not_activated each keep only their offers, and the counts still cover all', async (t) => {
    const cases: [string, string, string[]][] = [
      ['activated', '1 offer shown (1 activated, 3 not activated)', ['o-on']],
      ['not_activated', '3 offers shown (1 activated, 3 not activated)', ['o-inapp', 'o-auto', 'o-tile']],
    ]
    for (const [status, header, ids] of cases) {
      const h = await withOffers(t)
      const result = await h.call('pub_points_offers', { status })
      assert.equal(textOf(result).split('\n')[0], header)
      assert.deepEqual(
        records(structuredOf(result).offers).map((o) => o.id),
        ids
      )
    }
  })

  test('search matches the title ignoring case, and the header names the search', async (t) => {
    const h = await withOffers(t)
    const result = await h.call('pub_points_offers', { search: 'PINT' })
    assert.equal(textOf(result).split('\n')[0], '1 offer shown (1 activated, 0 not activated matching "PINT")')
    assert.deepEqual(
      records(structuredOf(result).offers).map((o) => o.id),
      ['o-on']
    )
  })

  test('search also matches the tile title, which is what is shown when the title is empty', async (t) => {
    const h = await withOffers(t)
    const result = await h.call('pub_points_offers', { search: 'tile only' })
    assert.deepEqual(
      records(structuredOf(result).offers).map((o) => o.id),
      ['o-tile']
    )
  })

  test('nothing matching says so, with the header', async (t) => {
    const h = await withOffers(t)
    const result = await h.call('pub_points_offers', { search: 'zzz' })
    assert.equal(textOf(result), 'No matching offers. 0 offers shown (0 activated, 0 not activated matching "zzz")')
    assert.deepEqual(structuredOf(result).offers, [])
  })

  test('structuredContent rows: value in words, activation need, limit, dates, and the tile title when the title is empty', async (t) => {
    const h = await withOffers(t)
    const rows = records(structuredOf(await h.call('pub_points_offers', {})).offers)
    assert.deepEqual(nth(rows, 0), {
      id: 'o-inapp',
      title: 'Free Chips',
      value: '$5.00 credit',
      strategy: 'credit',
      activated: false,
      needsActivation: true,
      limitReached: false,
      startAt: '2026-01-01T00:00:00Z',
      endAt: null,
    })
    assert.equal(nth(rows, 1).needsActivation, false, 'an automatic offer needs no activation')
    assert.equal(nth(rows, 2).limitReached, true)
    assert.equal(nth(rows, 2).value, '10% off')
    assert.equal(nth(rows, 3).title, 'Tile Only')
    assert.equal(nth(rows, 3).startAt, null)
  })
})

// ---- pub_points_orders ----

describe('pub_points_orders', () => {
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
      status: 'reversed',
      chargeAmount: 500,
      earnedPointsAmount: null,
      venue: { id: 'venue-9' },
      createdAt: '2026-10-14T02:00:00Z',
    },
    { id: 'o3', status: 'completed', chargeAmount: 250, createdAt: '2026-10-13T02:00:00Z' },
  ]

  async function withOrders(t: TestContext, state = defaultState()) {
    const h = await connect(t, { state })
    const filters: OrderFilter[] = []
    h.fake.getOrders = (filter) => {
      filters.push(filter)
      return Promise.resolve({ orders: structuredClone(ORDERS), complete: true })
    }
    return Object.assign(h, { filters })
  }

  test('one line per order with venue name or id, amount, points and a status other than completed', async (t) => {
    const h = await withOrders(t)
    assert.equal(
      textOf(await h.call('pub_points_orders', { status: 'all' })),
      [
        '- 15 Oct 2026 The Local, $10.00, +100 points (order id o1)',
        '- 14 Oct 2026 venue id venue-9, $5.00, reversed (order id o2)',
        '- 13 Oct 2026 unknown venue, $2.50 (order id o3)',
      ].join('\n')
    )
  })

  test('structuredContent rows carry the venue name only when the lookup found it', async (t) => {
    const h = await withOrders(t)
    const sc = structuredOf(await h.call('pub_points_orders', { status: 'all' }))
    assert.deepEqual(sc.orders, [
      {
        id: 'o1',
        createdAt: '2026-10-15T02:00:00Z',
        status: 'completed',
        venueId: 'venue-1',
        venueName: 'The Local',
        chargeCents: 1000,
        pointsEarned: 100,
      },
      {
        id: 'o2',
        createdAt: '2026-10-14T02:00:00Z',
        status: 'reversed',
        venueId: 'venue-9',
        venueName: null,
        chargeCents: 500,
        pointsEarned: 0,
      },
      {
        id: 'o3',
        createdAt: '2026-10-13T02:00:00Z',
        status: 'completed',
        venueId: null,
        venueName: null,
        chargeCents: 250,
        pointsEarned: 0,
      },
    ])
    assert.equal(sc.venueNamesUnavailable, null)
    assert.equal(sc.venueSearchCapped, false)
  })

  test('the filter sent: completed by default, no status for "all", the limit as the maximum, Sydney day bounds', async (t) => {
    const h = await withOrders(t)
    await h.call('pub_points_orders', {})
    await h.call('pub_points_orders', { status: 'all', limit: 7 })
    await h.call('pub_points_orders', { status: 'reversed', from: '2026-10-01', to: '2026-10-31' })
    assert.deepEqual(nth(h.filters, 0), { after: undefined, before: undefined, status: 'completed', max: 20 })
    assert.deepEqual(nth(h.filters, 1), { after: undefined, before: undefined, status: undefined, max: 7 })
    const dated = nth(h.filters, 2)
    assert.equal(dated.status, 'reversed')
    // 1 Oct 2026 00:00 in Sydney is AEST (+10): 30 Sep 14:00Z; 31 Oct 23:59:59 is AEDT (+11): 12:59:59Z
    assert.equal(Date.parse(present(dated.after, 'after')), Date.UTC(2026, 8, 30, 14, 0, 0))
    assert.equal(Date.parse(present(dated.before, 'before')), Date.UTC(2026, 9, 31, 12, 59, 59))
  })

  test('a venue filter scans up to 500 orders, ignores case, and keeps limit rows', async (t) => {
    const h = await withOrders(t)
    const result = await h.call('pub_points_orders', { status: 'all', venue: 'LOCAL', limit: 1 })
    assert.equal(nth(h.filters, 0).max, 500)
    assert.deepEqual(
      records(structuredOf(result).orders).map((o) => o.id),
      ['o1']
    )
  })

  test('a failed venue lookup: the note first, ids in the lines, and the reason in structuredContent', async (t) => {
    const state = defaultState()
    state.venueLookupError = new Error('algolia down')
    const h = await withOrders(t, state)
    const result = await h.call('pub_points_orders', { status: 'all' })
    const lines = textOf(result).split('\n')
    assert.equal(lines[0], '(venue names unavailable: algolia down)')
    assert.equal(lines[1], '- 15 Oct 2026 venue id venue-1, $10.00, +100 points (order id o1)')
    assert.equal(structuredOf(result).venueNamesUnavailable, '(venue names unavailable: algolia down)')
  })

  test('no orders says so', async (t) => {
    const h = await connect(t)
    h.fake.getOrders = () => Promise.resolve({ orders: [], complete: true })
    const result = await h.call('pub_points_orders', {})
    assert.equal(textOf(result), 'No matching orders.')
    assert.deepEqual(structuredOf(result).orders, [])
  })
})

// ---- pub_points_order_details ----

describe('pub_points_order_details', () => {
  test('a receipt with an unreadable time looks the order up without a time window', async (t) => {
    const h = await connect(t)
    const filters: OrderFilter[] = []
    h.fake.getOrder = () => Promise.resolve({ id: 'o-1', createdAt: 'not a date', items: [], chargeAmount: 100 })
    h.fake.getOrders = (filter) => {
      filters.push(filter)
      return Promise.resolve({
        orders: [{ id: 'o-1', status: 'completed', chargeAmount: 100, venue: { id: 'venue-2' }, createdAt: 'not a date' }],
        complete: true,
      })
    }
    const text = textOf(await h.call('pub_points_order_details', { orderId: 'o-1' }))
    assert.deepEqual(filters, [{ max: 500 }])
    assert.ok(text.startsWith('Order at The Royal, not a date (order id o-1)'), text)
  })

  test('an order not in an incomplete list says how many orders were searched', async (t) => {
    const h = await connect(t)
    h.fake.getOrder = () => Promise.resolve({ id: 'o-1', createdAt: '2026-10-15T02:00:00Z', chargeAmount: 100 })
    h.fake.getOrders = () => Promise.resolve({ orders: [], complete: false })
    const text = textOf(await h.call('pub_points_order_details', { orderId: 'o-1' }))
    assert.ok(text.endsWith('\n\n(venue name unavailable: the order is not in the order list among the 500 orders searched)'), text)
  })

  test('the full receipt: items, discounts, surcharges, totals, payment and offers applied', async (t) => {
    const receipt: OrderDetails = {
      id: 'o-1',
      createdAt: '2026-10-15T02:00:00Z',
      items: [
        { name: 'Pint', amountWithTax: 1200, quantity: 2 },
        { name: 'Chips', amountWithTax: 900 },
      ],
      discounts: [{ name: 'Happy hour', amountWithTax: 300, sku: 'LOYALTYDISCOUNT' }],
      surcharges: [{ name: 'Sunday', amountWithTax: 150 }],
      discountsAmountWithTax: 300,
      surchargesAmount: 150,
      chargeAmount: 1950,
      payments: [{ amount: 1950, method: 'Visa' }],
      offerRedemptions: [{ reward: { strategy: 'discount', value: 20 } }, { reward: null }],
    }
    const h = await connect(t)
    h.fake.getOrder = () => Promise.resolve(structuredClone(receipt))
    h.fake.getOrders = () =>
      Promise.resolve({
        orders: [{ id: 'o-1', status: 'completed', chargeAmount: 1950, venue: { id: 'venue-1' }, createdAt: receipt.createdAt }],
        complete: true,
      })
    // Items have no itemsAmountWithTax, so the total is summed: 1200 + 900 = 2100.
    assert.equal(
      textOf(await h.call('pub_points_order_details', { orderId: 'o-1' })),
      [
        'Order at The Local, 15 Oct 2026 (order id o-1)',
        '',
        '## Items',
        '- 2 x Pint: $12.00',
        '- Chips: $9.00',
        '',
        '## Discounts',
        '- Happy hour (offer): -$3.00',
        '',
        '## Surcharges',
        '- Sunday: $1.50',
        '',
        'Items: $21.00',
        'Discounts: -$3.00',
        'Surcharges: $1.50',
        'Total: $19.50',
        'Paid: $19.50 by Visa',
        'Offers applied: 20% off, offer',
      ].join('\n')
    )
  })

  test('an unknown order is an error carrying the API message', async (t) => {
    const h = await connect(t)
    h.fake.getOrder = () => Promise.reject(new ApiError('Not Found (HTTP 404 on GET /orders/o-gone)', 404))
    const result = await h.call('pub_points_order_details', { orderId: 'o-gone' })
    assert.equal(result.isError, true)
    assert.equal(textOf(result), 'Not Found (HTTP 404 on GET /orders/o-gone)')
  })
})

// ---- pub_points_group_discounts ----

describe('pub_points_group_discounts', () => {
  const MEMBERSHIPS: CustomerOrganisation[] = [
    { id: 'cm-1', organisation: { id: 'org-1', name: 'Acme Club', discount: 10 } },
    { id: 'cm-2', organisation: { id: 'org-2', name: 'Uni Staff', discount: 0 } },
    { id: 'cm-3', organisation: { id: 'org-3', name: 'Footy Club', discount: 15 } },
  ]
  const DETAILS: Record<string, CustomerOrganisationDetails> = {
    'cm-1': {
      id: 'cm-1',
      organisation: {
        id: 'org-1',
        name: 'Acme Club',
        discount: 10,
        discountVenuesCount: 2,
        discountVenues: [{ id: 'venue-1' }, { id: 'venue-9' }],
      },
    },
    'cm-2': { id: 'cm-2', organisation: { id: 'org-2', name: 'Uni Staff', discount: 0, discountVenuesCount: 0 } },
  }

  async function withGroups(t: TestContext, state = defaultState()) {
    const h = await connect(t, { state })
    h.fake.getCustomerOrganisations = () => Promise.resolve(structuredClone(MEMBERSHIPS))
    h.fake.getCustomerOrganisation = (id) => {
      const d = DETAILS[id]
      return d ? Promise.resolve(structuredClone(d)) : Promise.reject(new Error('group down'))
    }
    return h
  }

  test('each group with its discount and venues; all venues; a failed group shows why', async (t) => {
    const h = await withGroups(t)
    assert.equal(
      textOf(await h.call('pub_points_group_discounts', {})),
      [
        '## Acme Club: 10% off',
        '- The Local (venue id venue-1)',
        '- venue id venue-9',
        '',
        '## Uni Staff: no percentage discount',
        'Applies at all The Pass venues.',
        '',
        '## Footy Club: 15% off',
        '(venue list unavailable: group down)',
        '',
      ].join('\n')
    )
  })

  test('search keeps groups whose name contains the text, ignoring case', async (t) => {
    const h = await withGroups(t)
    const text = textOf(await h.call('pub_points_group_discounts', { search: 'ACME' }))
    assert.ok(text.startsWith('## Acme Club: 10% off\n'), text)
    assert.ok(!text.includes('Uni Staff'), text)
  })

  test('a search with no match names the search', async (t) => {
    const h = await withGroups(t)
    assert.equal(textOf(await h.call('pub_points_group_discounts', { search: 'zzz' })), 'No group matching "zzz".')
  })

  test('no groups points to pub_points_join_organisation', async (t) => {
    const h = await connect(t)
    h.fake.getCustomerOrganisations = () => Promise.resolve([])
    assert.equal(
      textOf(await h.call('pub_points_group_discounts', {})),
      'Not a member of any group. Join one with pub_points_join_organisation.'
    )
  })

  test('a failed venue lookup adds the note and still lists venue ids', async (t) => {
    const state = defaultState()
    state.venueLookupError = new Error('algolia down')
    const h = await withGroups(t, state)
    const text = textOf(await h.call('pub_points_group_discounts', { search: 'acme' }))
    assert.equal(
      text,
      ['(venue names unavailable: algolia down)', '## Acme Club: 10% off', '- venue id venue-1', '- venue id venue-9', ''].join('\n')
    )
  })
})

// ---- pub_points_favourite_venues ----

describe('pub_points_favourite_venues', () => {
  test('each favourite as a venue line; an unknown venue by id', async (t) => {
    const state = defaultState()
    state.favourites.push({ id: 'fav-10', venue: { id: 'venue-9' } })
    const h = await connect(t, { state })
    assert.equal(textOf(await h.call('pub_points_favourite_venues', {})), '- The Royal (venue id venue-2)\n- venue id venue-9')
  })

  test('no favourites says so and looks nothing up', async (t) => {
    const state = defaultState()
    state.favourites = []
    const h = await connect(t, { state })
    assert.equal(textOf(await h.call('pub_points_favourite_venues', {})), 'No favourite venues yet.')
    assert.ok(!h.fake.reads.some((r) => r.method === 'getVenuesByIds'))
  })
})

// ---- pub_points_profile ----

describe('pub_points_profile', () => {
  const PROFILE: Profile = {
    firstName: 'Sam',
    lastName: 'Lee',
    email: 'sam@example.com',
    phoneNumber: '+61400000000',
    dateOfBirth: '1990-05-17',
    createdAt: '2024-02-03T01:00:00Z',
    preferredPaymentMethod: { cardType: 'Visa', pan: '411111******1234', expiryMonth: 3, expiryYear: 2028 },
  }

  test('name, email, mobile, birthday, member since, and the card by its last four digits only', async (t) => {
    const h = await connect(t)
    h.fake.getProfile = () => Promise.resolve(structuredClone(PROFILE))
    const text = textOf(await h.call('pub_points_profile', {}))
    assert.equal(
      text,
      [
        'Name: Sam Lee',
        'Email: sam@example.com',
        'Mobile: +61400000000',
        'Date of birth: 17 May 1990',
        'Member since: 3 Feb 2024',
        'Preferred card: Visa ending 1234, expires 03/2028',
      ].join('\n')
    )
    assert.ok(!text.includes('411111'), text)
  })

  test('an empty profile says "(not set)" for each field and shows no card', async (t) => {
    const h = await connect(t)
    h.fake.getProfile = () => Promise.resolve({})
    assert.equal(
      textOf(await h.call('pub_points_profile', {})),
      ['Name: (not set)', 'Email: (not set)', 'Mobile: (not set)', 'Date of birth: (not set)', 'Member since: unknown'].join('\n')
    )
  })

  test('a card with no type, number or expiry is "card on file"; a first name alone is the name', async (t) => {
    const h = await connect(t)
    h.fake.getProfile = () => Promise.resolve({ firstName: 'Sam', preferredPaymentMethod: { pan: '12' } })
    const text = textOf(await h.call('pub_points_profile', {}))
    assert.ok(text.startsWith('Name: Sam\n'), text)
    assert.ok(text.endsWith('\nPreferred card: card on file'), text)
  })
})

// ---- pub_points_communication_preferences ----

describe('pub_points_communication_preferences', () => {
  test('every preference type in order, on or off', async (t) => {
    const state = defaultState()
    state.preferences = [
      { id: 'pref-1', type: 'email_news' },
      { id: 'pref-2', type: 'push_offers' },
    ]
    const h = await connect(t, { state })
    assert.equal(
      textOf(await h.call('pub_points_communication_preferences', {})),
      [
        '- Push: account essentials: off (push_account_essentials)',
        '- Push: offers: on (push_offers)',
        '- Push: news: off (push_news)',
        '- Email: account essentials: off (email_account_essentials)',
        '- Email: offers: off (email_offers)',
        '- Email: news: on (email_news)',
        '- SMS: offers: off (sms_offers)',
      ].join('\n')
    )
  })

  test('a failed read is an error, not "all off"', async (t) => {
    const state = defaultState()
    state.readErrors.getCommunicationPreferences = new Error('prefs down')
    const h = await connect(t, { state })
    const result = await h.call('pub_points_communication_preferences', {})
    assert.equal(result.isError, true)
    assert.equal(textOf(result), 'prefs down')
  })
})
