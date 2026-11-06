// SPDX-License-Identifier: GPL-3.0-or-later
// Tools that change the account. Each checks the request against current account state first,
// so a refusal costs nothing, then confirms the exact action with the user (action-flow.ts)
// before calling a write endpoint.

import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { COMMUNICATION_PREFERENCE_TYPES, KNOWN_CODE_TYPES, type KnownCodeType, type PubPointsApi } from './api.js'
import {
  ActionOutputSchema,
  PartialActionError,
  confirmAndRun,
  confirmationTokenField,
  definitelyNotApplied,
  failureReason,
  unchanged,
  type ActionCheck,
  type ActionDeps,
  type ActionPlan,
} from './action-flow.js'
import { canonicalJson, type ConfirmationStore } from './confirmation.js'
import { PREFERENCE_LABELS, dollarsFromCents, formatBalances, joinedText, offerValue, points, rewardLabel } from './format.js'
import { READ_ONLY, SETTING, WRITE, codeField, errorText, handle, idField, text, venueNamesNote } from './tool-helpers.js'

const CODE_TYPE_LABELS: Record<KnownCodeType, string> = {
  gift_voucher:
    'AVC gift voucher (converts to The Pass credit). The API also reports unrecognised codes this way; validity is only checked on redemption',
  promo_code: 'Promo code (credit, points or a discount)',
  referral_code: 'Group code (joins an organisation for a group discount)',
  offer_code: 'Offer code (activates an offer)',
  customer_referral_code: "Friend's referral code (bonus points; only before your first order)",
}

function isKnownCodeType(type: string): type is KnownCodeType {
  return KNOWN_CODE_TYPES.some((t) => t === type)
}

function codeLabel(type: string): string {
  return isKnownCodeType(type) ? CODE_TYPE_LABELS[type] : `Unknown code type "${type}"`
}

export interface ActionToolOptions {
  /** Register only pub_points_check_code; every tool that changes the account is left out. */
  readOnly: boolean
  confirmations: ConfirmationStore
}

function balancesAfter(client: PubPointsApi) {
  return async (signal: AbortSignal) => formatBalances(await client.getBalances(signal))
}

const ASK_FIRST = 'Changes the account: the server confirms the exact action with the user before doing it.'

