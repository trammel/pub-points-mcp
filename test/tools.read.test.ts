// SPDX-License-Identifier: GPL-3.0-or-later
// The read tools registered in tools.ts, through a real MCP client against the fake client:
// doctor, summary, rewards, credits, discounts, find_venues and venue_offers. Each test sets
// the account state, calls the tool, and checks what a member would read in the text or the
// structuredContent. Every expected line is written out from the fixture, never rebuilt with
// the formatters the tools use.

import './backstop.ts'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Credit, CustomerOrganisation, CustomerTier, Location, Offer, Venue } from '../dist/api.js'
import { connect, defaultState, nth, records, structuredOf, textOf } from './harness.ts'

const TIER: CustomerTier = {
  spendAmount: 45000,
  anniversaryAt: '2027-03-01T00:00:00Z',
  tier: { name: 'Silver', spendAmountTo: 100000, benefits: [{ title: 'Birthday drink', description: '<b>Free</b> pint' }] },
  nextTier: { name: 'Gold' },
}

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

// ---- pub_points_doctor ----

describe('pub_points_doctor', () => {
  test('a current client version with the API reachable and no session: all checks passed, sign-in skipped', async (t) => {
    const h = await connect(t)
    h.fake.checkAppVersion = () => Promise.resolve({ updateType: 'none' })
    h.fake.getPublicSettings = () => Promise.resolve({})
    const lines = textOf(await h.call('pub_points_doctor', {})).split('\n')
    assert.equal(lines[0], 'All checks passed.')
    assert.equal(lines.length, 5, lines.join('\n'))
    assert.match(nth(lines, 2), /^OK {4}Client version/)
    assert.match(nth(lines, 3), /^OK {4}API reachable/)
    assert.match(nth(lines, 4), /^SKIP {2}Signed in/)
  })

  test('a client version the update check refuses is one failed check', async (t) => {
    const h = await connect(t)
    h.fake.checkAppVersion = () => Promise.resolve({ updateType: 'hard' })
    h.fake.getPublicSettings = () => Promise.resolve({})
    const lines = textOf(await h.call('pub_points_doctor', {})).split('\n')
    assert.equal(lines[0], '1 check failed.')
    assert.match(nth(lines, 2), /^FAIL {2}Client version .*no longer accepted/)
  })

  test('an unreachable API is two failed checks and stops before the account checks', async (t) => {
    const h = await connect(t)
    h.fake.checkAppVersion = () => Promise.reject(new Error('connect ECONNREFUSED'))
    h.fake.getPublicSettings = () => Promise.reject(new Error('connect ECONNREFUSED'))
    const lines = textOf(await h.call('pub_points_doctor', {})).split('\n')
    assert.equal(lines[0], '2 checks failed.')
    assert.equal(lines.length, 4, lines.join('\n'))
    assert.ok(!lines.some((l) => l.includes('Signed in')), lines.join('\n'))
  })
})

// ---- pub_points_summary ----

