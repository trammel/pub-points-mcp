// SPDX-License-Identifier: GPL-3.0-or-later
// Pure formatting helpers. Units follow the app: credit balances, reward credit amounts, offer
// dollar values and tier spend are all cents; percentage discounts are whole numbers.

import type {
  Activity,
  Amount,
  CommunicationPreferenceType,
  Credit,
  CustomerBalances,
  CustomerOrganisation,
  CustomerTier,
  Offer,
  OrderDetails,
  OrderLine,
  OrderSummary,
  PointsExchangeRate,
  Profile,
  Venue,
} from './api.js'
import { DECIMAL_PATTERN } from './api.js'
import { TIMEZONE } from './config.js'
import { localMonth } from './dates.js'
import { nonEmpty } from './text.js'

export function dollarsFromCents(cents: Amount | undefined | null): string {
  const n = cents ?? 0
  return `$${(n / 100).toFixed(2)}`
}

export function points(n: Amount | undefined | null): string {
  const v = Math.floor(n ?? 0)
  return `${v.toLocaleString('en-AU')} point${v === 1 ? '' : 's'}`
}

/** A date in the configured zone. `missing` is what an absent value means here ("unknown" unless the caller knows better). */
export function date(iso: string | null | undefined, missing = 'unknown'): string {
  if (!iso) return missing
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TIMEZONE })
}

export function daysUntil(iso: string | null | undefined, now = new Date()): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.ceil((t - now.getTime()) / 86_400_000)
}

export function formatBalances(b: CustomerBalances, now = new Date()): string[] {
  const lines = [`Points balance: ${points(b.pointsBalance)}`, `Credit balance: ${dollarsFromCents(b.creditBalance)}`]
  const days = daysUntil(b.pointsExpireAt, now)
  if (b.pointsExpireAt && days !== null && days >= 0) {
    lines.push(`Points expire: ${date(b.pointsExpireAt)} (${days} day${days === 1 ? '' : 's'})`)
  }
  return lines
}

export function formatTier(t: CustomerTier): string[] {
  const lines = [`Tier: ${t.tier.name}`, `Spend this tier year: ${dollarsFromCents(t.spendAmount)}`]
  if (t.nextTier) {
    const target = t.tier.spendAmountTo ?? NaN
    const remaining = Number.isFinite(target) ? Math.max(0, target - t.spendAmount) : null
    lines.push(
      remaining !== null ? `Next tier: ${t.nextTier.name} (spend ${dollarsFromCents(remaining)} more)` : `Next tier: ${t.nextTier.name}`
    )
  }
  if (t.anniversaryAt) lines.push(`Tier anniversary: ${date(t.anniversaryAt)}`)
  return lines
}

export function formatTierBenefits(benefits: { title: string; description?: string | null }[] | null | undefined): string[] {
  return (benefits ?? []).map((b) => `- ${b.title}${b.description ? `: ${stripHtml(b.description)}` : ''}`)
}

export function rewardLabel(r: PointsExchangeRate): string {
  const name = typeof r.name === 'string' && r.name ? r.name : `${dollarsFromCents(r.creditAmount)} credit`
  return `${name} for ${points(r.pointsAmount)}`
}

export function formatRewards(rates: PointsExchangeRate[], balance: number): string[] {
  const sorted = [...rates].sort((a, b) => a.pointsAmount - b.pointsAmount)
  return sorted.map((r) => {
    const need = r.pointsAmount - balance
    const status = need <= 0 ? 'can redeem now' : `${points(need)} short`
    return `- ${rewardLabel(r)} [${status}] (id ${r.id})`
  })
}

const CREDIT_TYPE_LABELS: Record<string, string> = {
  birthday_gift: 'Birthday gift',
  promo_code: 'Promo code',
  points: 'Points redemption',
  refund: 'Refund',
  offer: 'Offer',
  adjustment: 'Adjustment',
  sign_up_bonus: 'Sign-up bonus',
  gift_voucher: 'Gift voucher',
}

export function formatCredit(c: Credit): string {
  const type = nonEmpty(c.type)
  const label = (type === undefined ? undefined : CREDIT_TYPE_LABELS[type]) ?? type ?? 'Credit'
  const expiry = c.expiresAt ? `expires ${date(c.expiresAt)}` : 'never expires'
  return `- ${dollarsFromCents(c.availableBalance)} ${label}, ${expiry}`
}

/** Points earned per $1 from the API's earn rate (0.05 means 5), rounded so a rate like 0.07 never shows float noise. */
export function pointsPerDollar(rate: Amount | null | undefined): number {
  return Number(((rate ?? 0) * 100).toFixed(2))
}

