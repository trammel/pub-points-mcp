// SPDX-License-Identifier: GPL-3.0-or-later
// Read-only account tools: history, spending, tiers, referral, profile, preferences, offers.

import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { ACTIVITY_CAP, COMMUNICATION_PREFERENCE_TYPES, type PubPointsApi, type Venue } from './api.js'
import { dayEnd, dayStart, inLocalRange } from './dates.js'
import {
  ACTIVITY_LABELS,
  PREFERENCE_LABELS,
  date,
  dollarsFromCents,
  formatActivity,
  formatOffer,
  formatOrderDetails,
  formatOrderSummary,
  formatProfile,
  formatTierBenefits,
  isoPeriod,
  needsActivation,
  offerValue,
  points,
  pointsPerDollar,
  str,
  stripHtml,
  summariseSpending,
  venueLine,
} from './format.js'
import { READ_ONLY, errorMessage, handle, idField, section, structured, text, venueNamesNote } from './tool-helpers.js'
import { nonEmpty } from './text.js'

/** ", up to N friends", or nothing when the settings give no limit: the text never guesses one. */
function friendLimit(limit: number | null | undefined): string {
  return limit === null || limit === undefined ? '' : `, up to ${limit} friends`
}

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()

/** Orders `pub_points_spending` reads at most; reaching it is reported, never silent. */
const SPENDING_ORDER_CAP = 20_000
/** Either side of a receipt's time when looking up its venue in the order list. */
const ORDER_LOOKUP_WINDOW_MS = 60_000
/** Orders scanned when filtering by venue name, which the API cannot do. */
const VENUE_FILTER_ORDER_CAP = 500

const OffersOutputSchema = z.object({
  shown: z.number(),
  activated: z.number(),
  notActivated: z.number(),
  offers: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      value: z.string().describe('Offer value in words, e.g. "10% off"'),
      strategy: z.string(),
      activated: z.boolean(),
      needsActivation: z.boolean(),
      limitReached: z.boolean(),
      startAt: z.string().nullable(),
      endAt: z.string().nullable(),
    })
  ),
})

const OrdersOutputSchema = z.object({
  orders: z.array(
    z.object({
      id: z.string(),
      createdAt: z.string(),
      status: z.string(),
      venueId: z.string().nullable(),
      venueName: z.string().nullable(),
      chargeCents: z.number(),
      pointsEarned: z.number(),
    })
  ),
  venueNamesUnavailable: z.string().nullable().describe('Why venue names are missing, when the lookup failed'),
  venueSearchCapped: z.boolean().describe('True when a venue filter stopped at the scan cap with older orders left unsearched'),
})

interface VenueLookup {
  venues: Map<string, Venue>
  /** Note to show when the lookup failed, else null. */
  note: string | null
}

interface VenueNames {
  names: Map<string, string>
  /** Note to show when the lookup failed, else null. */
  note: string | null
}

