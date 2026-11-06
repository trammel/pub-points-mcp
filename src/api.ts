// SPDX-License-Identifier: GPL-3.0-or-later
// Client for the EonX-hosted API behind The Pass app, plus Algolia venue search. It holds both
// read and write calls. The write calls (activate, redeem, join, add/remove favourites and
// preferences) are reached only through the action tools, which confirm with the user first.
// Every response is parsed with a schema, so a changed API fails loudly instead of misleading.

import * as z from 'zod/v4'
import { ALGOLIA_APP_ID, API_BASE_URL, USER_AGENT, requestSignal } from './config.js'
import { TokenProvider } from './auth.js'
import type { IdTokenSource } from './auth.js'
import { utcOffset } from './dates.js'

export class ApiError extends Error {
  // The name is set in the constructor, not as a class field: V8 reports a field initializer as its own function and
  // counts it inconsistently between runs, which makes the coverage floor flaky. (Same in every error class here.)
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** The request succeeded at HTTP level but the body is not what the tools expect. */
export class ResponseShapeError extends ApiError {
  constructor(message: string, status: number) {
    super(message, status)
    this.name = 'ResponseShapeError'
  }
}

/**
 * Amounts arrive as decimal strings ("1050", "1500.00") from most endpoints, sometimes as
 * numbers; both become numbers here. Anything else ("1,500", "") fails validation, so a
 * comparison such as cost > balance can never run on NaN.
 */
export const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/
const amount = z.union([z.number(), z.string().regex(DECIMAL_PATTERN, 'Expected a decimal number')]).transform((value) => Number(value))

/** An amount after `amount` has parsed it: always a finite number, in cents for money. */
export type Amount = number

const PaginationSchema = z.looseObject({ hasNextPage: z.boolean().nullish(), totalItems: z.number().nullish() })

function paginated<T extends z.ZodType>(item: T) {
  return z.looseObject({ items: z.array(item), pagination: PaginationSchema.nullish() })
}

const CustomerBalancesSchema = z.looseObject({
  pointsBalance: amount,
  creditBalance: amount,
  pointsExpireAt: z.string().nullish(),
})
export type CustomerBalances = z.infer<typeof CustomerBalancesSchema>

const BenefitSchema = z.looseObject({ title: z.string(), description: z.string().nullish() })

const CustomerTierSchema = z.looseObject({
  createdAt: z.string().nullish(),
  anniversaryAt: z.string().nullish(),
  spendAmount: amount,
  tier: z.looseObject({
    name: z.string(),
    level: z.number().nullish(),
    type: z.string().nullish(),
    spendAmountFrom: amount.nullish(),
    spendAmountTo: amount.nullish(),
    benefits: z.array(BenefitSchema).nullish(),
  }),
  nextTier: z.looseObject({ level: z.number().nullish(), name: z.string() }).nullish(),
})
export type CustomerTier = z.infer<typeof CustomerTierSchema>

const TierSummarySchema = z.looseObject({
  name: z.string(),
  level: z.number().nullish(),
  spendAmountFrom: amount.nullish(),
  spendAmountTo: amount.nullish(),
  benefits: z.array(BenefitSchema).nullish(),
})

const PointsExchangeRateSchema = z.looseObject({ id: z.string(), pointsAmount: amount, creditAmount: amount })
export type PointsExchangeRate = z.infer<typeof PointsExchangeRateSchema>

const CreditSchema = z.looseObject({
  id: z.string(),
  type: z.string().nullish(),
  status: z.string().nullish(),
  amount: amount.nullish(),
  availableBalance: amount.nullish(),
  expiresAt: z.string().nullish(),
  createdAt: z.string().nullish(),
})
export type Credit = z.infer<typeof CreditSchema>

const DisplaySettingsSchema = z.looseObject({
  title: z.string().nullish(),
  tileTitle: z.string().nullish(),
  description: z.string().nullish(),
  termsAndConditions: z.string().nullish(),
})

const OfferSchema = z.looseObject({
  id: z.string(),
  activated: z.boolean(),
  strategy: z.string(),
  activationStrategy: z.string().nullish(),
  type: z.string().nullish(),
  value: amount,
  startAt: z.string().nullish(),
  endAt: z.string().nullish(),
  limitPerCustomerReached: z.boolean().nullish(),
  allMultiStepCriteriaCompleted: z.boolean().nullish(),
  displaySettings: DisplaySettingsSchema.nullish(),
})
export type Offer = z.infer<typeof OfferSchema>

const OfferDetailsSchema = OfferSchema.extend({
  name: z.string().nullish(),
  status: z.string().nullish(),
  activationCode: z.string().nullish(),
  rewardExpiresAt: z.string().nullish(),
})
export type OfferDetails = z.infer<typeof OfferDetailsSchema>

const IdRefSchema = z.looseObject({ id: z.string() })

const OffersAndVenuesSchema = z.looseObject({
  offers: z.array(OfferSchema).nullish(),
  venues: z.array(IdRefSchema).nullish(),
})

const BirthdayGiftSchema = z.looseObject({
  value: z.number(),
  subtitle: z.string().nullish(),
  description: z.string().nullish(),
  startAt: z.string().nullish(),
  endAt: z.string().nullish(),
  cardTransactionRequirementMet: z.boolean().nullish(),
})
export type BirthdayGift = z.infer<typeof BirthdayGiftSchema>

const VenueSchema = z.looseObject({
  objectID: z.string(),
  title: z.string().nullish(),
  region: z.string().nullish(),
  excerpt: z.string().nullish(),
  location: z.looseObject({ address: z.string().nullish(), lat: z.number().nullish(), lng: z.number().nullish() }).nullish(),
  /** text: display strings in venue local time. hours: open 15-minute slots keyed by UTC weekday, UTC "HHMM". */
  openingHours: z
    .looseObject({
      text: z.array(z.string()).nullish(),
      utcOffset: z.union([z.string(), z.number()]).nullish(),
      hours: z.record(z.string(), z.array(z.string())).nullish(),
    })
    .nullish(),
  links: z.record(z.string(), z.string().nullish()).nullish(),
  venueStyles: z.array(z.looseObject({ label: z.string(), value: z.string().nullish() })).nullish(),
  _rankingInfo: z.looseObject({ geoDistance: z.number().nullish() }).nullish(),
})
export type Venue = z.infer<typeof VenueSchema>

const AlgoliaKeySchema = z.looseObject({ secret: z.string(), venueIndexName: z.string(), expiresAt: z.string().nullish() })
type AlgoliaKey = z.infer<typeof AlgoliaKeySchema>

const OrganisationSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  discount: z.number().nullish(),
  discountVenuesCount: z.number().nullish(),
  hidden: z.boolean().nullish(),
})