/** Offer value wording, per offer strategy. */
export function offerValue(o: { strategy: string; value: Amount }): string {
  switch (o.strategy) {
    case 'discount':
    case 'discount_percentage':
      return `${o.value}% off`
    case 'discount_fixed':
      return `${dollarsFromCents(o.value)} off`
    case 'discount_price_override':
      return `price ${dollarsFromCents(o.value)}`
    case 'credit':
      return `${dollarsFromCents(o.value)} credit`
    case 'points':
      return points(o.value)
    case 'points_multiplier':
      return `${Number((o.value / 100).toFixed(2))}x points`
    default:
      return `${o.strategy} ${o.value}`
  }
}

/** True when the member must act to use the offer: in-app offers and instant rewards. */
export function needsActivation(o: Pick<Offer, 'activated' | 'activationStrategy' | 'type'>): boolean {
  if (o.type === 'instant_reward') return !o.activated
  return !o.activated && o.activationStrategy === 'in_app'
}

export function formatOffer(o: Offer): string {
  const title = nonEmpty(o.displaySettings?.title) ?? nonEmpty(o.displaySettings?.tileTitle) ?? '(untitled offer)'
  const flags = [
    o.activated ? 'activated' : needsActivation(o) ? 'not activated: activate with pub_points_activate_offer' : 'not activated',
    o.limitPerCustomerReached ? 'limit reached' : null,
    o.allMultiStepCriteriaCompleted ? 'criteria complete' : null,
  ].filter(Boolean)
  return `- ${title}: ${offerValue(o)}; ${date(o.startAt)} to ${date(o.endAt, 'no end date')} [${flags.join(', ')}] (id ${o.id})`
}

export function formatOrganisation(o: CustomerOrganisation): string {
  const { name, discount, discountVenuesCount } = o.organisation
  const pct = discount && discount > 0 ? `${discount}% group discount` : 'no group discount'
  const venues =
    discountVenuesCount === 0
      ? 'all venues'
      : discountVenuesCount
        ? `${discountVenuesCount} venue${discountVenuesCount === 1 ? '' : 's'}`
        : 'venues unspecified'
  return `- ${name}: ${pct} (${venues})`
}

export function formatVenue(v: Venue): string {
  const dist = v._rankingInfo?.geoDistance
  const where = v.location?.address
    ? `, ${stripHtml(v.location.address.replace(/<br\s*\/?>|[\r\n]+/gi, ', ')).replace(/\s*,\s*(,\s*)*/g, ', ')}`
    : ''
  const away = typeof dist === 'number' && dist > 0 ? ` (${(dist / 1000).toFixed(1)} km)` : ''
  return `${v.title ?? v.objectID}${where}${away} (venue id ${v.objectID})`
}

export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---- opening hours ----

const UTC_DAY_KEYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'] as const
const SLOT_MINUTES = 15

/** Display strings from the venue record, e.g. "Friday: 11:30 AM – 1:00 AM" (venue local time). */
export function formatOpeningHours(v: Venue): string[] {
  return (v.openingHours?.text ?? []).map((line) => line.replace(/\u2009|\u202f/g, ' '))
}

/**
 * True/false when hours are known, null otherwise. The "hours" slots are UTC: keys are the UTC
 * weekday and values the UTC start time of each open 15-minute slot.
 */
export function isOpenNow(v: Venue, now = new Date()): boolean | null {
  const hours = v.openingHours?.hours
  if (!hours) return null
  const day = UTC_DAY_KEYS[now.getUTCDay()]
  if (!day) return null
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  const slotStart = minutes - (minutes % SLOT_MINUTES)
  const slot = `${String(Math.floor(slotStart / 60)).padStart(2, '0')}${String(slotStart % 60).padStart(2, '0')}`
  return (hours[day] ?? []).includes(slot)
}

/** " [open now]" / " [closed now]", or nothing when the venue publishes no hours. */
export function openNowSuffix(v: Venue, now = new Date()): string {
  const open = isOpenNow(v, now)
  return open === null ? '' : open ? ' [open now]' : ' [closed now]'
}

/** A venue line with its open-now state. */
export function venueLine(v: Venue, now = new Date()): string {
  return `${formatVenue(v)}${openNowSuffix(v, now)}`
}

/** Result line after joining an organisation, from the join endpoint's answer. */
export function joinedText(org: { name?: string | null; discount?: number | null } | null | undefined): string {
  const name = org?.name ?? 'the group'
  return org?.discount ? `joined ${name} with a ${org.discount}% group discount` : `joined ${name}`
}

// ---- activity and spending ----

