// SPDX-License-Identifier: GPL-3.0-or-later
import './backstop.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import type { OrderSummary } from '../dist/api.js'
import { dollarsFromCents, formatBalances, formatOrganisation, formatRewards, formatTier, offerValue } from '../dist/format.js'
import { record } from './harness.ts'

test('credit amounts are cents', () => {
  assert.equal(dollarsFromCents(1050), '$10.50')
  assert.equal(dollarsFromCents(undefined), '$0.00')
})

test('balances show points, credit and upcoming expiry', () => {
  const now = new Date('2026-11-05T00:00:00Z')
  const lines = formatBalances({ pointsBalance: 1234, creditBalance: 2500, pointsExpireAt: '2026-11-15T00:00:00Z' }, now)
  assert.deepEqual(lines, ['Points balance: 1,234 points', 'Credit balance: $25.00', 'Points expire: 15 Nov 2026 (10 days)'])
})

test('past expiry is not shown', () => {
  const now = new Date('2026-11-05T00:00:00Z')
  const lines = formatBalances({ pointsBalance: 0, creditBalance: 0, pointsExpireAt: '2026-01-01T00:00:00Z' }, now)
  assert.equal(lines.length, 2)
})

test('tier spend and distance to next tier are cents', () => {
  const lines = formatTier({
    createdAt: '',
    anniversaryAt: '',
    spendAmount: 45000,
    tier: { name: 'Level 1', level: 1, type: 'standard', spendAmountFrom: 0, spendAmountTo: 100000, benefits: [] },
    nextTier: { level: 2, name: 'Level 2' },
  })
  assert.deepEqual(lines, ['Tier: Level 1', 'Spend this tier year: $450.00', 'Next tier: Level 2 (spend $550.00 more)'])
})

test('rewards are sorted and marked affordable', () => {
  const lines = formatRewards(
    [
      { id: 'b', pointsAmount: 2000, creditAmount: 2000 },
      { id: 'a', pointsAmount: 1000, creditAmount: 1000 },
    ],
    1500
  )
  assert.deepEqual(lines, [
    '- $10.00 credit for 1,000 points [can redeem now] (id a)',
    '- $20.00 credit for 2,000 points [500 points short] (id b)',
  ])
})

test('offer values are worded per strategy', () => {
  assert.equal(offerValue({ strategy: 'discount', value: 10 }), '10% off')
  assert.equal(offerValue({ strategy: 'discount_percentage', value: 15 }), '15% off')
  assert.equal(offerValue({ strategy: 'discount_fixed', value: 500 }), '$5.00 off')
  assert.equal(offerValue({ strategy: 'credit', value: 1000 }), '$10.00 credit')
  assert.equal(offerValue({ strategy: 'points', value: 250 }), '250 points')
  assert.equal(offerValue({ strategy: 'points_multiplier', value: 200 }), '2x points')
})

test('organisation with zero discount venues means all venues', () => {
  assert.equal(
    formatOrganisation({ id: '1', organisation: { id: 'o', name: 'Acme', discount: 15, discountVenuesCount: 0 } }),
    '- Acme: 15% group discount (all venues)'
  )
})

test('venue address HTML line breaks become commas', async () => {
  const { formatVenue } = await import('../dist/format.js')
  assert.equal(
    formatVenue({ objectID: 'v1', title: 'Death & Co Melbourne', location: { address: '87 Flinders Ln,<br />Melbourne VIC 3000' } }),
    'Death & Co Melbourne, 87 Flinders Ln, Melbourne VIC 3000 (venue id v1)'
  )
})

test('singular point and venue', async () => {
  const { points } = await import('../dist/format.js')
  assert.equal(points(1), '1 point')
  assert.equal(
    formatOrganisation({ id: '1', organisation: { id: 'o', name: 'Club', discount: 10, discountVenuesCount: 1 } }),
    '- Club: 10% group discount (1 venue)'
  )
})