describe('pub_points_summary', () => {
  test('balances, tier, best reward now and the next reward, from the account state', async (t) => {
    const h = await connect(t)
    h.fake.getCustomerTier = () => Promise.resolve(structuredClone(TIER))
    const result = await h.call('pub_points_summary', {})
    assert.notEqual(result.isError, true, textOf(result))
    // 1,500 points: reward-b (1,200) is the best covered, reward-c (5,000) is next, 3,500 to go.
    assert.equal(
      textOf(result),
      [
        'Points balance: 1,500 points',
        'Credit balance: $25.00',
        'Tier: Silver',
        'Spend this tier year: $450.00',
        'Next tier: Gold (spend $550.00 more)',
        'Tier anniversary: 1 Mar 2027',
        'Best reward redeemable now: $15.00 credit for 1,200 points',
        'Next reward: $75.00 credit at 5,000 points (3,500 points to go)',
      ].join('\n')
    )
  })

  test('a balance below every reward shows only the next one', async (t) => {
    const state = defaultState()
    state.balances.pointsBalance = 400
    const h = await connect(t, { state })
    const text = textOf(await h.call('pub_points_summary', {}))
    assert.ok(text.includes('Next reward: $10.00 credit at 1,000 points (600 points to go)'), text)
    assert.ok(!text.includes('Best reward'), text)
  })

  test('a balance above every reward shows the best one and no next reward', async (t) => {
    const state = defaultState()
    state.balances.pointsBalance = 6000
    const h = await connect(t, { state })
    const text = textOf(await h.call('pub_points_summary', {}))
    assert.ok(text.includes('Best reward redeemable now: $75.00 credit for 5,000 points'), text)
    assert.ok(!text.includes('Next reward'), text)
  })

  test('the reward lines do not depend on the order the API lists rewards in', async (t) => {
    const state = defaultState()
    state.rates.reverse()
    const h = await connect(t, { state })
    const text = textOf(await h.call('pub_points_summary', {}))
    assert.ok(text.includes('Best reward redeemable now: $15.00 credit for 1,200 points'), text)
    assert.ok(text.includes('Next reward: $75.00 credit at 5,000 points (3,500 points to go)'), text)
  })

  test('a failed tier and rewards read still shows the balances, and only the balances', async (t) => {
    const state = defaultState()
    state.readErrors.getPointsExchangeRates = new Error('rates down')
    const h = await connect(t, { state })
    // getCustomerTier is not served by the fake, so it rejects too.
    const result = await h.call('pub_points_summary', {})
    assert.notEqual(result.isError, true)
    assert.equal(textOf(result), 'Points balance: 1,500 points\nCredit balance: $25.00')
  })

  test('a failed balance read is an error with the reason', async (t) => {
    const state = defaultState()
    state.readErrors.getBalances = new Error('Service Unavailable (HTTP 503 on GET /customer-balances)')
    const h = await connect(t, { state })
    const result = await h.call('pub_points_summary', {})
    assert.equal(result.isError, true)
    assert.equal(textOf(result), 'Service Unavailable (HTTP 503 on GET /customer-balances)')
  })
})

// ---- pub_points_rewards ----

describe('pub_points_rewards', () => {
  test('text lists every reward cheapest first with what the balance covers', async (t) => {
    const state = defaultState()
    state.rates.reverse()
    const h = await connect(t, { state })
    assert.equal(
      textOf(await h.call('pub_points_rewards', {})),
      [
        'Points balance: 1,500 points',
        '',
        '- $10.00 credit for 1,000 points [can redeem now] (id reward-a)',
        '- $15.00 credit for 1,200 points [can redeem now] (id reward-b)',
        '- $75.00 credit for 5,000 points [3,500 points short] (id reward-c)',
      ].join('\n')
    )
  })

  test('structuredContent rows are cheapest first, with credit in cents and the points still needed', async (t) => {
    const state = defaultState()
    state.rates.reverse()
    const h = await connect(t, { state })
    const rows = records(structuredOf(await h.call('pub_points_rewards', {})).rewards)
    assert.deepEqual(rows, [
      {
        id: 'reward-a',
        label: '$10.00 credit for 1,000 points',
        pointsAmount: 1000,
        creditCents: 1000,
        canRedeemNow: true,
        pointsShort: 0,
      },
      {
        id: 'reward-b',
        label: '$15.00 credit for 1,200 points',
        pointsAmount: 1200,
        creditCents: 1500,
        canRedeemNow: true,
        pointsShort: 0,
      },
      {
        id: 'reward-c',
        label: '$75.00 credit for 5,000 points',
        pointsAmount: 5000,
        creditCents: 7500,
        canRedeemNow: false,
        pointsShort: 3500,
      },
    ])
  })

  test('a reward the balance exactly covers can be redeemed now', async (t) => {
    const state = defaultState()
    state.balances.pointsBalance = 1200
    const h = await connect(t, { state })
    const row = nth(records(structuredOf(await h.call('pub_points_rewards', {})).rewards), 1)
    assert.equal(row.id, 'reward-b')
    assert.equal(row.canRedeemNow, true)
    assert.equal(row.pointsShort, 0)
  })

  test('a named reward is labelled by its name', async (t) => {
    const state = defaultState()
    state.rates = [{ id: 'reward-pint', pointsAmount: 800, creditAmount: 1000, name: 'Free pint' }]
    const h = await connect(t, { state })
    const result = await h.call('pub_points_rewards', {})
    assert.ok(textOf(result).includes('- Free pint for 800 points [can redeem now] (id reward-pint)'), textOf(result))
    assert.equal(nth(records(structuredOf(result).rewards), 0).label, 'Free pint for 800 points')
  })

  test('a failed rewards read is an error', async (t) => {
    const state = defaultState()
    state.readErrors.getPointsExchangeRates = new Error('rates down')
    const h = await connect(t, { state })
    const result = await h.call('pub_points_rewards', {})
    assert.equal(result.isError, true)
    assert.equal(textOf(result), 'rates down')
  })
})