/** Labels for every activity type The Pass records. */
export const ACTIVITY_LABELS: Record<string, string> = {
  order: 'Order',
  credit_expiry: 'Credit expired',
  points_expiry: 'Points expired',
  points_redemption: 'Points redeemed for credit',
  points_redemption_to_gift_voucher: 'Points redeemed for gift voucher',
  gift_voucher_redemption: 'Gift voucher redeemed',
  promo_code_redemption: 'Promo code',
  external_purchase: 'External purchase',
  external_refund: 'External refund',
  gift_voucher_external_purchase: 'Gift voucher purchase',
  sevenrooms_reservation: 'Booking',
  customer_referral_code_referee_reward: 'Referral bonus (you joined)',
  customer_referral_code_referrer_reward: 'Referral bonus (friend joined)',
  customer_tier_change: 'Tier change',
  instant_reward_offer_redemption: 'Instant reward redeemed',
  customer_birthday_gift_redemption: 'Birthday gift claimed',
  offer_activation: 'Offer activated',
}

/** A number from untyped API data, accepted as the `amount` schema accepts it; anything else is undefined, never NaN. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  return typeof v === 'string' && DECIMAL_PATTERN.test(v) ? Number(v) : undefined
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined
}

export function formatActivity(a: Activity): string {
  const d = a.data ?? {}
  const label = ACTIVITY_LABELS[a.type] ?? a.type
  const parts: string[] = []
  const venue = str(d.venue)
  if (venue) parts.push(venue)
  const amount = num(d.amount)
  if (amount !== undefined) parts.push(dollarsFromCents(amount))
  const pts = num(d.points)
  const spent = a.type === 'points_redemption' || a.type === 'points_redemption_to_gift_voucher' || a.type === 'points_expiry'
  if (pts !== undefined) parts.push(spent ? `-${points(pts)}` : `+${points(pts)}`)
  if (a.type === 'customer_tier_change') {
    const tier = (d.tier as { name?: string } | undefined)?.name
    if (tier) parts.push(`to ${tier}`)
    const bonus = num(d.transitionPointsAmount)
    if (bonus !== undefined && bonus > 0) parts.push(`+${points(bonus)} bonus`)
  }
  const code = str(d.code)
  if (code) parts.push(`code ${code}`)
  const status = str(d.status)
  if (status && status !== 'completed') parts.push(status)
  if (d.hasOfferRedemptions === true) parts.push('offer applied')
  if (str(d.expiry)) parts.push(`credit expires ${date(str(d.expiry))}`)
  return `- ${date(a.createdAt)} ${label}${parts.length ? ': ' + parts.join(', ') : ''}`
}

export interface SpendingSummary {
  orders: number
  totalCents: number
  pointsEarned: number
  byVenue: { venue: string; orders: number; totalCents: number }[]
  byMonth: { month: string; orders: number; totalCents: number }[]
}

/** Totals completed orders (reversed/refunded orders are excluded), grouped by venue name and local month. */
export function summariseSpending(orders: OrderSummary[], venueNames: ReadonlyMap<string, string>): SpendingSummary {
  const venues = new Map<string, { orders: number; totalCents: number }>()
  const months = new Map<string, { orders: number; totalCents: number }>()
  let count = 0
  let totalCents = 0
  let pointsEarned = 0
  for (const o of orders) {
    if (o.status !== 'completed') continue
    const cents = o.chargeAmount
    count++
    totalCents += cents
    pointsEarned += o.earnedPointsAmount ?? 0
    const venueId = o.venue?.id
    const named = venueId ? nonEmpty(venueNames.get(venueId)) : undefined
    const venue = named ?? (venueId ? `venue id ${venueId}` : 'Unknown venue')
    const v = venues.get(venue) ?? { orders: 0, totalCents: 0 }
    venues.set(venue, { orders: v.orders + 1, totalCents: v.totalCents + cents })
    const month = localMonth(o.createdAt)
    const m = months.get(month) ?? { orders: 0, totalCents: 0 }
    months.set(month, { orders: m.orders + 1, totalCents: m.totalCents + cents })
  }
  return {
    orders: count,
    totalCents,
    pointsEarned,
    byVenue: [...venues].map(([venue, v]) => ({ venue, ...v })).sort((a, b) => b.totalCents - a.totalCents),
    byMonth: [...months].map(([month, m]) => ({ month, ...m })).sort((a, b) => a.month.localeCompare(b.month)),
  }
}

// ---- profile and settings ----

/** Card number reduced to its last four digits; the API already masks the middle. */
export function maskCard(pan: string | null | undefined): string {
  const digits = (pan ?? '').replace(/\D/g, '')
  return digits.length >= 4 ? `ending ${digits.slice(-4)}` : 'on file'
}