test('open-now reads UTC slots keyed by UTC weekday', async () => {
  const { isOpenNow } = await import('../dist/format.js')
  const venue = { objectID: 'v', openingHours: { hours: { th: ['0100', '0115'] } } }
  assert.equal(isOpenNow(venue, new Date('2026-11-05T01:20:00Z')), true) // Thursday 01:20 UTC
  assert.equal(isOpenNow(venue, new Date('2026-11-05T01:30:00Z')), false)
  assert.equal(isOpenNow({ objectID: 'x' }), null)
})

// Orders as GET /orders returns them (contract §5). Expected values are worked out by hand from
// this fixture; the Sydney/UTC months come from Intl on each createdAt:
//   o1 2026-10-31T14:30Z = Sydney 1 Nov 01:30 (AEDT), UTC 31 Oct
//   o4 2026-09-30T13:59Z = Sydney 30 Sep 23:59 (AEST), UTC 30 Sep
//   o8 2026-09-30T14:00Z = Sydney 1 Oct 00:00,          UTC 30 Sep
const SPENDING_ORDERS: OrderSummary[] = [
  { id: 'o5', status: 'completed', chargeAmount: 1200, earnedPointsAmount: 120, createdAt: '2026-11-05T01:00:00Z' },
  {
    id: 'o1',
    status: 'completed',
    chargeAmount: 2550,
    earnedPointsAmount: 255,
    venue: { id: 'v-a' },
    createdAt: '2026-10-31T14:30:00Z',
  },
  {
    id: 'o3',
    status: 'reversed',
    chargeAmount: 9999,
    earnedPointsAmount: 999,
    venue: { id: 'v-a' },
    createdAt: '2026-10-20T02:00:00Z',
  },
  {
    id: 'o2',
    status: 'completed',
    chargeAmount: 1000,
    earnedPointsAmount: null,
    venue: { id: 'v-b' },
    createdAt: '2026-10-15T02:00:00Z',
  },
  { id: 'o6', status: 'refunded', chargeAmount: 500, earnedPointsAmount: 50, venue: { id: 'v-b' }, createdAt: '2026-10-10T02:00:00Z' },
  { id: 'o7', status: 'completed', chargeAmount: 100, earnedPointsAmount: 10, venue: { id: 'v-a' }, createdAt: '2026-10-05T03:00:00Z' },
  { id: 'o8', status: 'completed', chargeAmount: 40, earnedPointsAmount: 4, venue: { id: 'v-b' }, createdAt: '2026-09-30T14:00:00Z' },
  { id: 'o4', status: 'completed', chargeAmount: 730, venue: { id: 'v-unknown' }, createdAt: '2026-09-30T13:59:00Z' },
]
const SPENDING_VENUES: [string, string][] = [
  ['v-a', 'The Local'],
  ['v-b', 'The Royal'],
]

/** Runs summariseSpending in a child process, because TIMEZONE is read from the env when config.js loads. */
function spendingIn(timeZone: string | undefined, orders = SPENDING_ORDERS, venues = SPENDING_VENUES) {
  const env = { ...process.env }
  delete env.PUB_POINTS_TIMEZONE
  if (timeZone !== undefined) env.PUB_POINTS_TIMEZONE = timeZone
  const url = new URL('../dist/format.js', import.meta.url).href
  const script = `const { summariseSpending } = await import(${JSON.stringify(url)});
const [orders, venues] = JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify(summariseSpending(orders, new Map(venues))));`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([orders, venues])], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return record(JSON.parse(r.stdout), 'summary')
}