// ---- pub_points_credits ----

describe('pub_points_credits', () => {
  const CREDITS: Credit[] = [
    { id: 'c1', type: 'birthday_gift', availableBalance: 1000, expiresAt: '2026-12-01T00:00:00Z' },
    { id: 'c2', type: 'refund', availableBalance: 1500, expiresAt: null },
  ]

  test('the credit balance, then each credit with its kind and expiry in the order the API gave', async (t) => {
    const h = await connect(t)
    h.fake.getAvailableCredits = () => Promise.resolve(structuredClone(CREDITS))
    const lines = textOf(await h.call('pub_points_credits', {})).split('\n')
    assert.equal(lines[0], 'Credit balance: $25.00')
    assert.equal(lines[1], '')
    assert.equal(lines[2], '- $10.00 Birthday gift, expires 1 Dec 2026')
    assert.equal(lines[3], '- $15.00 Refund, never expires')
    assert.equal(lines.length, 4)
  })

  test('no credit lists the balance and says there is no unspent credit', async (t) => {
    const h = await connect(t)
    h.fake.getAvailableCredits = () => Promise.resolve([])
    const text = textOf(await h.call('pub_points_credits', {}))
    assert.equal(text, 'Credit balance: $25.00\n\nNo unspent credit.')
  })

  test('a failed credit read is an error, not an empty list', async (t) => {
    const h = await connect(t)
    h.fake.getAvailableCredits = () => Promise.reject(new Error('credits down'))
    const result = await h.call('pub_points_credits', {})
    assert.equal(result.isError, true)
    assert.equal(textOf(result), 'credits down')
  })
})

// ---- pub_points_discounts ----

