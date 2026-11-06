// SPDX-License-Identifier: GPL-3.0-or-later
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import type { PointsExchangeRate, PubPointsApi } from './api.js'
import { ConfirmationStore } from './confirmation.js'
import { formatDoctor, runDoctor } from './doctor.js'
import {
  date,
  dollarsFromCents,
  formatBalances,
  formatCredit,
  formatOffer,
  formatOpeningHours,
  formatOrganisation,
  formatRewards,
  formatTier,
  formatTierBenefits,
  isOpenNow,
  needsActivation,
  points,
  rewardLabel,
  venueLine,
} from './format.js'
import { registerAccountTools } from './tools-account.js'
import { registerActionTools } from './tools-actions.js'
import {
  READ_ONLY,
  errorMessage,
  errorText,
  handle,
  idField,
  locationShape,
  mapLimit,
  section,
  structured,
  text,
  toLocation,
  venueNamesNote,
} from './tool-helpers.js'

/** Most offer searches the venue and discount tools run at once. */
const OFFER_SEARCH_CONCURRENCY = 5

export interface RegisterOptions {
  /** Leave out every tool that changes the account. */
  readOnly: boolean
  /** Where confirmation tokens live; a fresh in-memory store when omitted. */
  confirmations?: ConfirmationStore
}

const RewardsOutputSchema = z.object({
  pointsBalance: z.number(),
  rewards: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      pointsAmount: z.number(),
      creditCents: z.number(),
      canRedeemNow: z.boolean(),
      pointsShort: z.number().describe('0 when the balance already covers it'),
    })
  ),
})

const FindVenuesOutputSchema = z.object({
  venues: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      address: z.string().nullable(),
      distanceKm: z.number().nullable(),
      openNow: z.boolean().nullable().describe('null when the venue publishes no opening hours'),
    })
  ),
})

function rewardRows(rates: PointsExchangeRate[], balance: number) {
  return [...rates]
    .sort((a, b) => a.pointsAmount - b.pointsAmount)
    .map((r) => ({
      id: r.id,
      label: rewardLabel(r),
      pointsAmount: r.pointsAmount,
      creditCents: r.creditAmount,
      canRedeemNow: r.pointsAmount <= balance,
      pointsShort: Math.max(0, r.pointsAmount - balance),
    }))
}