export function registerActionTools(server: McpServer, client: PubPointsApi, options: ActionToolOptions): void {
  server.registerTool(
    'pub_points_check_code',
    {
      title: 'Pub Points: check a code',
      description:
        'Says what kind of code something is (gift voucher, promo, group, offer or friend referral) without redeeming it, and which tool redeems it: pub_points_join_organisation for group codes, pub_points_redeem_code for the rest.',
      inputSchema: z.object({ code: codeField }),
      annotations: READ_ONLY,
    },
    handle(async (args, signal) => {
      const info = await client.checkCode(args.code, signal)
      const tool = info.type === 'referral_code' ? 'pub_points_join_organisation' : 'pub_points_redeem_code'
      const how = options.readOnly ? 'Redeeming is disabled: this server runs read-only.' : `Redeem with ${tool}.`
      return text([`${args.code}: ${codeLabel(info.type)}. ${how}`])
    })
  )

  if (options.readOnly) return

  const deps: ActionDeps = { server, confirmations: options.confirmations }

  server.registerTool(
    'pub_points_activate_offer',
    {
      title: 'Pub Points: activate offer',
      description: `Activates an in-app offer, or redeems an instant-reward offer, exactly as the app's offer button does. Offers that apply automatically need no activation. ${ASK_FIRST}`,
      inputSchema: z.object({ offerId: idField, confirmationToken: confirmationTokenField }),
      outputSchema: ActionOutputSchema,
      annotations: WRITE,
    },
    handle((args, _signal, ctx) =>
      confirmAndRun(
        'pub_points_activate_offer',
        args,
        async (signal): Promise<ActionCheck> => {
          const offer = await client.getOfferDetails(args.offerId, signal)
          const title = offer.displaySettings?.title ?? offer.name ?? offer.id
          if (offer.activated && offer.type !== 'instant_reward') return unchanged(`"${title}" is already activated.`)
          if (offer.limitPerCustomerReached) return errorText(`"${title}": you have reached the limit for this offer.`)
          if (offer.endAt && Date.parse(offer.endAt) < Date.now()) return errorText(`"${title}" has ended.`)
          if (offer.type !== 'instant_reward' && offer.activationStrategy !== 'in_app') {
            const how = offer.activationStrategy === 'auto' ? 'automatically on eligible orders' : `by "${offer.activationStrategy}"`
            return errorText(`"${title}" activates ${how}; there is nothing to activate.`)
          }
          const plan: ActionPlan = {
            action: `${offer.type === 'instant_reward' ? 'redeeming' : 'activating'} "${title}" (${offerValue(offer)})`,
            fingerprint: canonicalJson({ id: offer.id, value: offer.value, strategy: offer.strategy, type: offer.type ?? null }),
            checkWith: 'pub_points_offers',
            perform: async (s) => ({ summary: `"${title}" ${await client.activateOffer(offer, s)}`, followUp: null }),
          }
          return plan
        },
        ctx,
        deps
      )
    )
  )

  server.registerTool(
    'pub_points_redeem_points',
    {
      title: 'Pub Points: redeem points for credit',
      description: `Exchanges points for venue credit using a reward id from pub_points_rewards. Spends points and cannot be undone. ${ASK_FIRST}`,
      inputSchema: z.object({ rewardId: idField, confirmationToken: confirmationTokenField }),
      outputSchema: ActionOutputSchema,
      annotations: WRITE,
    },
    handle((args, _signal, ctx) =>
      confirmAndRun(
        'pub_points_redeem_points',
        args,
        async (signal): Promise<ActionCheck> => {
          const [balances, rates] = await Promise.all([client.getBalances(signal), client.getPointsExchangeRates(signal)])
          const reward = rates.items.find((r) => r.id === args.rewardId)
          if (!reward) return errorText(`No reward with id ${args.rewardId}. List them with pub_points_rewards.`)
          const balance = balances.pointsBalance
          const cost = reward.pointsAmount
          if (!Number.isFinite(balance) || !Number.isFinite(cost)) {
            return errorText(
              `The points balance or the cost of ${args.rewardId} is not a number; nothing was redeemed. Run pub_points_doctor.`
            )
          }
          if (cost > balance) return errorText(`${rewardLabel(reward)} needs ${points(cost - balance)} more (balance ${points(balance)}).`)
          const plan: ActionPlan = {
            action: `redeeming ${rewardLabel(reward)}`,
            fingerprint: canonicalJson({ id: reward.id, pointsAmount: reward.pointsAmount, creditAmount: reward.creditAmount }),
            checkWith: 'pub_points_summary',
            perform: async (s) => {
              await client.redeemPoints(reward.id, s)
              return { summary: `redeemed ${rewardLabel(reward)}`, followUp: balancesAfter(client) }
            },
          }
          return plan
        },
        ctx,
        deps
      )
    )
  )

  server.registerTool(
    'pub_points_redeem_code',
    {
      title: 'Pub Points: redeem a code',
      description: `Redeems any code the app's "Enter a code" screen accepts: AVC gift vouchers, promo codes, offer codes and a friend's referral code. For a group discount code (workplace, club, association), use pub_points_join_organisation instead. Cannot be undone. ${ASK_FIRST}`,
      inputSchema: z.object({ code: codeField, confirmationToken: confirmationTokenField }),
      outputSchema: ActionOutputSchema,
      annotations: WRITE,
    },
    handle((args, _signal, ctx) =>
      confirmAndRun(
        'pub_points_redeem_code',
        args,
        async (signal): Promise<ActionCheck> => {
          const code = args.code
          const { type } = await client.checkCode(code, signal)
          if (!isKnownCodeType(type)) return errorText(`${code}: ${codeLabel(type)}; not redeemed.`)
          const plan: ActionPlan = {
            action: `redeeming ${code}, a ${codeLabel(type)}`,
            fingerprint: canonicalJson({ code, type }),
            checkWith: 'pub_points_activity',
            perform: (s) => redeemCode(client, code, type, s),
          }
          return plan
        },
        ctx,
        deps
      )
    )
  )

  server.registerTool(
    'pub_points_join_organisation',
    {
      title: 'Pub Points: join an organisation',
      description: `The way to add a group discount: joins an organisation (workplace, sports club, association) using the group code it gave the member, unlocking its group discount at its venues. Checks the code first and refuses anything that is not a group code, so it cannot spend a voucher or promo code by mistake. Existing memberships and their venues are listed by pub_points_group_discounts. ${ASK_FIRST}`,
      inputSchema: z.object({ code: codeField, confirmationToken: confirmationTokenField }),
      outputSchema: ActionOutputSchema,
      annotations: WRITE,
    },
    handle((args, _signal, ctx) =>
      confirmAndRun(
        'pub_points_join_organisation',
        args,
        async (signal): Promise<ActionCheck> => {
          const code = args.code
          const { type } = await client.checkCode(code, signal)
          if (type !== 'referral_code') {
            return errorText(`${code} is not a group code; it is a ${codeLabel(type)}. Use pub_points_redeem_code for it.`)
          }
          const plan: ActionPlan = {
            action: `joining the organisation for code ${code}`,
            fingerprint: canonicalJson({ code, type }),
            checkWith: 'pub_points_group_discounts',
            perform: async (s) => ({ summary: joinedText((await client.joinOrganisation(code, s))?.organisation), followUp: null }),
          }
          return plan
        },
        ctx,
        deps
      )
    )
  )

  server.registerTool(
    'pub_points_redeem_birthday_gift',
    {
      title: 'Pub Points: claim birthday gift',
      description: `Claims the birthday credit when one is available. ${ASK_FIRST}`,
      inputSchema: z.object({ confirmationToken: confirmationTokenField }),
      outputSchema: ActionOutputSchema,
      annotations: WRITE,
    },
    handle((args, _signal, ctx) =>
      confirmAndRun(
        'pub_points_redeem_birthday_gift',
        args,
        async (signal): Promise<ActionCheck> => {
          const gift = await client.getBirthdayGift(signal)
          if (!gift?.value) return errorText('No birthday gift is available right now.')
          if (gift.cardTransactionRequirementMet === false) {
            return errorText('The birthday gift is locked: it needs a card transaction through The Pass first.')
          }
          const value = dollarsFromCents(gift.value)
          const plan: ActionPlan = {
            action: `claiming the ${value} birthday gift`,
            fingerprint: canonicalJson({ value: gift.value }),
            checkWith: 'pub_points_credits',
            perform: async (s) => {
              await client.redeemBirthdayGift(s)
              return { summary: `${value} birthday credit claimed`, followUp: balancesAfter(client) }
            },
          }
          return plan
        },
        ctx,
        deps
      )
    )
  )

  server.registerTool(
    'pub_points_add_favourite_venue',
    {
      title: 'Pub Points: add favourite venue',
      description: `Adds a venue to favourites. Venue ids come from pub_points_find_venues. ${ASK_FIRST}`,
      inputSchema: z.object({ venueId: idField, confirmationToken: confirmationTokenField }),
      outputSchema: ActionOutputSchema,
      annotations: SETTING,
    },
    handle((args, _signal, ctx) =>
      confirmAndRun(
        'pub_points_add_favourite_venue',
        args,
        async (signal): Promise<ActionCheck> => {
          const [venue] = await client.getVenuesByIds([args.venueId], signal)
          if (!venue) return errorText(`No venue with id ${args.venueId}. Find ids with pub_points_find_venues.`)
          const name = venue.title ?? args.venueId
          if ((await client.getFavouriteVenues(signal)).some((f) => f.venue.id === args.venueId))
            return unchanged(`${name} is already a favourite.`)
          const plan: ActionPlan = {
            action: `adding ${name} to favourites`,
            fingerprint: canonicalJson({ venueId: args.venueId }),
            checkWith: 'pub_points_favourite_venues',
            perform: async (s) => {
              await client.addFavouriteVenue(args.venueId, s)
              return { summary: `${name} added to favourites`, followUp: null }
            },
          }
          return plan
        },
        ctx,
        deps
      )
    )
  )

  server.registerTool(
    'pub_points_remove_favourite_venue',
    {
      title: 'Pub Points: remove favourite venue',
      description: `Removes a venue from favourites, by venue id (as shown by pub_points_favourite_venues). ${ASK_FIRST}`,
      inputSchema: z.object({ venueId: idField, confirmationToken: confirmationTokenField }),
      outputSchema: ActionOutputSchema,
      annotations: SETTING,
    },
    handle((args, _signal, ctx) =>
      confirmAndRun(
        'pub_points_remove_favourite_venue',
        args,
        async (signal): Promise<ActionCheck> => {
          const record = (await client.getFavouriteVenues(signal)).find((f) => f.venue.id === args.venueId)
          if (!record) return unchanged('That venue is not in favourites; nothing changed.')
          const lookup = await client.getVenuesByIds([args.venueId], signal).then(
            (venues) => ({ name: venues[0]?.title ?? `venue id ${args.venueId}`, note: '' }),
            (err: unknown) => ({ name: `venue id ${args.venueId}`, note: ` ${venueNamesNote(err)}` })
          )
          const plan: ActionPlan = {
            action: `removing ${lookup.name} from favourites${lookup.note}`,
            fingerprint: canonicalJson({ venueId: args.venueId, favouriteId: record.id }),
            checkWith: 'pub_points_favourite_venues',
            perform: async (s) => {
              await client.removeFavouriteVenue(record.id, s)
              return { summary: `${lookup.name} removed from favourites`, followUp: null }
            },
          }
          return plan
        },
        ctx,
        deps
      )
    )
  )

  server.registerTool(
    'pub_points_set_communication_preferences',
    {
      title: 'Pub Points: change communication preferences',
      description: `Turns push, email or SMS message types on or off. ${ASK_FIRST}`,
      inputSchema: z.object({
        turnOn: z.array(z.enum(COMMUNICATION_PREFERENCE_TYPES)).default([]),
        turnOff: z.array(z.enum(COMMUNICATION_PREFERENCE_TYPES)).default([]),
        confirmationToken: confirmationTokenField,
      }),
      outputSchema: ActionOutputSchema,
      annotations: SETTING,
    },
    handle((args, _signal, ctx) =>
      confirmAndRun(
        'pub_points_set_communication_preferences',
        args,
        async (signal): Promise<ActionCheck> => {
          const overlap = args.turnOn.filter((t) => args.turnOff.includes(t))
          if (overlap.length) return errorText(`Both on and off requested for: ${overlap.join(', ')}`)
          if (!args.turnOn.length && !args.turnOff.length) return errorText('Nothing to change.')
          const current = await client.getCommunicationPreferences(signal)
          const byType = new Map(current.map((p) => [p.type, p.id]))
          const toAdd = args.turnOn.filter((t) => !byType.has(t))
          const toRemove = args.turnOff.flatMap((type) => {
            const id = byType.get(type)
            return id === undefined ? [] : [{ type, id }]
          })
          if (!toAdd.length && !toRemove.length) return unchanged('Already set that way; nothing changed.')
          const changes = [
            ...toAdd.map((type) => ({
              label: `${PREFERENCE_LABELS[type]} on`,
              run: (s: AbortSignal) => client.addCommunicationPreference(type, s),
            })),
            ...toRemove.map(({ type, id }) => ({
              label: `${PREFERENCE_LABELS[type]} off`,
              run: (s: AbortSignal) => client.removeCommunicationPreference(id, s),
            })),
          ]
          const summary = changes.map((c) => c.label).join('; ')
          const plan: ActionPlan = {
            action: `changing preferences: ${summary}`,
            fingerprint: canonicalJson({ add: [...toAdd].sort(), remove: toRemove.map((r) => `${r.type}:${r.id}`).sort() }),
            checkWith: 'pub_points_communication_preferences',
            perform: async (s) => {
              const [only] = changes
              if (changes.length === 1 && only) {
                // One write: its failure takes the same path as every other action tool's.
                await only.run(s)
                return { summary, followUp: null }
              }
              const results = await Promise.all(
                changes.map((c) =>
                  c.run(s).then(
                    (): ChangeResult => ({ label: c.label, ok: true }),
                    (error: unknown): ChangeResult => ({ label: c.label, ok: false, error })
                  )
                )
              )
              if (results.every((r) => r.ok)) return { summary, followUp: null }
              throw new PartialActionError(['Not every change went through:', ...results.map(changeLine)].join('\n'))
            },
          }
          return plan
        },
        ctx,
        deps
      )
    )
  )
}