const CustomerOrganisationSchema = z.looseObject({ id: z.string(), organisation: OrganisationSchema })
export type CustomerOrganisation = z.infer<typeof CustomerOrganisationSchema>

const CustomerOrganisationDetailsSchema = z.looseObject({
  id: z.string(),
  organisation: OrganisationSchema.extend({ type: z.string().nullish(), discountVenues: z.array(IdRefSchema).nullish() }),
})
export type CustomerOrganisationDetails = z.infer<typeof CustomerOrganisationDetailsSchema>

export interface Location {
  latitude: number
  longitude: number
}

const ProfileSchema = z.looseObject({
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  email: z.string().nullish(),
  phoneNumber: z.string().nullish(),
  dateOfBirth: z.string().nullish(),
  status: z.string().nullish(),
  createdAt: z.string().nullish(),
  preferredPaymentMethod: z
    .looseObject({
      cardType: z.string().nullish(),
      pan: z.string().nullish(),
      expiryMonth: z.number().nullish(),
      expiryYear: z.number().nullish(),
    })
    .nullish(),
})
export type Profile = z.infer<typeof ProfileSchema>

const PublicSettingsSchema = z.looseObject({
  signUpBonusAmount: amount.nullish(),
  externalPurchasesPointsEarnRate: amount.nullish(),
  refereeRewardPointsAmount: amount.nullish(),
  referrerRewardPointsAmount: amount.nullish(),
  referralCodeRedemptionLimit: z.number().nullish(),
  referralProgramEnabled: z.boolean().nullish(),
  pointsCreditExpiryPeriod: z.string().nullish(),
  giftVoucherCreditExpiryPeriod: z.string().nullish(),
  refundCreditExpiryPeriod: z.string().nullish(),
  adjustmentCreditExpiryPeriod: z.string().nullish(),
})
export type PublicSettings = z.infer<typeof PublicSettingsSchema>