test('spending totals completed orders only', () => {
  const s = spendingIn(undefined)
  assert.equal(s.orders, 6) // o1 o2 o4 o5 o7 o8; o3 reversed and o6 refunded are left out
  assert.equal(s.totalCents, 5620) // 2550 + 1000 + 730 + 1200 + 100 + 40
  assert.equal(s.pointsEarned, 389) // 255 + 120 + 10 + 4; o2 null and o4 absent count 0
  assert.deepEqual(s.byVenue, [
    { venue: 'The Local', orders: 2, totalCents: 2650 },
    { venue: 'Unknown venue', orders: 1, totalCents: 1200 },
    { venue: 'The Royal', orders: 2, totalCents: 1040 },
    { venue: 'venue id v-unknown', orders: 1, totalCents: 730 },
  ])
})

test('spending months are Australia/Sydney months by default', () => {
  assert.deepEqual(spendingIn(undefined).byMonth, [
    { month: '2026-09', orders: 1, totalCents: 730 },
    { month: '2026-10', orders: 3, totalCents: 1140 },
    { month: '2026-11', orders: 2, totalCents: 3750 },
  ])
})

test('spending months follow PUB_POINTS_TIMEZONE', () => {
  assert.deepEqual(spendingIn('UTC').byMonth, [
    { month: '2026-09', orders: 2, totalCents: 770 },
    { month: '2026-10', orders: 3, totalCents: 3650 },
    { month: '2026-11', orders: 1, totalCents: 1200 },
  ])
})

test('spending over no orders, or only non-completed ones, is all zero', () => {
  const zero = { orders: 0, totalCents: 0, pointsEarned: 0, byVenue: [], byMonth: [] }
  assert.deepEqual(spendingIn(undefined, []), zero)
  assert.deepEqual(
    spendingIn(
      undefined,
      SPENDING_ORDERS.filter((o) => o.status !== 'completed')
    ),
    zero
  )
})

test('activity lines sign points by direction', async () => {
  const { formatActivity } = await import('../dist/format.js')
  assert.equal(
    formatActivity({
      id: '1',
      type: 'points_redemption',
      createdAt: '2026-10-19T01:00:00Z',
      data: { amount: '1000', points: '1000', expiry: '2027-04-19T01:00:00Z' },
    }),
    '- 19 Oct 2026 Points redeemed for credit: $10.00, -1,000 points, credit expires 19 Apr 2027'
  )
  assert.equal(
    formatActivity({
      id: '2',
      type: 'order',
      createdAt: '2026-10-08T01:00:00Z',
      data: { venue: 'Example Hotel', amount: '2696', points: '270', status: 'completed', hasOfferRedemptions: true },
    }),
    '- 8 Oct 2026 Order: Example Hotel, $26.96, +270 points, offer applied'
  )
})

test('card shows last four only; ISO periods read naturally', async () => {
  const { maskCard, isoPeriod } = await import('../dist/format.js')
  assert.equal(maskCard('411111******1234'), 'ending 1234')
  assert.equal(maskCard(undefined), 'on file')
  assert.equal(isoPeriod('P6M'), '6 months')
  assert.equal(isoPeriod('P1Y'), '1 year')
})

test('receipt totals include GST and label discount kinds', async () => {
  const { formatOrderDetails } = await import('../dist/format.js')
  const lines = formatOrderDetails(
    {
      id: 'o1',
      createdAt: '2026-10-08T01:15:00Z',
      items: [
        { name: 'Steak & Frites', amountWithTax: 2700 },
        { name: 'Balter XPA Pint', amountWithTax: 1870 },
      ],
      discounts: [{ name: '20% Off', amountWithTax: 374, sku: 'ORGDISCOUNT' }],
      subtotal: 4155,
      itemsAmountWithTax: 4570,
      discountsAmountWithTax: 374,
      totalAmountWithTax: 4196,
      totalTax: 381,
      payments: [{ amount: 4196, method: 'VisaDebit' }],
    },
    'Example Hotel'
  )
  assert.equal(lines[0], 'Order at Example Hotel, 8 Oct 2026 (order id o1)')
  assert.ok(lines.includes('- 20% Off (group discount): -$3.74'))
  assert.ok(lines.includes('Items: $45.70'))
  assert.ok(lines.includes('Total: $41.96 (includes $3.81 GST)'))
})