describe('pub_points_discounts', () => {
  const ORGS: CustomerOrganisation[] = [
    { id: 'cm-1', organisation: { id: 'org-1', name: 'Acme Club', discount: 10, discountVenuesCount: 3 } },
  ]
  const GENERAL_OFFERS: Offer[] = [
    offer('o-act-me', { strategy: 'discount', value: 10, activationStrategy: 'in_app', displaySettings: { title: 'Ten Off' } }),
    offer('o-auto', { displaySettings: { title: 'Auto Wings' } }),
    offer('o-on', { activated: true, displaySettings: { title: 'Fiver' } }),
  ]
  const ORG_OFFER = offer('o-org', { strategy: 'discount_fixed', value: 300, displaySettings: { title: 'Club Deal' } })

  interface OfferSearch {
    filter: { venues?: string[]; organisations?: string[]; limit?: number }
    location: Location | undefined
  }

  async function discounts(t: Parameters<typeof connect>[0], state = defaultState()) {
    const h = await connect(t, { state })
    const searches: OfferSearch[] = []
    h.fake.getCustomerTier = () => Promise.resolve(structuredClone(TIER))
    h.fake.getCustomerOrganisations = () => Promise.resolve(structuredClone(ORGS))
    h.fake.getAvailableCredits = () => Promise.resolve([{ id: 'c1', type: 'promo_code', availableBalance: 500, expiresAt: null }])
    h.fake.searchOffers = (filter, location) => {
      searches.push({ filter, location })
      return Promise.resolve(structuredClone(filter.organisations ? [ORG_OFFER] : GENERAL_OFFERS))
    }
    return Object.assign(h, { searches })
  }

  function birthdayState(patch: { cardTransactionRequirementMet?: boolean; value?: number } = {}) {
    const state = defaultState()
    state.birthday = { value: 1000, startAt: '2026-11-01T00:00:00Z', endAt: '2026-11-30T00:00:00Z', ...patch }
    return state
  }

  test('every section, from tier benefits to redeemable rewards, for a full account', async (t) => {
    const h = await discounts(t, birthdayState({ cardTransactionRequirementMet: true }))
    const result = await h.call('pub_points_discounts', {})
    assert.notEqual(result.isError, true, textOf(result))
    assert.equal(
      textOf(result),
      [
        '## Tier benefits',
        'Tier: Silver',
        '- Birthday drink: Free pint',
        '',
        '## Group discounts',
        '- Acme Club: 10% group discount (3 venues)',
        '  - Club Deal: $3.00 off; 1 Jan 2026 to no end date [not activated] (id o-org)',
        '',
        '## Offers to activate',
        '- Ten Off: 10% off; 1 Jan 2026 to no end date [not activated: activate with pub_points_activate_offer] (id o-act-me)',
        '',
        '## Activated offers',
        '- Fiver: $5.00 credit; 1 Jan 2026 to no end date [activated] (id o-on)',
        '',
        '## Birthday gift',
        '$10.00 birthday credit, 1 Nov 2026 to 30 Nov 2026',
        '',
        '## Available credit',
        '- $5.00 Promo code, never expires',
        '',
        '## Points rewards redeemable now',
        '- $10.00 credit for 1,000 points',
        '- $15.00 credit for 1,200 points',
        '',
      ].join('\n')
    )
  })

  test('searches all offers once and each group once, with no location when none is given', async (t) => {
    const h = await discounts(t)
    await h.call('pub_points_discounts', {})
    assert.deepEqual(
      h.searches.map((s) => s.filter).sort((a, b) => Object.keys(a).length - Object.keys(b).length),
      [{}, { organisations: ['org-1'] }]
    )
    assert.ok(
      h.searches.every((s) => s.location === undefined),
      JSON.stringify(h.searches)
    )
  })

  test('latitude and longitude reach every offer search', async (t) => {
    const h = await discounts(t)
    await h.call('pub_points_discounts', { latitude: -33.87, longitude: 151.21 })
    assert.equal(h.searches.length, 2)
    for (const s of h.searches) assert.deepEqual(s.location, { latitude: -33.87, longitude: 151.21 })
  })

  test('only latitude, without longitude, is no location', async (t) => {
    const h = await discounts(t)
    await h.call('pub_points_discounts', { latitude: -33.87 })
    assert.ok(
      h.searches.every((s) => s.location === undefined),
      JSON.stringify(h.searches)
    )
  })

  test('a birthday gift locked behind a card transaction says so', async (t) => {
    const h = await discounts(t, birthdayState({ cardTransactionRequirementMet: false }))
    const text = textOf(await h.call('pub_points_discounts', {}))
    assert.ok(
      text.includes('## Birthday gift\n$10.00 birthday credit, 1 Nov 2026 to 30 Nov 2026 (locked: needs a card transaction first)\n'),
      text
    )
  })

  test('no birthday gift, or one worth nothing, is "(none)"', async (t) => {
    for (const birthday of [null, { value: 0 }]) {
      const state = defaultState()
      state.birthday = birthday
      const h = await discounts(t, state)
      const text = textOf(await h.call('pub_points_discounts', {}))
      assert.ok(text.includes('## Birthday gift\n(none)\n'), text)
    }
  })

  test('a failed read shows "(unavailable: reason)" in its own section and leaves the others', async (t) => {
    const state = defaultState()
    state.readErrors.getBirthdayGift = new Error('birthday down')
    const h = await discounts(t, state)
    h.fake.getCustomerOrganisations = () => Promise.reject(new Error('groups down'))
    const text = textOf(await h.call('pub_points_discounts', {}))
    assert.ok(text.includes('## Group discounts\n(unavailable: groups down)\n'), text)
    assert.ok(text.includes('## Birthday gift\n(unavailable: birthday down)\n'), text)
    assert.ok(text.includes('## Tier benefits\nTier: Silver\n'), text)
    assert.deepEqual(
      h.searches.map((s) => s.filter),
      [{}],
      'no group offer search without the group list'
    )
  })

  test('a failed balance read claims no reward is redeemable', async (t) => {
    const state = defaultState()
    state.readErrors.getBalances = new Error('balances down')
    const h = await discounts(t, state)
    const text = textOf(await h.call('pub_points_discounts', {}))
    assert.ok(text.includes('## Points rewards redeemable now\n(none)\n'), text)
  })

  test('a failed offer search shows in both offer sections', async (t) => {
    const h = await discounts(t)
    h.fake.searchOffers = (filter) => (filter.organisations ? Promise.resolve([]) : Promise.reject(new Error('offers down')))
    const text = textOf(await h.call('pub_points_discounts', {}))
    assert.ok(text.includes('## Offers to activate\n(unavailable: offers down)\n'), text)
    assert.ok(text.includes('## Activated offers\n(unavailable: offers down)\n'), text)
  })

  test('a group whose offer search fails is listed with the reason, and the other group keeps its offers', async (t) => {
    const h = await discounts(t)
    h.fake.getCustomerOrganisations = () =>
      Promise.resolve([
        { id: 'cm-1', organisation: { id: 'org-1', name: 'Acme Club', discount: 10, discountVenuesCount: 3 } },
        { id: 'cm-2', organisation: { id: 'org-2', name: 'Uni Staff', discount: 0, discountVenuesCount: 0 } },
      ])
    h.fake.searchOffers = (filter) => {
      const orgs = filter.organisations ?? []
      if (orgs.includes('org-1')) return Promise.reject(new Error('org search down'))
      return Promise.resolve(orgs.includes('org-2') ? [structuredClone(ORG_OFFER)] : [])
    }
    const text = textOf(await h.call('pub_points_discounts', {}))
    assert.ok(
      text.includes(
        [
          '## Group discounts',
          '- Acme Club: 10% group discount (3 venues)',
          '  (offers unavailable: org search down)',
          '- Uni Staff: no group discount (all venues)',
          '  - Club Deal: $3.00 off; 1 Jan 2026 to no end date [not activated] (id o-org)',
          '',
        ].join('\n')
      ),
      text
    )
  })

  test('more than 50 activated offers shows 50 and points to pub_points_offers for the rest', async (t) => {
    const h = await discounts(t)
    const many = Array.from({ length: 53 }, (_, i) => offer(`on-${i}`, { activated: true }))
    h.fake.searchOffers = (filter) => Promise.resolve(filter.organisations ? [] : structuredClone(many))
    const text = textOf(await h.call('pub_points_discounts', {}))
    const lines = sectionLines(text, 'Activated offers')
    assert.equal(lines.length, 51, text)
    assert.ok(lines.slice(0, 50).every((l) => l.includes('[activated]')))
    assert.ok(lines[49]?.includes('(id on-49)'), lines[49])
    assert.equal(lines[50], '(3 more; see pub_points_offers)')
  })

  test('exactly 50 activated offers has no "more" line', async (t) => {
    const h = await discounts(t)
    const fifty = Array.from({ length: 50 }, (_, i) => offer(`on-${i}`, { activated: true }))
    h.fake.searchOffers = (filter) => Promise.resolve(filter.organisations ? [] : structuredClone(fifty))
    const text = textOf(await h.call('pub_points_discounts', {}))
    assert.ok(!text.includes('more; see pub_points_offers'), text)
  })
})