const PromoTileSchema = z.looseObject({
  id: z.string(),
  title: z.string().nullish(),
  subtitle: z.string().nullish(),
  link: z.string().nullish(),
})

const ActivitySchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  createdAt: z.string(),
  data: z.record(z.string(), z.unknown()).nullish(),
})
export type Activity = z.infer<typeof ActivitySchema>

const OrderSummarySchema = z.looseObject({
  id: z.string(),
  referenceId: z.string().nullish(),
  status: z.string(),
  chargeAmount: amount,
  earnedPointsAmount: amount.nullish(),
  venue: IdRefSchema.nullish(),
  createdAt: z.string(),
})
export type OrderSummary = z.infer<typeof OrderSummarySchema>

const OrderLineSchema = z.looseObject({
  name: z.string(),
  amountWithTax: amount,
  quantity: z.number().nullish(),
  sku: z.string().nullish(),
  pluCategory: z.string().nullish(),
})
export type OrderLine = z.infer<typeof OrderLineSchema>

const OrderDetailsSchema = z.looseObject({
  id: z.string(),
  referenceId: z.string().nullish(),
  createdAt: z.string(),
  items: z.array(OrderLineSchema).nullish(),
  discounts: z.array(OrderLineSchema).nullish(),
  surcharges: z.array(OrderLineSchema).nullish(),
  payments: z.array(z.looseObject({ amount, method: z.string() })).nullish(),
  offerRedemptions: z
    .array(
      z.looseObject({
        offer: z.looseObject({ id: z.string().nullish(), type: z.string().nullish() }).nullish(),
        reward: z.looseObject({ strategy: z.string().nullish(), value: amount.nullish() }).nullish(),
      })
    )
    .nullish(),
  /** Excludes GST. */
  subtotal: amount.nullish(),
  itemsAmountWithTax: amount.nullish(),
  discountsAmountWithTax: amount.nullish(),
  surchargesAmount: amount.nullish(),
  totalAmountWithTax: amount.nullish(),
  chargeAmount: amount.nullish(),
  totalTax: amount.nullish(),
})
export type OrderDetails = z.infer<typeof OrderDetailsSchema>

const FavouriteVenueSchema = z.looseObject({ id: z.string(), venue: IdRefSchema })
export type FavouriteVenue = z.infer<typeof FavouriteVenueSchema>

export const COMMUNICATION_PREFERENCE_TYPES = [
  'push_account_essentials',
  'push_offers',
  'push_news',
  'email_account_essentials',
  'email_offers',
  'email_news',
  'sms_offers',
] as const
export type CommunicationPreferenceType = (typeof COMMUNICATION_PREFERENCE_TYPES)[number]

const CommunicationPreferenceSchema = z.looseObject({ id: z.string(), type: z.string() })
export type CommunicationPreference = z.infer<typeof CommunicationPreferenceSchema>

/** Known code types; the API may report others, which the tools refuse to redeem. */
export const KNOWN_CODE_TYPES = ['gift_voucher', 'promo_code', 'referral_code', 'offer_code', 'customer_referral_code'] as const
export type KnownCodeType = (typeof KNOWN_CODE_TYPES)[number]

const CodeInfoSchema = z.looseObject({ type: z.string() })
const ReferralCodeSchema = z.looseObject({ code: z.string(), limitReached: z.boolean().nullish() })
const AppVersionSchema = z.looseObject({ updateType: z.string() })

// Write responses are parsed leniently: a write that succeeded must not turn into an error
// because an optional field in its answer changed.
const GiftVoucherRedemptionSchema = z.looseObject({
  credit: z.looseObject({ availableBalance: amount.nullish() }).nullish(),
})
const PromoCodeRedemptionSchema = z.looseObject({
  discount: z.looseObject({ value: z.number().nullish() }).nullish(),
  strategy: z.string().nullish(),
})
const JoinOrganisationSchema = z.looseObject({
  organisation: z.looseObject({ name: z.string().nullish(), discount: z.number().nullish() }).nullish(),
})
const OfferCodeActivationSchema = z.looseObject({
  offer: z.looseObject({ displaySettings: z.looseObject({ title: z.string().nullish() }).nullish() }).nullish(),
})
const AnyBody = z.unknown()