export function formatProfile(p: Profile): string[] {
  const lines = [
    `Name: ${[p.firstName, p.lastName].filter(Boolean).join(' ') || '(not set)'}`,
    `Email: ${p.email ?? '(not set)'}`,
    `Mobile: ${p.phoneNumber ?? '(not set)'}`,
    `Date of birth: ${p.dateOfBirth ? date(p.dateOfBirth) : '(not set)'}`,
    `Member since: ${date(p.createdAt)}`,
  ]
  const card = p.preferredPaymentMethod
  if (card) {
    const expiry = card.expiryMonth && card.expiryYear ? `, expires ${String(card.expiryMonth).padStart(2, '0')}/${card.expiryYear}` : ''
    lines.push(`Preferred card: ${card.cardType ?? 'card'} ${maskCard(card.pan)}${expiry}`)
  }
  return lines
}

/** ISO-8601 period such as "P6M" -> "6 months". */
export function isoPeriod(p: string | null | undefined): string {
  const m = p?.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/)
  if (!m) return p ?? 'unknown'
  const units = ['year', 'month', 'week', 'day']
  const out = m
    .slice(1)
    .map((n, i) => (n ? `${n} ${units[i]}${n === '1' ? '' : 's'}` : null))
    .filter(Boolean)
  return out.join(' ') || 'unknown'
}

export const PREFERENCE_LABELS: Record<CommunicationPreferenceType, string> = {
  push_account_essentials: 'Push: account essentials',
  push_offers: 'Push: offers',
  push_news: 'Push: news',
  email_account_essentials: 'Email: account essentials',
  email_offers: 'Email: offers',
  email_news: 'Email: news',
  sms_offers: 'SMS: offers',
}

// ---- orders ----

const DISCOUNT_SKU_LABELS: Record<string, string> = {
  LOYALTYDISCOUNT: 'offer',
  ORGDISCOUNT: 'group discount',
}

export function formatOrderSummary(o: OrderSummary, venueName: string | undefined): string {
  const pts = o.earnedPointsAmount ?? 0
  const parts = [
    venueName ?? (o.venue?.id ? `venue id ${o.venue.id}` : 'unknown venue'),
    dollarsFromCents(o.chargeAmount),
    ...(pts > 0 ? [`+${points(pts)}`] : []),
    ...(o.status !== 'completed' ? [o.status] : []),
  ]
  return `- ${date(o.createdAt)} ${parts.join(', ')} (order id ${o.id})`
}

export function formatOrderDetails(d: OrderDetails, venueName: string | undefined): string[] {
  const line = (l: OrderLine) =>
    `- ${l.quantity && l.quantity > 1 ? `${l.quantity} x ` : ''}${l.name}: ${dollarsFromCents(l.amountWithTax)}`
  const lines = [
    `Order${venueName ? ` at ${venueName}` : ''}, ${date(d.createdAt)} (order id ${d.id})`,
    '',
    '## Items',
    ...(d.items ?? []).map(line),
  ]
  if (d.discounts?.length) {
    lines.push(
      '',
      '## Discounts',
      ...d.discounts.map((x) => {
        const kind = x.sku ? DISCOUNT_SKU_LABELS[x.sku] : undefined
        return `- ${x.name}${kind ? ` (${kind})` : ''}: -${dollarsFromCents(x.amountWithTax)}`
      })
    )
  }
  if (d.surcharges?.length) lines.push('', '## Surcharges', ...d.surcharges.map(line))
  lines.push(
    '',
    `Items: ${dollarsFromCents(d.itemsAmountWithTax ?? (d.items ?? []).reduce((sum, l) => sum + l.amountWithTax, 0))}`,
    ...((d.discountsAmountWithTax ?? 0) > 0 ? [`Discounts: -${dollarsFromCents(d.discountsAmountWithTax)}`] : []),
    ...((d.surchargesAmount ?? 0) > 0 ? [`Surcharges: ${dollarsFromCents(d.surchargesAmount)}`] : []),
    `Total: ${dollarsFromCents(d.totalAmountWithTax ?? d.chargeAmount)}${d.totalTax ? ` (includes ${dollarsFromCents(d.totalTax)} GST)` : ''}`,
    ...(d.payments ?? []).map((p) => `Paid: ${dollarsFromCents(p.amount)} by ${p.method}`)
  )
  if (d.offerRedemptions?.length) {
    lines.push(
      `Offers applied: ${d.offerRedemptions.map((r) => (r.reward?.strategy ? offerValue({ strategy: r.reward.strategy, value: r.reward.value ?? 0 }) : 'offer')).join(', ')}`
    )
  }
  return lines
}