/** The lines under `## title`, up to the blank line that ends the section; throws when there is no such section. */
function sectionLines(text: string, title: string): string[] {
  const lines = text.split('\n')
  const start = lines.indexOf(`## ${title}`)
  if (start === -1) throw new TypeError(`no "## ${title}" section in:\n${text}`)
  const end = lines.indexOf('', start)
  return lines.slice(start + 1, end === -1 ? undefined : end)
}

// ---- pub_points_find_venues ----

/** Every UTC 15-minute slot start of a day, "0000" to "2345", as the venue schema documents them. */
const ALL_DAY: string[] = Array.from(
  { length: 96 },
  (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}${String((i % 4) * 15).padStart(2, '0')}`
)
const DAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa']

const OPEN_VENUE: Venue = {
  objectID: 'v-open',
  title: 'The Local',
  location: { address: '1 King St<br/>Newtown' },
  _rankingInfo: { geoDistance: 1234 },
  openingHours: { hours: Object.fromEntries(DAYS.map((d) => [d, ALL_DAY])), text: ['Monday: 11:00 AM – 10:00 PM'] },
  venueStyles: [{ label: 'Pub &amp; Dining' }],
  links: { avcSite: 'https://local.example', bookingSite: 'https://book.example' },
}
const CLOSED_VENUE: Venue = {
  objectID: 'v-closed',
  title: 'The Royal',
  _rankingInfo: { geoDistance: 0 },
  openingHours: { hours: Object.fromEntries(DAYS.map((d) => [d, []])) },
}
const UNKNOWN_HOURS_VENUE: Venue = { objectID: 'v-unknown' }

interface VenueSearch {
  query: string
  opts: { near?: Location; radiusMetres?: number; limit?: number }
}

async function withVenues(t: Parameters<typeof connect>[0], venues: Venue[] = [OPEN_VENUE, CLOSED_VENUE, UNKNOWN_HOURS_VENUE]) {
  const h = await connect(t)
  const venueSearches: VenueSearch[] = []
  h.fake.searchVenues = (query, opts) => {
    venueSearches.push({ query, opts })
    return Promise.resolve(structuredClone(venues))
  }
  return Object.assign(h, { venueSearches })
}

describe('pub_points_find_venues', () => {
  test('one line per venue with address, distance and open-now state', async (t) => {
    const h = await withVenues(t)
    const result = await h.call('pub_points_find_venues', { query: 'newtown' })
    assert.equal(
      textOf(result),
      [
        '- The Local, 1 King St, Newtown (1.2 km) (venue id v-open) [open now]',
        '- The Royal (venue id v-closed) [closed now]',
        '- v-unknown (venue id v-unknown)',
      ].join('\n')
    )
    assert.deepEqual(h.venueSearches, [{ query: 'newtown', opts: { near: undefined, radiusMetres: undefined, limit: undefined } }])
  })

  test('structuredContent gives id, title, raw address, distance in km and open-now (null when unknown)', async (t) => {
    const h = await withVenues(t)
    const result = await h.call('pub_points_find_venues', { query: 'newtown' })
    assert.deepEqual(structuredOf(result).venues, [
      { id: 'v-open', title: 'The Local', address: '1 King St<br/>Newtown', distanceKm: 1.2, openNow: true },
      { id: 'v-closed', title: 'The Royal', address: null, distanceKm: null, openNow: false },
      { id: 'v-unknown', title: null, address: null, distanceKm: null, openNow: null },
    ])
  })

  test('openNow keeps only venues known to be open, in text and structuredContent', async (t) => {
    const h = await withVenues(t)
    const result = await h.call('pub_points_find_venues', { query: '', openNow: true })
    assert.equal(textOf(result), '- The Local, 1 King St, Newtown (1.2 km) (venue id v-open) [open now]')
    assert.deepEqual(
      records(structuredOf(result).venues).map((v) => v.id),
      ['v-open']
    )
  })

  test('includeHours adds styles, opening hours and links under a heading per venue', async (t) => {
    const h = await withVenues(t, [OPEN_VENUE, CLOSED_VENUE])
    const text = textOf(await h.call('pub_points_find_venues', { query: 'newtown', includeHours: true }))
    assert.equal(
      text,
      [
        '## The Local, 1 King St, Newtown (1.2 km) (venue id v-open) [open now]',
        'Styles: Pub & Dining',
        'Monday: 11:00 AM – 10:00 PM',
        'Website: https://local.example',
        'Bookings: https://book.example',
        '',
        '## The Royal (venue id v-closed) [closed now]',
        '',
      ].join('\n')
    )
  })

  test('a coordinate, radius and limit reach the venue search, with the radius in metres', async (t) => {
    const h = await withVenues(t)
    await h.call('pub_points_find_venues', { latitude: -33.9, longitude: 151.18, radiusKm: 2.5, limit: 7 })
    assert.deepEqual(h.venueSearches, [{ query: '', opts: { near: { latitude: -33.9, longitude: 151.18 }, radiusMetres: 2500, limit: 7 } }])
  })

  test('no venues says so, with an empty venues list', async (t) => {
    const h = await withVenues(t, [])
    const result = await h.call('pub_points_find_venues', { query: 'nowhere' })
    assert.equal(textOf(result), 'No venues found.')
    assert.deepEqual(structuredOf(result), { venues: [] })
  })

  test('openNow with every venue closed or unknown is "No venues found."', async (t) => {
    const h = await withVenues(t, [CLOSED_VENUE, UNKNOWN_HOURS_VENUE])
    const result = await h.call('pub_points_find_venues', { query: '', openNow: true })
    assert.equal(textOf(result), 'No venues found.')
  })

  test('a radius over 100 km is refused before any search', async (t) => {
    const h = await withVenues(t)
    const result = await h.call('pub_points_find_venues', { query: '', radiusKm: 101 })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /Input validation error/)
    assert.deepEqual(h.venueSearches, [])
  })

  test('a failed venue search is an error', async (t) => {
    const h = await connect(t)
    h.fake.searchVenues = () => Promise.reject(new Error('Venue search failed (HTTP 500)'))
    const result = await h.call('pub_points_find_venues', { query: 'x' })
    assert.equal(result.isError, true)
    assert.equal(textOf(result), 'Venue search failed (HTTP 500)')
  })
})

// ---- pub_points_venue_offers ----

describe('pub_points_venue_offers', () => {
  const PINT = offer('o-pint', { activated: true, displaySettings: { title: 'Pint Deal' } })

  test('by id: a heading per venue, its offers, "(no offers)" when none, and the id when the venue is unknown', async (t) => {
    const h = await connect(t)
    h.fake.searchOffers = (filter) => Promise.resolve(filter.venues?.[0] === 'venue-1' ? [structuredClone(PINT)] : [])
    const text = textOf(await h.call('pub_points_venue_offers', { venueIds: ['venue-1', 'venue-9'] }))
    assert.equal(
      text,
      [
        '## The Local (venue id venue-1)',
        '- Pint Deal: $5.00 credit; 1 Jan 2026 to no end date [activated] (id o-pint)',
        '',
        '## venue id venue-9',
        '(no offers)',
        '',
      ].join('\n')
    )
  })

  test("one venue's failed offer search shows under that venue only", async (t) => {
    const h = await connect(t)
    h.fake.searchOffers = (filter) =>
      filter.venues?.[0] === 'venue-2' ? Promise.reject(new Error('offers down')) : Promise.resolve([structuredClone(PINT)])
    const text = textOf(await h.call('pub_points_venue_offers', { venueIds: ['venue-1', 'venue-2'] }))
    assert.ok(text.includes('## The Royal (venue id venue-2)\n(unavailable: offers down)\n'), text)
    assert.ok(text.includes('## The Local (venue id venue-1)\n- Pint Deal'), text)
  })

  test('by query: searches venues (5 by default) and lists offers at each hit', async (t) => {
    const h = await withVenues(t, [CLOSED_VENUE])
    h.fake.searchOffers = () => Promise.resolve([])
    const text = textOf(await h.call('pub_points_venue_offers', { query: 'royal' }))
    assert.deepEqual(h.venueSearches, [{ query: 'royal', opts: { near: undefined, limit: 5 } }])
    assert.equal(text, '## The Royal (venue id v-closed) [closed now]\n(no offers)\n')
  })

  test('by coordinate alone: searches nearby venues and passes the location to the offer search', async (t) => {
    const h = await withVenues(t, [CLOSED_VENUE])
    const locations: (Location | undefined)[] = []
    h.fake.searchOffers = (_filter, location) => {
      locations.push(location)
      return Promise.resolve([])
    }
    await h.call('pub_points_venue_offers', { latitude: -33.9, longitude: 151.18, limit: 3 })
    assert.deepEqual(h.venueSearches, [{ query: '', opts: { near: { latitude: -33.9, longitude: 151.18 }, limit: 3 } }])
    assert.deepEqual(locations, [{ latitude: -33.9, longitude: 151.18 }])
  })

  test('a search with no hits says "No venues found." and searches no offers', async (t) => {
    const h = await withVenues(t, [])
    let offerSearches = 0
    h.fake.searchOffers = () => {
      offerSearches++
      return Promise.resolve([])
    }
    const result = await h.call('pub_points_venue_offers', { query: 'nowhere' })
    assert.equal(textOf(result), 'No venues found.')
    assert.equal(offerSearches, 0)
  })

  test('no venue ids, query or coordinate is an error naming what to give', async (t) => {
    for (const args of [{}, { venueIds: [] }, { latitude: -33.9 }]) {
      const h = await connect(t)
      const result = await h.call('pub_points_venue_offers', args)
      assert.equal(result.isError, true, JSON.stringify(args))
      assert.equal(textOf(result), 'Give venueIds, a query, or latitude and longitude.')
      assert.deepEqual(h.fake.reads, [])
    }
  })
})
