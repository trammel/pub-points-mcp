// SPDX-License-Identifier: GPL-3.0-or-later
// format.js branches the tool tests do not reach: missing and odd values, singular and plural,
// and the wording for every offer strategy and order receipt shape. Expected strings are written
// out by hand from each fixture. Dates are Australia/Sydney (the default zone).

import './backstop.ts'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  date,
  daysUntil,
  formatActivity,
  formatBalances,
  formatOffer,
  formatOrderDetails,
  formatOrganisation,
  formatTier,
  formatVenue,
  isoPeriod,
  joinedText,
  maskCard,
  offerValue,
  openNowSuffix,
  stripHtml,
} from '../dist/format.js'
import type { CustomerTier } from '../dist/api.js'

const NOW = new Date('2026-11-05T00:00:00Z')

describe('dates', () => {
  test('a value that is not a date is shown as given', () => {
    assert.equal(date('soon'), 'soon')
  })

  test('daysUntil: null for a missing or unreadable date, rounded up otherwise', () => {
    assert.equal(daysUntil(null, NOW), null)
    assert.equal(daysUntil('soon', NOW), null)
    assert.equal(daysUntil('2026-11-05T12:00:00Z', NOW), 1)
    assert.equal(daysUntil('2026-11-03T12:00:00Z', NOW), -1)
  })

  test('points expiring in one day say "1 day"; expiring today say "0 days"', () => {
    const b = (pointsExpireAt: string) => formatBalances({ pointsBalance: 10, creditBalance: 0, pointsExpireAt }, NOW)
    assert.equal(b('2026-11-06T00:00:00Z')[2], 'Points expire: 6 Nov 2026 (1 day)')
    assert.equal(b('2026-11-05T00:00:00Z')[2], 'Points expire: 5 Nov 2026 (0 days)')
  })

  test('an unreadable points expiry is left out, not shown as a date', () => {
    assert.equal(formatBalances({ pointsBalance: 10, creditBalance: 0, pointsExpireAt: 'soon' }, NOW).length, 2)
  })
})

describe('formatTier', () => {
  const base: CustomerTier = { spendAmount: 120000, tier: { name: 'Silver', spendAmountTo: 100000 } }

  test('spend past the tier target shows $0.00 more, never a negative amount', () => {
    assert.equal(formatTier({ ...base, nextTier: { name: 'Gold' } })[2], 'Next tier: Gold (spend $0.00 more)')
  })

  test('a next tier with no target names the tier without an amount', () => {
    assert.equal(formatTier({ ...base, tier: { name: 'Silver' }, nextTier: { name: 'Gold' } })[2], 'Next tier: Gold')
  })

  test('the top tier with no anniversary is the tier and spend only', () => {
    assert.deepEqual(formatTier(base), ['Tier: Silver', 'Spend this tier year: $1200.00'])
  })
})

describe('offerValue', () => {
  test('a price override is the price; an unknown strategy is shown as given', () => {
    assert.equal(offerValue({ strategy: 'discount_price_override', value: 1500 }), 'price $15.00')
    assert.equal(offerValue({ strategy: 'mystery', value: 7 }), 'mystery 7')
  })

  test('a points multiplier keeps up to two decimals', () => {
    assert.equal(offerValue({ strategy: 'points_multiplier', value: 150 }), '1.5x points')
    assert.equal(offerValue({ strategy: 'points_multiplier', value: 125 }), '1.25x points')
  })
})

describe('formatOffer', () => {
  test('an offer with no title or tile title is "(untitled offer)"', () => {
    assert.match(formatOffer({ id: 'o', activated: false, strategy: 'credit', value: 100 }), /^- \(untitled offer\): /)
  })

  test('an empty title falls back to the tile title', () => {
    assert.match(
      formatOffer({ id: 'o', activated: false, strategy: 'credit', value: 100, displaySettings: { title: '', tileTitle: 'Tile' } }),
      /^- Tile: /
    )
  })

  test('flags: limit reached and multi-step criteria complete', () => {
    const line = formatOffer({
      id: 'o',
      activated: true,
      strategy: 'credit',
      value: 100,
      limitPerCustomerReached: true,
      allMultiStepCriteriaCompleted: true,
      displaySettings: { title: 'T' },
    })
    assert.ok(line.endsWith('[activated, limit reached, criteria complete] (id o)'), line)
  })

  test('an instant reward not yet redeemed asks for activation; an automatic offer does not', () => {
    const ir = formatOffer({
      id: 'o',
      activated: false,
      strategy: 'credit',
      value: 100,
      type: 'instant_reward',
      displaySettings: { title: 'T' },
    })
    assert.ok(ir.includes('[not activated: activate with pub_points_activate_offer]'), ir)
    const auto = formatOffer({
      id: 'o',
      activated: false,
      strategy: 'credit',
      value: 100,
      activationStrategy: 'auto',
      displaySettings: { title: 'T' },
    })
    assert.ok(auto.includes('[not activated]'), auto)
  })
})

describe('formatOrganisation', () => {
  test('no discount and no venue count', () => {
    assert.equal(formatOrganisation({ id: '1', organisation: { id: 'o', name: 'Club' } }), '- Club: no group discount (venues unspecified)')
  })

  test('several venues are plural', () => {
    assert.equal(
      formatOrganisation({ id: '1', organisation: { id: 'o', name: 'Club', discount: 5, discountVenuesCount: 4 } }),
      '- Club: 5% group discount (4 venues)'
    )
  })
})