export function registerAccountTools(server: McpServer, client: PubPointsApi): void {
  /** Venue records by id, via Algolia. A failed lookup comes back as a note, never as silence. */
  async function lookupVenues(ids: string[], signal: AbortSignal): Promise<VenueLookup> {
    const unique = [...new Set(ids.filter(Boolean))]
    try {
      const venues = await client.getVenuesByIds(unique, signal)
      return { venues: new Map(venues.map((v) => [v.objectID, v])), note: null }
    } catch (err) {
      return { venues: new Map(), note: venueNamesNote(err) }
    }
  }

  /** Venue id -> display name. */
  async function venueNames(ids: string[], signal: AbortSignal): Promise<VenueNames> {
    const { venues, note } = await lookupVenues(ids, signal)
    return { names: new Map([...venues].map(([id, v]) => [id, v.title ?? id])), note }
  }

  server.registerTool(
    'pub_points_activity',
    {
      title: 'Pub Points: account activity',
      description: `Account history, newest first: orders (venue, amount, points earned, offer applied), points redeemed for credit, promo codes, external purchases, tier changes and credit expiries. Reads at most the newest ${ACTIVITY_CAP.toLocaleString('en-AU')} records and says so when that cuts the list short.`,
      inputSchema: z.object({
        types: z
          .array(z.string())
          .optional()
          .describe(`Only these activity types: ${Object.keys(ACTIVITY_LABELS).join(', ')}`),
        from: dateField.describe('Start date, YYYY-MM-DD (inclusive)'),
        to: dateField.describe('End date, YYYY-MM-DD (inclusive)'),
        venue: z.string().optional().describe('Only orders whose venue name contains this text'),
        limit: z.number().int().min(1).max(500).default(30),
      }),
      annotations: READ_ONLY,
    },
    handle(async (args, signal) => {
      const venue = args.venue?.toLowerCase()
      const page = await client.getActivities(args.from ? dayStart(args.from) : undefined, signal)
      const rows = page.items
        .filter((a) => !args.types || args.types.includes(a.type))
        .filter((a) => inLocalRange(a.createdAt, args.from, args.to))
        .filter((a) => !venue || (str(a.data?.venue) ?? '').toLowerCase().includes(venue))
      const shown = rows.slice(0, args.limit)
      const more = rows.length > shown.length ? [`(${rows.length - shown.length} more; raise limit or narrow the dates)`] : []
      const oldest = page.items.at(-1)?.createdAt
      const truncated = page.truncated
        ? [
            `(Truncated: only the newest ${ACTIVITY_CAP.toLocaleString('en-AU')} records were read, back to ${date(oldest)}; give a later "from" to see a range in full.)`,
          ]
        : []
      return text([...(shown.length ? [...shown.map(formatActivity), ...more] : ['No matching activity.']), ...truncated])
    })
  )

  server.registerTool(
    'pub_points_spending',
    {
      title: 'Pub Points: spending summary',
      description:
        'Totals of completed orders paid through The Pass: total spent, points earned, top venues and a month-by-month breakdown. Reversed orders are excluded.',
      inputSchema: z.object({
        from: dateField.describe('Start date, YYYY-MM-DD (inclusive)'),
        to: dateField.describe('End date, YYYY-MM-DD (inclusive)'),
        topVenues: z.number().int().min(1).max(50).default(10),
      }),
      annotations: READ_ONLY,
    },
    handle(async (args, signal) => {
      const { orders, complete } = await client.getOrders(
        {
          after: args.from ? dayStart(args.from) : undefined,
          before: args.to ? dayEnd(args.to) : undefined,
          status: 'completed',
          max: SPENDING_ORDER_CAP,
        },
        signal
      )
      if (orders.length === 0) return text(['No completed orders in that period.'])
      const { names, note } = await venueNames(
        orders.map((o) => o.venue?.id ?? ''),
        signal
      )
      const s = summariseSpending(orders, names)
      const period = args.from || args.to ? ` (${args.from ?? 'start'} to ${args.to ?? 'today'})` : ''
      return text([
        `Orders${period}: ${s.orders}`,
        `Total spent: ${dollarsFromCents(s.totalCents)} (average ${dollarsFromCents(Math.round(s.totalCents / Math.max(1, s.orders)))})`,
        `Points earned: ${points(s.pointsEarned)}`,
        ...(complete
          ? []
          : [
              `(Only the newest ${SPENDING_ORDER_CAP.toLocaleString('en-AU')} orders were counted; give a later "from" for a complete total.)`,
            ]),
        '',
        '## Top venues',
        ...(note ? [note] : []),
        ...s.byVenue
          .slice(0, args.topVenues)
          .map((v) => `- ${v.venue}: ${dollarsFromCents(v.totalCents)} over ${v.orders} order${v.orders === 1 ? '' : 's'}`),
        '',
        '## By month',
        ...s.byMonth.map((m) => `- ${m.month}: ${dollarsFromCents(m.totalCents)} (${m.orders})`),
      ])
    })
  )

  server.registerTool(
    'pub_points_tiers',
    {
      title: 'Pub Points: tiers and benefits',
      description: "Every membership tier with its benefits, marking the member's current tier.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    handle(async (_args, signal) => {
      const [tiers, mine] = await Promise.all([client.getTiers(signal), client.getCustomerTier(signal).catch(() => null)])
      const sorted = [...tiers.items].sort((a, b) => (a.level ?? 99) - (b.level ?? 99))
      return text(
        sorted.flatMap((t) => {
          const benefits = formatTierBenefits(t.benefits)
          return [
            `## ${t.name}${mine?.tier.name === t.name ? ' (your tier)' : ''}`,
            ...(benefits.length ? benefits : ['(no benefits listed)']),
            '',
          ]
        })
      )
    })
  )

  server.registerTool(
    'pub_points_referral',
    {
      title: 'Pub Points: referral code',
      description:
        "The member's refer-a-friend code, what it earns, and the program rules (sign-up bonus, earn rates, credit expiry periods).",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    handle(async (_args, signal) => {
      const [code, settings] = await Promise.allSettled([client.getReferralCode(signal), client.getPublicSettings(signal)])
      return text([
        ...section('Your referral code', code, (c) => [
          `Code: ${c.code}${c.limitReached ? ' (limit reached; it no longer earns points)' : ''}`,
          ...(settings.status === 'fulfilled'
            ? [
                `You get ${points(settings.value.referrerRewardPointsAmount)} and your friend gets ${points(settings.value.refereeRewardPointsAmount)} when they join with it${friendLimit(settings.value.referralCodeRedemptionLimit)}.`,
              ]
            : []),
        ]),
        ...section('Program rules', settings, (s) => [
          `Sign-up bonus: ${dollarsFromCents(s.signUpBonusAmount)} credit`,
          `Points on external purchases: ${pointsPerDollar(s.externalPurchasesPointsEarnRate)} points per $1`,
          `Credit from points expires after ${isoPeriod(s.pointsCreditExpiryPeriod)}`,
          `Gift voucher credit expires after ${isoPeriod(s.giftVoucherCreditExpiryPeriod)}`,
          `Refund credit expires after ${isoPeriod(s.refundCreditExpiryPeriod)}`,
        ]),
      ])
    })
  )

  server.registerTool(
    'pub_points_promotions',
    {
      title: 'Pub Points: current promotions',
      description: 'Promotions currently featured on The Pass home screen.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    handle(async (_args, signal) => {
      const items = (await client.getPromoTiles(signal)).items
      return text(
        items.length
          ? items.map(
              (t) =>
                `- ${stripHtml(t.title ?? '(untitled)')}${t.subtitle ? `: ${stripHtml(t.subtitle)}` : ''}${t.link ? ` (${t.link})` : ''}`
            )
          : ['No promotions right now.']
      )
    })
  )

  server.registerTool(
    'pub_points_offer_details',
    {
      title: 'Pub Points: offer details and venues',
      description:
        'Full details of one offer (description, terms, type, how it activates, activation code if any) and the venues where it can be used. Use an offer id from the other tools.',
      inputSchema: z.object({
        offerId: idField,
        maxVenues: z.number().int().min(1).max(200).default(30),
      }),
      annotations: READ_ONLY,
    },
    handle(async (args, signal) => {
      const [offer, venueIds] = await Promise.all([
        client.getOfferDetails(args.offerId, signal),
        client.getOfferVenueIds(args.offerId, signal),
      ])
      const shownIds = venueIds.slice(0, args.maxVenues)
      const { venues, note: venueNote } = await lookupVenues(shownIds, signal)
      const ds = offer.displaySettings ?? {}
      const how =
        offer.type === 'instant_reward'
          ? 'Instant reward: redeem it to receive the reward now.'
          : offer.activationStrategy === 'in_app'
            ? 'Activate it in the app (or with pub_points_activate_offer) before ordering.'
            : offer.activationStrategy === 'code'
              ? 'Activates with a code (use pub_points_redeem_code).'
              : 'Applies automatically to eligible orders.'
      return text([
        `# ${ds.title ?? offer.name ?? offer.id}`,
        `Value: ${offerValue(offer)}`,
        `Valid: ${date(offer.startAt)} to ${date(offer.endAt, 'no end date')}`,
        `Status: ${offer.activated ? 'activated' : 'not activated'}${offer.limitPerCustomerReached ? ', limit reached' : ''}`,
        `How it works: ${how}`,
        ...(offer.activationCode ? [`Activation code: ${offer.activationCode}`] : []),
        ...(offer.rewardExpiresAt ? [`Reward expires: ${date(offer.rewardExpiresAt)}`] : []),
        ...(ds.description ? ['', stripHtml(ds.description)] : []),
        ...(ds.termsAndConditions ? ['', `Terms: ${stripHtml(ds.termsAndConditions)}`] : []),
        '',
        `## Venues (${venueIds.length})`,
        ...(venueNote ? [venueNote] : []),
        ...shownIds.map((id) => {
          const v = venues.get(id)
          return v ? `- ${venueLine(v)}` : `- venue id ${id}`
        }),
        ...(venueIds.length > args.maxVenues ? [`(${venueIds.length - args.maxVenues} more)`] : []),
      ])
    })
  )

  server.registerTool(
    'pub_points_offers',
    {
      title: 'Pub Points: offers by status',
      description:
        'Every offer available to the member, filtered by status. not_activated lists offers still waiting to be activated (activate them with pub_points_activate_offer); activated lists ones already on the account. Optional text filter on the title.',
      inputSchema: z.object({
        status: z.enum(['all', 'activated', 'not_activated']).default('all'),
        search: z.string().optional().describe('Only offers whose title contains this text'),
      }),
      outputSchema: OffersOutputSchema,
      annotations: READ_ONLY,
    },
    handle(async (args, signal) => {
      const q = args.search?.toLowerCase()
      const all = (await client.searchOffers({}, undefined, signal)).filter(
        (o) => !q || [o.displaySettings?.title, o.displaySettings?.tileTitle].some((t) => (t ?? '').toLowerCase().includes(q))
      )
      const offers = all.filter((o) => (args.status === 'all' ? true : args.status === 'activated' ? o.activated : !o.activated))
      const activated = all.filter((o) => o.activated).length
      const header = `${offers.length} offer${offers.length === 1 ? '' : 's'} shown (${activated} activated, ${all.length - activated} not activated${q ? ` matching "${args.search}"` : ''})`
      const data = {
        shown: offers.length,
        activated,
        notActivated: all.length - activated,
        offers: offers.map((o) => ({
          id: o.id,
          title: nonEmpty(o.displaySettings?.title) ?? nonEmpty(o.displaySettings?.tileTitle) ?? null,
          value: offerValue(o),
          strategy: o.strategy,
          activated: o.activated,
          needsActivation: needsActivation(o),
          limitReached: o.limitPerCustomerReached === true,
          startAt: o.startAt ?? null,
          endAt: o.endAt ?? null,
        })),
      }
      return structured(offers.length ? [header, ...offers.map(formatOffer)] : [`No matching offers. ${header}`], data)
    })
  )

  server.registerTool(
    'pub_points_orders',
    {
      title: 'Pub Points: orders',
      description:
        'Orders paid through The Pass, newest first: date, venue, amount charged, points earned, status and order id. Filter by date range, status or venue. Use pub_points_order_details with an order id for the itemised receipt.',
      inputSchema: z.object({
        from: dateField.describe('Orders on or after this date, YYYY-MM-DD'),
        to: dateField.describe('Orders on or before this date, YYYY-MM-DD'),
        status: z.enum(['completed', 'reversed', 'all']).default('completed').describe('reversed = cancelled or refunded'),
        venue: z.string().optional().describe('Only orders at venues whose name contains this text'),
        limit: z.number().int().min(1).max(500).default(20),
      }),
      outputSchema: OrdersOutputSchema,
      annotations: READ_ONLY,
    },
    handle(async (args, signal) => {
      const q = args.venue?.toLowerCase()
      const { orders, complete } = await client.getOrders(
        {
          after: args.from ? dayStart(args.from) : undefined,
          before: args.to ? dayEnd(args.to) : undefined,
          status: args.status === 'all' ? undefined : args.status,
          max: q ? VENUE_FILTER_ORDER_CAP : args.limit,
        },
        signal
      )
      // The API cannot filter by venue name, so the filter scans a capped number of orders.
      const scanCapped = q !== undefined && !complete
      const capNote = scanCapped
        ? [`(Only the newest ${VENUE_FILTER_ORDER_CAP} orders were searched for "${args.venue}"; give from/to to search further back.)`]
        : []
      const { names, note } = await venueNames(
        orders.map((o) => o.venue?.id ?? ''),
        signal
      )
      const nameOf = (id: string | undefined) => (id ? names.get(id) : undefined)
      const rows = orders.filter((o) => !q || (nameOf(o.venue?.id) ?? '').toLowerCase().includes(q)).slice(0, args.limit)
      const data = {
        orders: rows.map((o) => ({
          id: o.id,
          createdAt: o.createdAt,
          status: o.status,
          venueId: o.venue?.id ?? null,
          venueName: nameOf(o.venue?.id) ?? null,
          chargeCents: o.chargeAmount,
          pointsEarned: o.earnedPointsAmount ?? 0,
        })),
        venueNamesUnavailable: note,
        venueSearchCapped: scanCapped,
      }
      const lines = rows.length ? rows.map((o) => formatOrderSummary(o, nameOf(o.venue?.id))) : ['No matching orders.']
      return structured([...(note ? [note] : []), ...lines, ...capNote], data)
    })
  )

  server.registerTool(
    'pub_points_order_details',
    {
      title: 'Pub Points: order receipt',
      description:
        'Itemised receipt for one order: items, discounts (offers and group discounts), surcharges, total, payment method and offers applied. Order ids come from pub_points_orders.',
      inputSchema: z.object({ orderId: idField }),
      annotations: READ_ONLY,
    },
    handle(async (args, signal) => {
      // The receipt has no venue; the order list does. List the orders around the receipt's own
      // time so an order of any age is found, not only one among the newest.
      const details = await client.getOrder(args.orderId, signal)
      const at = Date.parse(details.createdAt)
      const window = Number.isNaN(at)
        ? { max: VENUE_FILTER_ORDER_CAP }
        : {
            after: new Date(at - ORDER_LOOKUP_WINDOW_MS).toISOString(),
            before: new Date(at + ORDER_LOOKUP_WINDOW_MS).toISOString(),
            max: VENUE_FILTER_ORDER_CAP,
          }
      const listed = await client.getOrders(window, signal).then(
        (list) => ({ list, failure: null }),
        (err: unknown) => ({ list: null, failure: venueNamesNote(err) })
      )
      const venueId = listed.list?.orders.find((o) => o.id === args.orderId)?.venue?.id
      const lookup = venueId ? await venueNames([venueId], signal) : { names: new Map<string, string>(), note: null }
      const notFound =
        listed.list && !venueId
          ? `(venue name unavailable: the order is not in the order list${listed.list.complete ? '' : ` among the ${VENUE_FILTER_ORDER_CAP} orders searched`})`
          : null
      const note = listed.failure ?? lookup.note ?? notFound
      return text([...formatOrderDetails(details, venueId ? lookup.names.get(venueId) : undefined), ...(note ? ['', note] : [])])
    })
  )

  server.registerTool(
    'pub_points_group_discounts',
    {
      title: 'Pub Points: group discounts and their venues',
      description:
        'Each group (organisation) the member belongs to, its discount, and the venues where it applies, with open-now status. Answers "where can I use my work or club discount?". Join a new group with pub_points_join_organisation.',
      inputSchema: z.object({ search: z.string().optional().describe('Only groups whose name contains this text') }),
      annotations: READ_ONLY,
    },
    handle(async (args, signal) => {
      const q = args.search?.toLowerCase()
      const memberships = (await client.getCustomerOrganisations(signal)).filter((m) => !q || m.organisation.name.toLowerCase().includes(q))
      if (memberships.length === 0) {
        return text([q ? `No group matching "${args.search}".` : 'Not a member of any group. Join one with pub_points_join_organisation.'])
      }
      const details = await Promise.allSettled(memberships.map((m) => client.getCustomerOrganisation(m.id, signal)))
      const venueIds = details.flatMap((d) =>
        d.status === 'fulfilled' ? (d.value.organisation.discountVenues ?? []).map((v) => v.id) : []
      )
      const { venues, note: venueNote } = await lookupVenues(venueIds, signal)
      const lines = memberships.flatMap((m, i) => {
        const d = details[i]
        const org = d?.status === 'fulfilled' ? d.value.organisation : m.organisation
        const pct = org.discount && org.discount > 0 ? `${org.discount}% off` : 'no percentage discount'
        const header = `## ${org.name}: ${pct}`
        if (!d || d.status === 'rejected') return [header, `(venue list unavailable: ${d ? errorMessage(d.reason) : 'not loaded'})`, '']
        if (d.value.organisation.discountVenuesCount === 0) return [header, 'Applies at all The Pass venues.', '']
        const list = (d.value.organisation.discountVenues ?? []).map((v) => {
          const venue = venues.get(v.id)
          return venue ? `- ${venueLine(venue)}` : `- venue id ${v.id}`
        })
        return [header, ...list, '']
      })
      return text([...(venueNote ? [venueNote] : []), ...lines])
    })
  )

  server.registerTool(
    'pub_points_favourite_venues',
    {
      title: 'Pub Points: favourite venues',
      description:
        "The member's favourite venues with open-now status. Add or remove with pub_points_add_favourite_venue and pub_points_remove_favourite_venue.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    handle(async (_args, signal) => {
      const favourites = await client.getFavouriteVenues(signal)
      if (favourites.length === 0) return text(['No favourite venues yet.'])
      const { venues, note: venueNote } = await lookupVenues(
        favourites.map((f) => f.venue.id),
        signal
      )
      const lines = favourites.map((f) => {
        const v = venues.get(f.venue.id)
        return v ? `- ${venueLine(v)}` : `- venue id ${f.venue.id}`
      })
      return text([...(venueNote ? [venueNote] : []), ...lines])
    })
  )

  server.registerTool(
    'pub_points_profile',
    {
      title: 'Pub Points: profile',
      description:
        "The member's profile: name, email, mobile, date of birth, member-since date and preferred card (last four digits only).",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    handle(async (_args, signal) => text(formatProfile(await client.getProfile(signal))))
  )

  server.registerTool(
    'pub_points_communication_preferences',
    {
      title: 'Pub Points: communication preferences',
      description:
        'Which push, email and SMS messages the member has opted in to. Change them with pub_points_set_communication_preferences.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    handle(async (_args, signal) => {
      const on = new Set((await client.getCommunicationPreferences(signal)).map((p) => p.type))
      return text(COMMUNICATION_PREFERENCE_TYPES.map((t) => `- ${PREFERENCE_LABELS[t]}: ${on.has(t) ? 'on' : 'off'} (${t})`))
    })
  )
}