export function registerTools(server: McpServer, client: PubPointsApi, options: RegisterOptions): void {
  const confirmations = options.confirmations ?? new ConfirmationStore()
  registerAccountTools(server, client)
  registerActionTools(server, client, { readOnly: options.readOnly, confirmations })

  server.registerTool(
    'pub_points_doctor',
    {
      title: 'Pub Points: health check',
      description:
        'Checks that the client version this server targets is still accepted, and that each API endpoint the tools use still returns the fields they read. Use it when tools fail or return odd results.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    handle(async (_args, signal) => {
      const results = await runDoctor(client, signal)
      const failed = results.filter((r) => r.status === 'fail').length
      return text([failed ? `${failed} check${failed === 1 ? '' : 's'} failed.` : 'All checks passed.', '', ...formatDoctor(results)])
    })
  )

  server.registerTool(
    'pub_points_summary',
    {
      title: 'Pub Points: points and tier',
      description:
        'Current points balance, credit balance, points expiry, tier status and progress toward the next points reward on The Pass (Australian Venue Co) loyalty app.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    handle(async (_args, signal) => {
      const balances = await client.getBalances(signal)
      const [tier, rates] = await Promise.allSettled([client.getCustomerTier(signal), client.getPointsExchangeRates(signal)])
      const balance = balances.pointsBalance
      return text([
        ...formatBalances(balances),
        ...(tier.status === 'fulfilled' ? formatTier(tier.value) : []),
        ...(rates.status === 'fulfilled' ? nextRewardLine(rates.value.items, balance) : []),
      ])
    })
  )

  server.registerTool(
    'pub_points_rewards',
    {
      title: 'Pub Points: points rewards',
      description:
        'Rewards that points can be exchanged for (venue credit), with whether the current balance covers each one. Read-only; does not redeem.',
      inputSchema: z.object({}),
      outputSchema: RewardsOutputSchema,
      annotations: READ_ONLY,
    },
    handle(async (_args, signal) => {
      const [balances, rates] = await Promise.all([client.getBalances(signal), client.getPointsExchangeRates(signal)])
      const balance = balances.pointsBalance
      return structured([`Points balance: ${points(balance)}`, '', ...formatRewards(rates.items, balance)], {
        pointsBalance: balance,
        rewards: rewardRows(rates.items, balance),
      })
    })
  )

  server.registerTool(
    'pub_points_credits',
    {
      title: 'Pub Points: available credit',
      description:
        'Unspent, unexpired credit on the account (birthday gifts, points redemptions, refunds, promo codes and so on), soonest expiry first.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    handle(async (_args, signal) => {
      const [balances, credits] = await Promise.all([client.getBalances(signal), client.getAvailableCredits(signal)])
      return text([
        `Credit balance: ${dollarsFromCents(balances.creditBalance)}`,
        '',
        ...(credits.length ? credits.map(formatCredit) : ['No unspent credit.']),
      ])
    })
  )

  server.registerTool(
    'pub_points_discounts',
    {
      title: 'Pub Points: all discounts available',
      description:
        'Everything that currently lowers the price for this member: tier benefits, group (organisation) discounts and their offers, offers waiting to be activated, activated offers, birthday gift, available credit and points rewards that can be redeemed now. For the venues each group discount covers, use pub_points_group_discounts. To add a group discount (workplace, club) the member has a code for, use pub_points_join_organisation. Pass latitude/longitude to include location-limited offers.',
      inputSchema: z.object(locationShape),
      annotations: READ_ONLY,
    },
    handle(async (args, signal) => {
      const location = toLocation(args)
      const [balances, tier, orgs, offers, birthday, credits, rates] = await Promise.allSettled([
        client.getBalances(signal),
        client.getCustomerTier(signal),
        client.getCustomerOrganisations(signal),
        client.searchOffers({}, location, signal),
        client.getBirthdayGift(signal),
        client.getAvailableCredits(signal),
        client.getPointsExchangeRates(signal),
      ])

      const orgOffers =
        orgs.status === 'fulfilled'
          ? await mapLimit(orgs.value, OFFER_SEARCH_CONCURRENCY, (o) =>
              client.searchOffers({ organisations: [o.organisation.id] }, location, signal)
            )
          : []

      const balance = balances.status === 'fulfilled' ? balances.value.pointsBalance : 0
      return text([
        ...section('Tier benefits', tier, (t) => [`Tier: ${t.tier.name}`, ...formatTierBenefits(t.tier.benefits)]),
        ...section('Group discounts', orgs, (list) =>
          list.flatMap((o, i) => {
            const found = orgOffers[i]
            const offerLines =
              found?.status === 'fulfilled'
                ? found.value.map((x) => `  ${formatOffer(x)}`)
                : [`  (offers unavailable: ${errorMessage(found?.reason ?? 'not searched')})`]
            return [formatOrganisation(o), ...offerLines]
          })
        ),
        ...section('Offers to activate', offers, (list) => list.filter(needsActivation).map(formatOffer)),
        ...section('Activated offers', offers, (list) => {
          const on = list.filter((o) => o.activated)
          const shown = on.slice(0, 50)
          return [
            ...shown.map(formatOffer),
            ...(on.length > shown.length ? [`(${on.length - shown.length} more; see pub_points_offers)`] : []),
          ]
        }),
        ...section('Birthday gift', birthday, (g) =>
          g?.value
            ? [
                `${dollarsFromCents(g.value)} birthday credit, ${date(g.startAt)} to ${date(g.endAt)}` +
                  (g.cardTransactionRequirementMet === false ? ' (locked: needs a card transaction first)' : ''),
              ]
            : []
        ),
        ...section('Available credit', credits, (list) => list.map(formatCredit)),
        ...section('Points rewards redeemable now', rates, (r) =>
          r.items.filter((x) => x.pointsAmount <= balance).map((x) => `- ${rewardLabel(x)}`)
        ),
      ])
    })
  )

  server.registerTool(
    'pub_points_find_venues',
    {
      title: 'Pub Points: find venues',
      description:
        'Search The Pass venues by name or suburb, or list venues near a coordinate. Shows whether each is open now; set includeHours for weekly opening hours, venue styles and links. Returns venue ids for pub_points_venue_offers.',
      inputSchema: z.object({
        query: z.string().default('').describe('Venue name, suburb or keyword; empty with latitude/longitude lists nearby venues'),
        ...locationShape,
        radiusKm: z.number().positive().max(100).optional().describe('Search radius around the coordinate, default 20 km'),
        openNow: z.boolean().optional().describe('Only venues open right now'),
        includeHours: z.boolean().optional().describe('Add weekly opening hours, venue styles and website/booking links'),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      outputSchema: FindVenuesOutputSchema,
      annotations: READ_ONLY,
    },
    handle(async (args, signal) => {
      let venues = await client.searchVenues(
        args.query,
        { near: toLocation(args), radiusMetres: args.radiusKm ? args.radiusKm * 1000 : undefined, limit: args.limit },
        signal
      )
      if (args.openNow) venues = venues.filter((v) => isOpenNow(v) === true)
      const data = {
        venues: venues.map((v) => {
          const dist = v._rankingInfo?.geoDistance
          return {
            id: v.objectID,
            title: v.title ?? null,
            address: v.location?.address ?? null,
            distanceKm: typeof dist === 'number' && dist > 0 ? Math.round(dist / 100) / 10 : null,
            openNow: isOpenNow(v),
          }
        }),
      }
      if (venues.length === 0) return structured(['No venues found.'], data)
      if (!args.includeHours)
        return structured(
          venues.map((v) => `- ${venueLine(v)}`),
          data
        )
      return structured(
        venues.flatMap((v) => [
          `## ${venueLine(v)}`,
          ...(v.venueStyles?.length ? [`Styles: ${v.venueStyles.map((s) => s.label.replace(/&amp;/g, '&')).join(', ')}`] : []),
          ...formatOpeningHours(v),
          ...(v.links?.avcSite ? [`Website: ${v.links.avcSite}`] : []),
          ...(v.links?.bookingSite ? [`Bookings: ${v.links.bookingSite}`] : []),
          '',
        ]),
        data
      )
    })
  )

  server.registerTool(
    'pub_points_venue_offers',
    {
      title: 'Pub Points: offers at venues',
      description:
        'Offers available at specific venues. Give venue ids (from pub_points_find_venues), or a venue name/suburb query and/or a coordinate to search first.',
      inputSchema: z.object({
        venueIds: z.array(idField).max(50).optional(),
        query: z.string().optional().describe('Venue name or suburb to search when venueIds is not given'),
        ...locationShape,
        limit: z.number().int().min(1).max(20).default(5).describe('Max venues to look up when searching'),
      }),
      annotations: READ_ONLY,
    },
    handle(async (args, signal) => {
      const location = toLocation(args)
      let venues: { id: string; label: string }[]
      const notes: string[] = []
      if (args.venueIds?.length) {
        const ids = args.venueIds
        const known = await client.getVenuesByIds(ids, signal).then(
          (list) => new Map(list.map((v) => [v.objectID, v])),
          (err: unknown) => {
            notes.push(venueNamesNote(err))
            return new Map<string, never>()
          }
        )
        venues = ids.map((id) => {
          const v = known.get(id)
          return { id, label: v ? venueLine(v) : `venue id ${id}` }
        })
      } else if (args.query || location) {
        const hits = await client.searchVenues(args.query ?? '', { near: location, limit: args.limit }, signal)
        venues = hits.map((v) => ({ id: v.objectID, label: venueLine(v) }))
      } else {
        return errorText('Give venueIds, a query, or latitude and longitude.')
      }
      if (venues.length === 0) return text(['No venues found.'])

      const results = await mapLimit(venues, OFFER_SEARCH_CONCURRENCY, async (v) => ({
        venue: v,
        offers: await client.searchOffers({ venues: [v.id] }, location, signal),
      }))
      const lines = results.flatMap((r, i) => {
        if (r.status === 'rejected') return [`## ${venues[i]?.label ?? ''}`, `(unavailable: ${errorMessage(r.reason)})`, '']
        const { venue, offers } = r.value
        return [`## ${venue.label}`, ...(offers.length ? offers.map(formatOffer) : ['(no offers)']), '']
      })
      return text([...notes, ...lines])
    })
  )
}

function nextRewardLine(rates: PointsExchangeRate[], balance: number): string[] {
  const next = [...rates].sort((a, b) => a.pointsAmount - b.pointsAmount).find((r) => r.pointsAmount > balance)
  const best = [...rates].filter((r) => r.pointsAmount <= balance).sort((a, b) => b.pointsAmount - a.pointsAmount)[0]
  const lines: string[] = []
  if (best) lines.push(`Best reward redeemable now: ${dollarsFromCents(best.creditAmount)} credit for ${points(best.pointsAmount)}`)
  if (next) {
    lines.push(
      `Next reward: ${dollarsFromCents(next.creditAmount)} credit at ${points(next.pointsAmount)} (${points(next.pointsAmount - balance)} to go)`
    )
  }
  return lines
}