describe('venues', () => {
  test('a venue with no title is named by its id; a zero distance is not shown', () => {
    assert.equal(formatVenue({ objectID: 'v1', _rankingInfo: { geoDistance: 0 } }), 'v1 (venue id v1)')
  })

  test('newlines and repeated commas in an address collapse to single ", "', () => {
    assert.equal(
      formatVenue({ objectID: 'v1', title: 'T', location: { address: '1 King St,\r\n,Newtown' } }),
      'T, 1 King St, Newtown (venue id v1)'
    )
  })

  test('open-now suffix: open, closed, or nothing when hours are unknown', () => {
    const venue = { objectID: 'v', openingHours: { hours: { th: ['0100'] } } }
    assert.equal(openNowSuffix(venue, new Date('2026-11-05T01:05:00Z')), ' [open now]')
    assert.equal(openNowSuffix(venue, new Date('2026-11-05T02:00:00Z')), ' [closed now]')
    assert.equal(openNowSuffix({ objectID: 'v' }, NOW), '')
  })

  test('a day with no entry in the hours is closed', () => {
    const venue = { objectID: 'v', openingHours: { hours: { mo: ['0100'] } } }
    assert.equal(openNowSuffix(venue, new Date('2026-11-05T01:05:00Z')), ' [closed now]')
  })
})

describe('text helpers', () => {
  test('stripHtml removes tags, decodes &nbsp; and &amp;, and collapses spaces', () => {
    assert.equal(stripHtml('  <p>Fish&nbsp;&amp;&nbsp;chips</p>\n<br>  daily '), 'Fish & chips daily')
  })

  test('joinedText names the group and its discount, or says "the group" when the answer has no name', () => {
    assert.equal(joinedText({ name: 'Acme', discount: 10 }), 'joined Acme with a 10% group discount')
    assert.equal(joinedText({ name: 'Acme', discount: 0 }), 'joined Acme')
    assert.equal(joinedText(null), 'joined the group')
  })

  test('maskCard: fewer than four digits is "on file"', () => {
    assert.equal(maskCard('12'), 'on file')
    assert.equal(maskCard('1234'), 'ending 1234')
  })

  test('isoPeriod: weeks and days, plurals, and anything unreadable', () => {
    assert.equal(isoPeriod('P2W3D'), '2 weeks 3 days')
    assert.equal(isoPeriod('P1D'), '1 day')
    assert.equal(isoPeriod('P'), 'unknown')
    assert.equal(isoPeriod('6 months'), '6 months')
    assert.equal(isoPeriod(null), 'unknown')
  })
})

describe('formatActivity', () => {
  test('an unknown type is shown as given, with its code and a status other than completed', () => {
    assert.equal(
      formatActivity({ id: '1', type: 'mystery_event', createdAt: '2026-10-08T01:00:00Z', data: { code: 'ABC', status: 'pending' } }),
      '- 8 Oct 2026 mystery_event: code ABC, pending'
    )
  })

  test('a record with no data is the date and label alone', () => {
    assert.equal(
      formatActivity({ id: '1', type: 'credit_expiry', createdAt: '2026-10-08T01:00:00Z', data: null }),
      '- 8 Oct 2026 Credit expired'
    )
  })

  test('expired points are negative', () => {
    assert.equal(
      formatActivity({ id: '1', type: 'points_expiry', createdAt: '2026-10-08T01:00:00Z', data: { points: 50 } }),
      '- 8 Oct 2026 Points expired: -50 points'
    )
  })

  test('a tier change with no tier name and no bonus adds nothing', () => {
    assert.equal(
      formatActivity({ id: '1', type: 'customer_tier_change', createdAt: '2026-10-08T01:00:00Z', data: { transitionPointsAmount: 0 } }),
      '- 8 Oct 2026 Tier change'
    )
  })
})

describe('formatOrderDetails', () => {
  test('a bare receipt: no venue, no items, totals from the charge, nothing optional', () => {
    assert.deepEqual(formatOrderDetails({ id: 'o1', createdAt: '2026-10-08T01:00:00Z', chargeAmount: 500 }, undefined), [
      'Order, 8 Oct 2026 (order id o1)',
      '',
      '## Items',
      '',
      'Items: $0.00',
      'Total: $5.00',
    ])
  })

  test('a quantity of one has no "1 x"; an unknown discount sku has no kind; a reward with no value counts as 0', () => {
    const lines = formatOrderDetails(
      {
        id: 'o1',
        createdAt: '2026-10-08T01:00:00Z',
        items: [{ name: 'Pint', amountWithTax: 1200, quantity: 1 }],
        discounts: [{ name: 'Staff', amountWithTax: 100, sku: 'OTHER' }],
        totalAmountWithTax: 1100,
        offerRedemptions: [{ reward: { strategy: 'points' } }],
      },
      'The Local'
    )
    assert.ok(lines.includes('- Pint: $12.00'), lines.join('\n'))
    assert.ok(lines.includes('- Staff: -$1.00'), lines.join('\n'))
    assert.ok(lines.includes('Items: $12.00'), lines.join('\n'))
    assert.ok(lines.includes('Offers applied: 0 points'), lines.join('\n'))
    assert.ok(!lines.some((l) => l.startsWith('Discounts: ')), 'no discount total when the receipt gives none')
  })
})