type ChangeResult = { label: string; ok: true } | { label: string; ok: false; error: unknown }

function changeLine(result: ChangeResult): string {
  if (result.ok) return `- ${result.label}: done`
  if (definitelyNotApplied(result.error)) return `- ${result.label}: not done (${failureReason(result.error)})`
  return `- ${result.label}: may have been applied (the request failed with ${failureReason(result.error)})`
}

async function redeemCode(client: PubPointsApi, code: string, type: KnownCodeType, signal: AbortSignal) {
  switch (type) {
    case 'gift_voucher': {
      const r = await client.redeemGiftVoucher(code, signal)
      return { summary: `gift voucher converted to ${dollarsFromCents(r?.credit?.availableBalance)} of credit`, followUp: null }
    }
    case 'promo_code': {
      const r = await client.redeemPromoCode(code, signal)
      return { summary: r?.discount?.value ? `${r.discount.value}% discount added` : 'promo code applied', followUp: balancesAfter(client) }
    }
    case 'referral_code':
      return { summary: joinedText((await client.joinOrganisation(code, signal))?.organisation), followUp: null }
    case 'offer_code': {
      const r = await client.activateOfferCode(code, signal)
      return {
        summary: `activated "${r?.offer?.displaySettings?.title ?? 'the offer'}"; it applies to your next eligible order`,
        followUp: null,
      }
    }
    case 'customer_referral_code':
      await client.redeemFriendReferralCode(code, signal)
      return { summary: 'referral bonus added', followUp: balancesAfter(client) }
  }
}