/** Customer-referral error codes returned by the API. */
const API_ERROR_CODES: Record<number, string> = {
  13000: 'Referral program is disabled.',
  13001: 'You cannot use your own referral code.',
  13002: 'You have already redeemed a referral code.',
  13003: 'Referral codes only work before your first order.',
  13004: 'That referral code has reached its limit.',
}

const ApiErrorBodySchema = z.looseObject({
  code: z.number().nullish(),
  message: z.string().nullish(),
  detail: z.string().nullish(),
})

/** The API's own message and the HTTP status. Raw bodies never reach the user: they can echo input or internals. */
function describeError(method: string, path: string, status: number, text: string): string {
  const endpoint = `${method} ${path.split('?')[0]}`
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return `${endpoint} failed: HTTP ${status}`
  }
  const parsed = ApiErrorBodySchema.safeParse(json)
  if (parsed.success) {
    const { code, message, detail } = parsed.data
    const known = code !== null && code !== undefined ? API_ERROR_CODES[code] : undefined
    const reason = known ?? message ?? detail
    if (reason) return `${reason} (HTTP ${status} on ${endpoint})`
  }
  return `${endpoint} failed: HTTP ${status}`
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.length ? path.map(String).join('.') : '(root)'
}

/** Parses a body or throws naming the endpoint and the first failing field, never the body itself. */
function parseBody<S extends z.ZodType>(schema: S, value: unknown, endpoint: string, status: number): z.output<S> {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const where = issue ? `${issuePath(issue.path)}: ${issue.message}` : 'unexpected shape'
  throw new ResponseShapeError(`Unexpected response from ${endpoint} (${where}). Run pub_points_doctor to check the API.`, status)
}

export interface PubPointsClientDeps {
  fetch?: typeof fetch
}

interface RequestOptions {
  body?: unknown
  authenticated?: boolean
}

type Method = 'GET' | 'POST' | 'DELETE'

/** For calls with no caller to cancel them (CLI, tests); REQUEST_TIMEOUT_MS still bounds each request. */
const NOT_CANCELLED: AbortSignal = new AbortController().signal

const PAGE_SIZE = 100
/** Records `pub_points_activity` reads at most before saying the list was truncated. */
export const ACTIVITY_CAP = 2_000

export interface ActivityPage {
  items: Activity[]
  /** True when ACTIVITY_CAP stopped the paging before the requested start date or the end of history. */
  truncated: boolean
}

export interface OrderFilter {
  /** ISO timestamp; orders created at or after it. */
  after?: string
  /** ISO timestamp; orders created at or before it. */
  before?: string
  status?: 'completed' | 'reversed'
  max: number
}

export interface OrderList {
  orders: OrderSummary[]
  /** False when `max` was reached with more pages left. */
  complete: boolean
}

export class PubPointsClient {
  private algoliaKey: AlgoliaKey | null = null
  private readonly tokens: IdTokenSource
  private readonly deps: PubPointsClientDeps

  constructor(tokens: IdTokenSource = new TokenProvider(), deps: PubPointsClientDeps = {}) {
    this.tokens = tokens
    this.deps = deps
  }

  private get fetchImpl(): typeof fetch {
    return this.deps.fetch ?? globalThis.fetch
  }

