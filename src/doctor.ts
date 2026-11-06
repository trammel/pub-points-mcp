// SPDX-License-Identifier: GPL-3.0-or-later
// Health check: is the client version this server targets still accepted, and does every
// endpoint the tools rely on still answer with the fields the tools read? Read-only.

import { APP_VERSION, runCommand } from './config.js'
import { AuthError, loadSession } from './auth.js'
import type { PubPointsApi } from './api.js'

type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

export interface CheckResult {
  name: string
  status: CheckStatus
  detail: string
}

/** Dotted field paths; "items[]." / "offers[]." means "on the first element, if any". */
type FieldPath = string

/** Record ids seen by earlier checks in the same run, for the checks that read one record. */
type Found = Map<'offer' | 'order' | 'membership' | 'venue', string>

/** Thrown by a check that has nothing to look at (no record id from an earlier check, no gift right now). */
class SkipCheck extends Error {
  // Name set in the constructor, not a class field: see ApiError in api.ts.
  constructor(message: string) {
    super(message)
    this.name = 'SkipCheck'
  }
}

function need(found: Found, kind: 'offer' | 'order' | 'membership' | 'venue', source: string): string {
  const id = found.get(kind)
  if (id === undefined) throw new SkipCheck(`no ${kind} id from ${source} to check with`)
  return id
}

function remember<T extends { id: string }>(found: Found, kind: 'offer' | 'order' | 'membership', items: T[]): T[] {
  const first = items[0]
  if (first) found.set(kind, first.id)
  return items
}

interface EndpointCheck {
  name: string
  tools: string
  run: (client: PubPointsApi, signal: AbortSignal, found: Found) => Promise<unknown>
  fields: FieldPath[]
}

/**
 * One entry per endpoint group, naming the fields the formatters depend on. Each goes through
 * the same client method the tools use, so a response that no longer matches the client's
 * schema fails here with the field named, as well as a field going missing.
 */
const ENDPOINT_CHECKS: EndpointCheck[] = [
  {
    name: 'Balances',
    tools: 'summary, rewards, credits',
    run: (c, signal) => c.getBalances(signal),
    fields: ['pointsBalance', 'creditBalance'],
  },
  {
    name: 'Tier',
    tools: 'summary, tiers, discounts',
    run: (c, signal) => c.getCustomerTier(signal),
    fields: ['tier.name', 'tier.benefits', 'spendAmount'],
  },
  { name: 'Tiers list', tools: 'tiers', run: (c, signal) => c.getTiers(signal), fields: ['items[].name', 'items[].benefits'] },
  {
    name: 'Points rewards',
    tools: 'rewards, redeem_points',
    run: (c, signal) => c.getPointsExchangeRates(signal),
    fields: ['items[].id', 'items[].pointsAmount', 'items[].creditAmount'],
  },
  { name: 'Credits', tools: 'credits', run: async (c, signal) => ({ items: await c.getAvailableCredits(signal) }), fields: ['items[].id'] },
  {
    name: 'Activity',
    tools: 'activity',
    // A start of "now" stops after the first page.
    run: async (c, signal) => ({ items: (await c.getActivities(new Date().toISOString(), signal)).items }),
    fields: ['items[].type', 'items[].createdAt', 'items[].data'],
  },
  {
    name: 'Orders',
    tools: 'orders, order_details, spending',
    run: async (c, signal, found) => ({ items: remember(found, 'order', (await c.getOrders({ max: 1 }, signal)).orders) }),
    fields: ['items[].id', 'items[].chargeAmount', 'items[].status', 'items[].venue.id'],
  },
  {
    name: 'Groups',
    tools: 'group_discounts, discounts',
    run: async (c, signal, found) => ({ items: remember(found, 'membership', await c.getCustomerOrganisations(signal)) }),
    fields: ['items[].id', 'items[].organisation.name'],
  },
  {
    name: 'Offers search',
    tools: 'offers, discounts, venue_offers, activate_offer',
    run: async (c, signal, found) => ({ offers: remember(found, 'offer', await c.searchOffers({ limit: 5 }, undefined, signal)) }),
    fields: ['offers[].id', 'offers[].activated', 'offers[].strategy', 'offers[].activationStrategy', 'offers[].displaySettings.title'],
  },
  {
    name: 'Favourites',
    tools: 'favourite_venues',
    run: async (c, signal) => ({ items: await c.getFavouriteVenues(signal) }),
    fields: ['items'],
  },
  {
    name: 'Preferences',
    tools: 'communication_preferences',
    run: async (c, signal) => ({ items: await c.getCommunicationPreferences(signal) }),
    fields: ['items'],
  },
  { name: 'Referral code', tools: 'referral', run: (c, signal) => c.getReferralCode(signal), fields: ['code'] },
  {
    name: 'Venue search',
    tools: 'find_venues, venue_offers, group_discounts',
    run: async (c, signal, found) => {
      const hits = await c.searchVenues('', { limit: 1 }, signal)
      if (hits[0]) found.set('venue', hits[0].objectID)
      return { hits }
    },
    fields: ['hits[].objectID', 'hits[].title', 'hits[].openingHours.hours', 'hits[].openingHours.text'],
  },
  // Single-record reads, using ids the list checks above found. All are GETs except the venue
  // lookup, which Algolia only offers as a read-only POST.
  {
    name: 'Offer details',
    tools: 'offer_details, activate_offer',
    run: (c, signal, found) => c.getOfferDetails(need(found, 'offer', 'Offers search'), signal),
    fields: ['id', 'activated', 'strategy', 'value'],
  },
  {
    name: 'Order receipt',
    tools: 'order_details',
    run: (c, signal, found) => c.getOrder(need(found, 'order', 'Orders'), signal),
    fields: ['id', 'createdAt'],
  },
  {
    name: 'Group details',
    tools: 'group_discounts',
    run: (c, signal, found) => c.getCustomerOrganisation(need(found, 'membership', 'Groups'), signal),
    fields: ['id', 'organisation.name'],
  },
  {
    name: 'Venue lookup',
    tools: 'favourite_venues, group_discounts, offer_details, add/remove favourite',
    run: async (c, signal, found) => ({ hits: await c.getVenuesByIds([need(found, 'venue', 'Venue search')], signal) }),
    fields: ['hits[].objectID', 'hits[].title'],
  },
  { name: 'Profile', tools: 'profile', run: (c, signal) => c.getProfile(signal), fields: ['email'] },
  {
    name: 'Birthday gift',
    tools: 'discounts, redeem_birthday_gift',
    run: async (c, signal) => {
      const gift = await c.getBirthdayGift(signal)
      if (gift === null) throw new SkipCheck('no birthday gift right now, so its fields cannot be checked')
      return gift
    },
    fields: ['value'],
  },
]