test('order summary hides points when none were earned', async () => {
  const { formatOrderSummary } = await import('../dist/format.js')
  assert.equal(
    formatOrderSummary(
      { id: 'o2', status: 'reversed', chargeAmount: 2500, earnedPointsAmount: null, createdAt: '2026-11-05T01:18:00Z' },
      'Sample Arms'
    ),
    '- 5 Nov 2026 Sample Arms, $25.00, reversed (order id o2)'
  )
})

// The read-only switch moved to parseCli (contract §2); its cases are in cli.test.ts.
test('read-only switch: config no longer exports isReadOnly', async () => {
  const config = await import('../dist/config.js')
  assert.equal('isReadOnly' in config, false)
})

test('social-linked account errors name the provider', async () => {
  const { socialProviderFromError } = await import('../dist/auth.js')
  const err = (m: string) => ({ code: 'UserLambdaValidationException', message: m })
  assert.equal(socialProviderFromError(err('PreAuthentication failed with error SIGN_IN | Google.')), 'Google')
  assert.equal(socialProviderFromError(err('PreAuthentication failed with error SIGN_IN | SignInWithApple.')), 'Apple')
  assert.equal(socialProviderFromError({ code: 'NotAuthorizedException', message: 'Incorrect username or password.' }), null)
})

test('doctor reports missing response fields', async () => {
  const { missingFields } = await import('../dist/doctor.js')
  const body = { items: [{ id: 'a', venue: { id: 'v' } }], pagination: {} }
  assert.deepEqual(missingFields(body, ['items[].id', 'items[].venue.id', 'pagination']), [])
  assert.deepEqual(missingFields(body, ['items[].chargeAmount', 'total']), ['items[].chargeAmount', 'total'])
  assert.deepEqual(missingFields({ items: [] }, ['items[].id']), [], 'an empty list cannot be checked, so it passes')
  assert.deepEqual(missingFields({ items: {} }, ['items[].id']), ['items[].id'], 'a non-array where an array is expected fails')
})

test('activity leaves out amounts and points that are not numbers, instead of showing NaN', async () => {
  const { formatActivity } = await import('../dist/format.js')
  const line = formatActivity({
    id: '3',
    type: 'order',
    createdAt: '2026-10-08T01:00:00Z',
    data: { venue: 'The Local', amount: '1,000', points: 'lots', status: 'completed' },
  })
  assert.equal(line, '- 8 Oct 2026 Order: The Local')
  assert.ok(!line.includes('NaN'), line)
})

test('activity still shows a zero amount and zero points', async () => {
  const { formatActivity } = await import('../dist/format.js')
  assert.equal(
    formatActivity({ id: '4', type: 'order', createdAt: '2026-10-08T01:00:00Z', data: { amount: 0, points: '0' } }),
    '- 8 Oct 2026 Order: $0.00, +0 points'
  )
})

test('points per dollar has no float noise', async () => {
  const { pointsPerDollar } = await import('../dist/format.js')
  assert.equal(pointsPerDollar(0.05), 5)
  assert.equal(pointsPerDollar(0.07), 7) // 0.07 * 100 is 7.000000000000001
  assert.equal(pointsPerDollar(0.015), 1.5)
  assert.equal(pointsPerDollar(null), 0)
  assert.equal(pointsPerDollar(undefined), 0)
})

test('credit label: known type, unknown type, empty type', async () => {
  const { formatCredit } = await import('../dist/format.js')
  const credit = (type: string | undefined) => ({ id: 'c', type, availableBalance: 500, expiresAt: null })
  assert.match(formatCredit(credit('refund')), /^- \$5\.00 Refund, /)
  assert.match(formatCredit(credit('foo')), /^- \$5\.00 foo, /)
  assert.match(formatCredit(credit('')), /^- \$5\.00 Credit, /)
  assert.match(formatCredit(credit(undefined)), /^- \$5\.00 Credit, /)
})