  /** One API call. Returns null for 204 or an empty body; callers decide whether that is acceptable. */
  private async request<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    signal: AbortSignal,
    options: RequestOptions = {},
    retried = false
  ): Promise<z.output<S> | null> {
    const authenticated = options.authenticated ?? true
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    }
    if (authenticated) headers.Authorization = `Bearer ${await this.tokens.getIdToken(retried, signal)}`
    const res = await this.fetchImpl(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: requestSignal(signal),
    })
    // A 401 means the request was rejected before processing, so a retry cannot double-apply a write.
    if (res.status === 401 && authenticated && !retried) return this.request(method, path, schema, signal, options, true)
    const text = await res.text()
    if (!res.ok) throw new ApiError(describeError(method, path, res.status, text), res.status)
    if (res.status === 204 || text === '') return null
    const endpoint = `${method} ${path.split('?')[0]}`
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new ResponseShapeError(`Unexpected response from ${endpoint} (not JSON, HTTP ${res.status}).`, res.status)
    }
    return parseBody(schema, json, endpoint, res.status)
  }

  /** A call whose answer must have a body. */
  private async read<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    signal: AbortSignal,
    options: RequestOptions = {}
  ): Promise<z.output<S>> {
    const value = await this.request(method, path, schema, signal, options)
    if (value === null) throw new ResponseShapeError(`Unexpected empty response from ${method} ${path.split('?')[0]}.`, 204)
    return value
  }

  /** Pages a list endpoint until it reports no next page, returns an empty page, or `stop` says enough. */
  private async pages<T>(
    path: string,
    params: URLSearchParams,
    item: z.ZodType<T>,
    signal: AbortSignal,
    stop: (all: T[], page: T[]) => boolean
  ): Promise<{ items: T[]; more: boolean }> {
    const all: T[] = []
    for (let page = 1; ; page++) {
      params.set('page', String(page))
      params.set('perPage', String(PAGE_SIZE))
      const res = await this.read('GET', `${path}?${params.toString()}`, paginated(item), signal)
      all.push(...res.items)
      const more = res.pagination?.hasNextPage === true && res.items.length > 0
      if (!more) return { items: all, more: false }
      if (stop(all, res.items)) return { items: all, more: true }
    }
  }

  // ---- account ----

  getProfile(signal: AbortSignal = NOT_CANCELLED) {
    return this.read('GET', '/customers/me', ProfileSchema, signal)
  }

  getReferralCode(signal: AbortSignal = NOT_CANCELLED) {
    return this.read('GET', '/customers/me/referral-code', ReferralCodeSchema, signal)
  }

  getPublicSettings(signal: AbortSignal = NOT_CANCELLED) {
    return this.read('GET', '/public/settings', PublicSettingsSchema, signal, { authenticated: false })
  }

  /**
   * The Pass's update check: "hard" means the API now refuses this client version's
   * behaviour (users are forced to upgrade), "soft" means a newer release exists.
   */
  checkAppVersion(appVersion: string, signal: AbortSignal = NOT_CANCELLED) {
    return this.read('POST', '/public/mobile-app-update-check', AppVersionSchema, signal, {
      body: { appVersion, deviceOs: 'android' },
      authenticated: false,
    })
  }

  getPromoTiles(signal: AbortSignal = NOT_CANCELLED) {
    return this.read('GET', '/available-tiles', paginated(PromoTileSchema), signal)
  }

  /**
   * Activity records, newest first. The API has no server-side type or date filter, so this
   * pages until a page reaches back before `since` (an ISO timestamp) or ACTIVITY_CAP records.
   */
  async getActivities(since: string | undefined, signal: AbortSignal = NOT_CANCELLED): Promise<ActivityPage> {
    const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY
    let reachedSince = false
    const { items, more } = await this.pages('/activities', new URLSearchParams(), ActivitySchema, signal, (all, page) => {
      reachedSince = page.some((a) => Date.parse(a.createdAt) < sinceMs)
      return reachedSince || all.length >= ACTIVITY_CAP
    })
    const sorted = items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, ACTIVITY_CAP)
    return { items: sorted, truncated: more && !reachedSince }
  }

  // ---- orders ----

  /** Orders newest first, filtered server-side by createdAt[after]/[before] and status. */
  async getOrders(filter: OrderFilter, signal: AbortSignal = NOT_CANCELLED): Promise<OrderList> {
    const params = new URLSearchParams()
    if (filter.after) params.set('createdAt[after]', filter.after)
    if (filter.before) params.set('createdAt[before]', filter.before)
    if (filter.status) params.set('status', filter.status)
    const { items, more } = await this.pages('/orders', params, OrderSummarySchema, signal, (all) => all.length >= filter.max)
    return { orders: items.slice(0, filter.max), complete: !more && items.length <= filter.max }
  }

  getOrder(id: string, signal: AbortSignal = NOT_CANCELLED) {
    return this.read('GET', `/orders/${encodeURIComponent(id)}`, OrderDetailsSchema, signal)
  }

  // ---- organisations ----

  getCustomerOrganisation(customerOrganisationId: string, signal: AbortSignal = NOT_CANCELLED) {
    return this.read(
      'GET',
      `/customer-organisations/${encodeURIComponent(customerOrganisationId)}`,
      CustomerOrganisationDetailsSchema,
      signal
    )
  }

  async getCustomerOrganisations(signal: AbortSignal = NOT_CANCELLED): Promise<CustomerOrganisation[]> {
    const res = await this.read('GET', '/customer-organisations', paginated(CustomerOrganisationSchema), signal)
    return res.items.filter((item) => !item.organisation.hidden)
  }

  // ---- favourite venues ----

  async getFavouriteVenues(signal: AbortSignal = NOT_CANCELLED): Promise<FavouriteVenue[]> {
    return (await this.read('GET', '/favourite-venues', paginated(FavouriteVenueSchema), signal)).items
  }

  async addFavouriteVenue(venueId: string, signal: AbortSignal = NOT_CANCELLED): Promise<void> {
    await this.request('POST', '/favourite-venues', AnyBody, signal, { body: { venue: `/venues/${encodeURIComponent(venueId)}` } })
  }

  /** Takes the favourite record id (from getFavouriteVenues), not the venue id. */
  async removeFavouriteVenue(favouriteId: string, signal: AbortSignal = NOT_CANCELLED): Promise<void> {
    await this.request('DELETE', `/favourite-venues/${encodeURIComponent(favouriteId)}`, AnyBody, signal)
  }

  // ---- communication preferences ----

  async getCommunicationPreferences(signal: AbortSignal = NOT_CANCELLED): Promise<CommunicationPreference[]> {
    return (await this.read('GET', '/communication-preferences', paginated(CommunicationPreferenceSchema), signal)).items
  }

  async addCommunicationPreference(type: CommunicationPreferenceType, signal: AbortSignal = NOT_CANCELLED): Promise<void> {
    await this.request('POST', '/communication-preferences', AnyBody, signal, { body: { type } })
  }

  async removeCommunicationPreference(id: string, signal: AbortSignal = NOT_CANCELLED): Promise<void> {
    await this.request('DELETE', `/communication-preferences/${encodeURIComponent(id)}`, AnyBody, signal)
  }

  // ---- offers ----

  getOfferDetails(id: string, signal: AbortSignal = NOT_CANCELLED) {
    const params = new URLSearchParams({ 'location[utcOffset]': utcOffset() })
    return this.read('GET', `/available-offers/${encodeURIComponent(id)}?${params.toString()}`, OfferDetailsSchema, signal)
  }

  async getOfferVenueIds(offerId: string, signal: AbortSignal = NOT_CANCELLED): Promise<string[]> {
    const res = await this.read('POST', '/available-offers/search', OffersAndVenuesSchema, signal, {
      body: {
        offers: [offerId],
        properties: ['venues'],
        types: ['single_step', 'multi_step', 'instant_reward'],
        location: { utcOffset: utcOffset() },
      },
    })
    return (res.venues ?? []).map((v) => v.id)
  }

  /** Instant rewards are redeemed; in-app offers are activated. */
  async activateOffer(offer: OfferDetails, signal: AbortSignal = NOT_CANCELLED): Promise<'redeemed' | 'activated'> {
    const ref = `/offers/${encodeURIComponent(offer.id)}`
    if (offer.type === 'instant_reward') {
      await this.request('POST', '/instant-reward-offer-redemptions', AnyBody, signal, {
        body: { offer: ref, location: { utcOffset: utcOffset() } },
      })
      return 'redeemed'
    }
    await this.request('POST', '/in-app-offer-customer-activations', AnyBody, signal, { body: { offer: ref } })
    return 'activated'
  }

  /**
   * Mirrors the app: one search for instant rewards and one for single/multi-step offers.
   * The endpoint ignores an `activated` filter (it returns every offer either way), so callers
   * filter on each offer's own `activated` flag instead.
   */
  async searchOffers(
    filter: { venues?: string[]; organisations?: string[]; limit?: number },
    location: Location | undefined,
    signal: AbortSignal = NOT_CANCELLED
  ): Promise<Offer[]> {
    const base = {
      sort: { offers: { 'displaySettings.priorityScore': 'desc' } },
      properties: ['offers'],
      location: {
        utcOffset: utcOffset(),
        ...(location ? { latitude: String(location.latitude), longitude: String(location.longitude) } : {}),
      },
      ...(filter.venues ? { venues: filter.venues.slice(0, 200) } : {}),
      ...(filter.organisations ? { organisations: filter.organisations } : {}),
      ...(filter.limit ? { limits: { offers: filter.limit } } : {}),
    }
    const [instant, regular] = await Promise.all([
      this.read('POST', '/available-offers/search', OffersAndVenuesSchema, signal, { body: { ...base, types: ['instant_reward'] } }),
      this.read('POST', '/available-offers/search', OffersAndVenuesSchema, signal, {
        body: { ...base, types: ['single_step', 'multi_step'] },
      }),
    ])
    const seen = new Set<string>()
    return [...(instant.offers ?? []), ...(regular.offers ?? [])].filter((o) => !seen.has(o.id) && seen.add(o.id))
  }

  // ---- codes, rewards, gifts ----

  checkCode(code: string, signal: AbortSignal = NOT_CANCELLED) {
    return this.read('POST', '/code-info', CodeInfoSchema, signal, { body: { code } })
  }

  redeemGiftVoucher(code: string, signal: AbortSignal = NOT_CANCELLED) {
    return this.request('POST', '/gift-voucher-redemptions', GiftVoucherRedemptionSchema, signal, { body: { code } })
  }

  redeemPromoCode(code: string, signal: AbortSignal = NOT_CANCELLED) {
    return this.request('POST', '/promo-code-redemptions', PromoCodeRedemptionSchema, signal, {
      body: { promoCode: `/promo-codes/${encodeURIComponent(code)}` },
    })
  }

  joinOrganisation(code: string, signal: AbortSignal = NOT_CANCELLED) {
    return this.request('POST', '/customer-organisations', JoinOrganisationSchema, signal, { body: { code } })
  }

  activateOfferCode(code: string, signal: AbortSignal = NOT_CANCELLED) {
    return this.request('POST', '/code-offer-customer-activations', OfferCodeActivationSchema, signal, { body: { code } })
  }

  async redeemFriendReferralCode(code: string, signal: AbortSignal = NOT_CANCELLED): Promise<void> {
    await this.request('POST', '/customer-referral-code-redemptions', AnyBody, signal, { body: { code } })
  }

  async redeemPoints(rewardId: string, signal: AbortSignal = NOT_CANCELLED): Promise<void> {
    await this.request('POST', '/points-redemptions', AnyBody, signal, {
      body: { pointsExchangeRate: `/points-exchange-rates/${encodeURIComponent(rewardId)}` },
    })
  }

  async redeemBirthdayGift(signal: AbortSignal = NOT_CANCELLED): Promise<void> {
    await this.request('POST', '/customers/me/birthday-gift/redemptions', AnyBody, signal, {
      body: { location: { utcOffset: utcOffset() } },
    })
  }

  getBalances(signal: AbortSignal = NOT_CANCELLED) {
    return this.read('GET', '/customer-balances', CustomerBalancesSchema, signal)
  }

  getCustomerTier(signal: AbortSignal = NOT_CANCELLED) {
    return this.read('GET', '/customers/me/tier', CustomerTierSchema, signal)
  }

  getTiers(signal: AbortSignal = NOT_CANCELLED) {
    return this.read('GET', '/tiers', paginated(TierSummarySchema), signal)
  }

  getPointsExchangeRates(signal: AbortSignal = NOT_CANCELLED) {
    return this.read('GET', '/points-exchange-rates', paginated(PointsExchangeRateSchema), signal)
  }

  /** Unexpired credit with a balance, soonest expiry first; at most 10 pages. */
  async getAvailableCredits(signal: AbortSignal = NOT_CANCELLED): Promise<Credit[]> {
    const params = new URLSearchParams({ 'status[ne]': 'expired', 'availableBalance[gt]': '0', 'sort[expiresAt]': 'asc' })
    const { items } = await this.pages('/credits', params, CreditSchema, signal, (all) => all.length >= 10 * PAGE_SIZE)
    return items
  }

  async getBirthdayGift(signal: AbortSignal = NOT_CANCELLED): Promise<BirthdayGift | null> {
    const params = new URLSearchParams({ 'location[utcOffset]': utcOffset() })
    try {
      return await this.request('GET', `/customers/me/birthday-gift?${params.toString()}`, BirthdayGiftSchema, signal)
    } catch (err) {
      if (err instanceof ApiError && !(err instanceof ResponseShapeError) && (err.status === 404 || err.status === 400)) return null
      throw err
    }
  }

  // ---- venues (Algolia) ----

  private async getAlgoliaKey(signal: AbortSignal): Promise<AlgoliaKey> {
    const expired = this.algoliaKey?.expiresAt && Date.parse(this.algoliaKey.expiresAt) - Date.now() < 60_000
    if (!this.algoliaKey || expired) {
      this.algoliaKey = await this.read('POST', '/algolia-api-keys', AlgoliaKeySchema, signal, { body: {} })
    }
    return this.algoliaKey
  }

  /** One Algolia call. A 401/403 drops the cached key and retries once with a fresh one. */
  private async algolia<S extends z.ZodType>(
    what: string,
    path: (key: AlgoliaKey) => string,
    body: (key: AlgoliaKey) => unknown,
    schema: S,
    signal: AbortSignal,
    retried = false
  ): Promise<z.output<S>> {
    const key = await this.getAlgoliaKey(signal)
    const res = await this.fetchImpl(`https://${ALGOLIA_APP_ID}-dsn.algolia.net${path(key)}`, {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': ALGOLIA_APP_ID,
        'X-Algolia-API-Key': key.secret,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body(key)),
      signal: requestSignal(signal),
    })
    if ((res.status === 401 || res.status === 403) && !retried) {
      this.algoliaKey = null
      return this.algolia(what, path, body, schema, signal, true)
    }
    if (!res.ok) {
      const parsed = ApiErrorBodySchema.safeParse(await res.json().catch(() => null))
      const reason = parsed.success && parsed.data.message ? `${parsed.data.message}, ` : ''
      throw new ApiError(`${what} failed (${reason}HTTP ${res.status})`, res.status)
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new ResponseShapeError(`Unexpected response from ${what} (not JSON).`, res.status)
    }
    return parseBody(schema, json, what, res.status)
  }

  /** Venue search (Australian venues only). */
  async searchVenues(
    query: string,
    opts: { near?: Location; radiusMetres?: number; limit?: number },
    signal: AbortSignal = NOT_CANCELLED
  ): Promise<Venue[]> {
    const params: Record<string, unknown> = {
      query,
      filters: 'NOT region:"New Zealand"',
      hitsPerPage: opts.limit ?? 20,
      allowTyposOnNumericTokens: false,
      getRankingInfo: true,
    }
    if (opts.near) {
      params.aroundLatLng = `${opts.near.latitude}, ${opts.near.longitude}`
      params.aroundRadius = opts.radiusMetres ?? 20_000
    }
    const res = await this.algolia(
      'Venue search',
      (key) => `/1/indexes/${encodeURIComponent(key.venueIndexName)}/query`,
      () => params,
      z.looseObject({ hits: z.array(VenueSchema).nullish() }),
      signal
    )
    return res.hits ?? []
  }

  /** Venue records by id (Algolia multi-object get). */
  async getVenuesByIds(ids: string[], signal: AbortSignal = NOT_CANCELLED): Promise<Venue[]> {
    if (ids.length === 0) return []
    const res = await this.algolia(
      'Venue lookup',
      () => '/1/indexes/*/objects',
      (key) => ({ requests: ids.slice(0, 1000).map((objectID) => ({ indexName: key.venueIndexName, objectID })) }),
      z.looseObject({ results: z.array(VenueSchema.nullable()).nullish() }),
      signal
    )
    return (res.results ?? []).filter((v): v is Venue => v !== null)
  }
}

/** The client surface the tools use; tests substitute a plain object with the same methods. */
export type PubPointsApi = Pick<PubPointsClient, keyof PubPointsClient>