/** Returns the field paths missing from a response. Empty arrays cannot be checked and pass. */
export function missingFields(value: unknown, paths: FieldPath[]): FieldPath[] {
  return paths.filter((path) => {
    let current: unknown = value
    for (const raw of path.split('.')) {
      const isArray = raw.endsWith('[]')
      const key = isArray ? raw.slice(0, -2) : raw
      if (current === null || typeof current !== 'object' || !(key in current)) return true
      current = Reflect.get(current, key)
      if (isArray) {
        if (!Array.isArray(current)) return true
        if (current.length === 0) return false
        current = current[0]
      }
    }
    return false
  })
}

function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function runDoctor(client: PubPointsApi, signal: AbortSignal): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  try {
    const { updateType } = await client.checkAppVersion(APP_VERSION, signal)
    results.push(
      updateType === 'none'
        ? { name: 'Client version', status: 'ok', detail: `${APP_VERSION} is current` }
        : updateType === 'soft'
          ? {
              name: 'Client version',
              status: 'warn',
              detail: `${APP_VERSION} is behind a newer release; the API may have gained or changed fields`,
            }
          : {
              name: 'Client version',
              status: 'fail',
              detail: `${APP_VERSION} is no longer accepted by The Pass's update check; expect API changes`,
            }
    )
  } catch (err) {
    results.push({ name: 'Client version', status: 'fail', detail: detail(err) })
  }

  try {
    await client.getPublicSettings(signal)
    results.push({ name: 'API reachable', status: 'ok', detail: 'public settings answered' })
  } catch (err) {
    results.push({ name: 'API reachable', status: 'fail', detail: detail(err) })
    return results
  }

  let signedIn: boolean
  try {
    signedIn = (await loadSession()) !== null || Boolean(process.env.THEPASS_EMAIL)
  } catch (err) {
    results.push({ name: 'Signed in', status: 'fail', detail: detail(err) })
    return results
  }
  if (!signedIn) {
    results.push({ name: 'Signed in', status: 'skip', detail: `no session; run \`${runCommand('login')}\` to check account endpoints` })
    return results
  }

  const found: Found = new Map()
  for (const check of ENDPOINT_CHECKS) {
    try {
      const missing = missingFields(await check.run(client, signal, found), check.fields)
      results.push(
        missing.length === 0
          ? { name: check.name, status: 'ok', detail: check.tools }
          : { name: check.name, status: 'fail', detail: `missing ${missing.join(', ')} (affects ${check.tools})` }
      )
    } catch (err) {
      if (err instanceof SkipCheck) {
        results.push({ name: check.name, status: 'skip', detail: err.message })
        continue
      }
      results.push({ name: check.name, status: 'fail', detail: detail(err) })
      if (err instanceof AuthError) break
    }
  }
  return results
}

const ICONS: Record<CheckStatus, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' }

export function formatDoctor(results: CheckResult[]): string[] {
  const width = Math.max(...results.map((r) => r.name.length))
  return results.map((r) => `${ICONS[r.status]}  ${r.name.padEnd(width)}  ${r.detail}`)
}
