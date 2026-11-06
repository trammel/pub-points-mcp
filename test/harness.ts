// SPDX-License-Identifier: GPL-3.0-or-later
// Shared test harness: the real MCP server from dist/ wired to a fake PubPointsClient over an
// in-memory transport, driven by a real MCP client. No test reaches the network.
//
// Seams used (contract §11): registerTools(server, client, { readOnly, confirmations }) and
// ConfirmationStore({ now, ttlMs }). Modules that may not exist yet are imported lazily so a
// missing module fails each test on its own instead of aborting the file.
//
// node --test also loads this file (it sits under test/); it declares no tests.

import type { TestContext } from 'node:test'
import { McpServer, InMemoryTransport, createMcpHandler, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server'
import { Client, StreamableHTTPClientTransport, isInputRequiredResult } from '@modelcontextprotocol/client'
import type {
  CallToolResult,
  ClientCapabilities,
  ElicitRequestFormParams,
  ElicitRequestParams,
  ElicitResult,
  InputRequiredResult,
  RequestOptions,
} from '@modelcontextprotocol/client'
import { ApiError } from '../dist/api.js'
import type {
  BirthdayGift,
  CommunicationPreference,
  CustomerBalances,
  FavouriteVenue,
  OfferDetails,
  PointsExchangeRate,
  PubPointsApi,
  Venue,
} from '../dist/api.js'
import type { ConfirmationStore } from '../dist/confirmation.js'

/** The protocol revision whose elicitation runs as input_required results instead of a server request. */
const MODERN_PROTOCOL = '2026-07-28'

export const ACTION_TOOLS = [
  'pub_points_activate_offer',
  'pub_points_redeem_points',
  'pub_points_redeem_code',
  'pub_points_join_organisation',
  'pub_points_redeem_birthday_gift',
  'pub_points_set_communication_preferences',
  'pub_points_add_favourite_venue',
  'pub_points_remove_favourite_venue',
]

/** A PubPointsClient method that changes the account. */
export type WriteMethod =
  | 'activateOffer'
  | 'redeemPoints'
  | 'redeemGiftVoucher'
  | 'redeemPromoCode'
  | 'joinOrganisation'
  | 'activateOfferCode'
  | 'redeemFriendReferralCode'
  | 'redeemBirthdayGift'
  | 'addCommunicationPreference'
  | 'removeCommunicationPreference'
  | 'addFavouriteVenue'
  | 'removeFavouriteVenue'

export const INVALID_TOKEN_TEXT =
  'Confirmation token is invalid, expired or does not match these arguments. Call again without confirmationToken for a new confirmation.'

/** 2026-11-05T01:00:00.000Z — every expiry in these tests is computed from this literal. */
export const T0 = Date.UTC(2026, 10, 5, 1, 0, 0)
export const FIVE_MINUTES_MS = 5 * 60 * 1000

const FAR_FUTURE = '2099-01-01T00:00:00Z'

/** Account state the fake client serves, typed as PubPointsClient returns it after parsing. */
export interface FakeState {
  balances: CustomerBalances
  rates: PointsExchangeRate[]
  /** The two fixture offers are always there; tests may add more by id. */
  offers: { 'offer-inapp': OfferDetails; 'offer-auto': OfferDetails } & Record<string, OfferDetails>
  /** code -> the type checkCode reports */
  codes: Record<string, string>
  birthday: BirthdayGift | null
  venues: Record<string, Venue>
  favourites: FavouriteVenue[]
  preferences: CommunicationPreference[]
  /** method name -> Error the write throws */
  writeErrors: Partial<Record<WriteMethod, Error>>
  /** Error getBalances throws once any write has happened (models a failed follow-up read). */
  balancesErrorAfterWrite: Error | null
  /** Error getVenuesByIds throws (models a failed Algolia lookup). */
  venueLookupError: Error | null
  /** Error a read method throws, by method name. */
  readErrors: Partial<Record<keyof PubPointsApi, Error>>
}

/**
 * Account state the fake client serves. Every test gets a fresh copy and may edit it. Amounts are
 * numbers, as PubPointsClient returns them after its schema parses the API's numeric strings.
 */
export function defaultState(): FakeState {
  return {
    balances: { pointsBalance: 1500, creditBalance: 2500, pointsExpireAt: null },
    rates: [
      { id: 'reward-a', pointsAmount: 1000, creditAmount: 1000 },
      { id: 'reward-b', pointsAmount: 1200, creditAmount: 1500 },
      { id: 'reward-c', pointsAmount: 5000, creditAmount: 7500 },
    ],
    offers: {
      'offer-inapp': {
        id: 'offer-inapp',
        type: 'single_step',
        activated: false,
        strategy: 'credit',
        activationStrategy: 'in_app',
        value: 500,
        startAt: '2026-01-01T00:00:00Z',
        endAt: FAR_FUTURE,
        limitPerCustomerReached: false,
        displaySettings: { title: 'Free Chips' },
      },
      'offer-auto': {
        id: 'offer-auto',
        type: 'single_step',
        activated: false,
        strategy: 'credit',
        activationStrategy: 'auto',
        value: 500,
        startAt: '2026-01-01T00:00:00Z',
        endAt: FAR_FUTURE,
        limitPerCustomerReached: false,
        displaySettings: { title: 'Auto Wings' },
      },
    },
    codes: {
      GIFT123: 'gift_voucher',
      PROMO1: 'promo_code',
      GROUP1: 'referral_code',
      OFFER1: 'offer_code',
      FRIEND1: 'customer_referral_code',
    },
    birthday: { value: 1000, cardTransactionRequirementMet: true },
    venues: {
      'venue-1': { objectID: 'venue-1', title: 'The Local' },
      'venue-2': { objectID: 'venue-2', title: 'The Royal' },
    },
    favourites: [{ id: 'fav-9', venue: { id: 'venue-2' } }],
    preferences: [{ id: 'pref-1', type: 'email_news' }],
    writeErrors: {},
    balancesErrorAfterWrite: null,
    venueLookupError: null,
    readErrors: {},
  }
}

/** What each write answers, typed as the real client method's resolved value. */
const WRITE_RESULTS: { [M in WriteMethod]: (...args: Parameters<PubPointsApi[M]>) => Awaited<ReturnType<PubPointsApi[M]>> } = {
  // The real client redeems instant rewards and activates in-app offers (api.ts activateOffer).
  activateOffer: (offer) => (offer.type === 'instant_reward' ? 'redeemed' : 'activated'),
  redeemPoints: () => undefined,
  redeemGiftVoucher: () => ({ credit: { availableBalance: 5000 } }),
  redeemPromoCode: () => ({ discount: { value: 10 } }),
  joinOrganisation: () => ({ organisation: { name: 'Acme Social Club', discount: 10 } }),
  activateOfferCode: () => ({ offer: { displaySettings: { title: 'Code Offer' } } }),
  redeemFriendReferralCode: () => undefined,
  redeemBirthdayGift: () => undefined,
  addCommunicationPreference: () => undefined,
  removeCommunicationPreference: () => undefined,
  addFavouriteVenue: () => undefined,
  removeFavouriteVenue: () => undefined,
}

/** One recorded client call. */
interface FakeCall {
  method: string
  args: unknown[]
}

/** The fake client: every PubPointsClient method, plus what it recorded and the state it serves. */
export type FakeClient = PubPointsApi & {
  writes: FakeCall[]
  /** Every read method call, in order. */
  reads: FakeCall[]
  state: FakeState
}

/** A method this fake does not serve: a test that needs it puts its own on the fake before the call. */
function notServed(method: keyof PubPointsApi): () => Promise<never> {
  return () => Promise.reject(new TypeError(`the fake client does not serve ${method}; put one on h.fake before the call`))
}

/**
 * A plain object standing in for PubPointsClient. Read methods serve `state`; every write
 * method appends `{ method, args }` to `writes` before doing anything else.
 */
function makeFakeClient(state: FakeState): FakeClient {
  const writes: FakeCall[] = []
  const reads: FakeCall[] = []
  const read =
    <A extends unknown[], R>(method: keyof PubPointsApi, fn: (...args: A) => R) =>
    (...args: A): Promise<R> =>
      new Promise((resolve) => {
        reads.push({ method, args })
        const err = state.readErrors[method]
        if (err) throw err
        resolve(fn(...args))
      })
  const write =
    <M extends WriteMethod>(method: M) =>
    (...args: Parameters<PubPointsApi[M]>): Promise<Awaited<ReturnType<PubPointsApi[M]>>> =>
      new Promise((resolve) => {
        writes.push({ method, args })
        const err: Error | undefined = state.writeErrors[method]
        if (err) throw err
        resolve(WRITE_RESULTS[method](...args))
      })
  return {
    writes,
    reads,
    state,
    getBalances: read('getBalances', () => {
      if (writes.length && state.balancesErrorAfterWrite) throw state.balancesErrorAfterWrite
      return { ...state.balances }
    }),
    getPointsExchangeRates: read('getPointsExchangeRates', () => ({ items: state.rates.map((r) => ({ ...r })) })),
    getOfferDetails: read('getOfferDetails', (id: string) => {
      const offer = state.offers[id]
      if (!offer) throw new ApiError(`Offer not found (HTTP 404 on GET /available-offers/${id})`, 404)
      return structuredClone(offer)
    }),
    checkCode: read('checkCode', (code: string) => ({ type: state.codes[code] ?? 'gift_voucher' })),
    getBirthdayGift: read('getBirthdayGift', () => (state.birthday ? { ...state.birthday } : null)),
    getVenuesByIds: read('getVenuesByIds', (ids: string[]) => {
      if (state.venueLookupError) throw state.venueLookupError
      return ids
        .map((id) => state.venues[id])
        .filter((v) => v !== undefined)
        .map((v) => ({ ...v }))
    }),
    getFavouriteVenues: read('getFavouriteVenues', () => state.favourites.map((f) => structuredClone(f))),
    getCommunicationPreferences: read('getCommunicationPreferences', () => state.preferences.map((p) => ({ ...p }))),
    activateOffer: write('activateOffer'),
    redeemPoints: write('redeemPoints'),
    redeemGiftVoucher: write('redeemGiftVoucher'),
    redeemPromoCode: write('redeemPromoCode'),
    joinOrganisation: write('joinOrganisation'),
    activateOfferCode: write('activateOfferCode'),
    redeemFriendReferralCode: write('redeemFriendReferralCode'),
    redeemBirthdayGift: write('redeemBirthdayGift'),
    addCommunicationPreference: write('addCommunicationPreference'),
    removeCommunicationPreference: write('removeCommunicationPreference'),
    addFavouriteVenue: write('addFavouriteVenue'),
    removeFavouriteVenue: write('removeFavouriteVenue'),
    getProfile: notServed('getProfile'),
    getReferralCode: notServed('getReferralCode'),
    getPublicSettings: notServed('getPublicSettings'),
    checkAppVersion: notServed('checkAppVersion'),
    getPromoTiles: notServed('getPromoTiles'),
    getActivities: notServed('getActivities'),
    getOrders: notServed('getOrders'),
    getOrder: notServed('getOrder'),
    getCustomerOrganisation: notServed('getCustomerOrganisation'),
    getCustomerOrganisations: notServed('getCustomerOrganisations'),
    getOfferVenueIds: notServed('getOfferVenueIds'),
    searchOffers: notServed('searchOffers'),
    getCustomerTier: notServed('getCustomerTier'),
    getTiers: notServed('getTiers'),
    getAvailableCredits: notServed('getAvailableCredits'),
    searchVenues: notServed('searchVenues'),
  }
}

export async function loadConfirmationStore(): Promise<typeof ConfirmationStore> {
  try {
    return (await import('../dist/confirmation.js')).ConfirmationStore
  } catch (err) {
    throw new Error(`dist/confirmation.js must export ConfirmationStore (contract §11): ${errorText(err)}`, { cause: err })
  }
}

/** A clock the test moves by hand. */
export interface ManualClock {
  now: () => number
  advance: (ms: number) => void
}

/** A clock the test moves by hand. */
export function manualClock(start = T0): ManualClock {
  let now = start
  return {
    now: () => now,
    advance(ms) {
      now += ms
    },
  }
}

/** How the test client answers an elicitation request. */
export type ElicitHandler = (params: ElicitRequestParams) => ElicitResult | Promise<ElicitResult>

/** A connected client, the fake behind the server, and what the client was asked. */
export interface Harness {
  client: Client
  fake: FakeClient
  state: FakeState
  store: ConfirmationStore
  elicitRequests: ElicitRequestParams[]
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>
}

export interface ConnectOptions {
  readOnly?: boolean
  elicit?: ElicitHandler | null
  elicitation?: ClientCapabilities['elicitation']
  state?: FakeState
  confirmations?: ConfirmationStore
  clock?: ManualClock
}

async function storeFor(confirmations: ConfirmationStore | undefined, clock: ManualClock | undefined): Promise<ConfirmationStore> {
  if (confirmations) return confirmations
  const ConfirmationStoreClass = await loadConfirmationStore()
  return new ConfirmationStoreClass({ now: (clock ?? manualClock()).now })
}

/**
 * Connects a real MCP client to the real server.
 * - `elicit`: when given, the client declares the elicitation capability and answers every
 *   elicitation request with `elicit(params)`; the params are recorded in `elicitRequests`.
 * - `confirmations`: a ConfirmationStore; when omitted one is built on `clock`.
 */
export async function connect(
  t: TestContext,
  { readOnly = false, elicit = null, elicitation, state = defaultState(), confirmations, clock }: ConnectOptions = {}
): Promise<Harness> {
  const { registerTools } = await import('../dist/tools.js')
  const store = await storeFor(confirmations, clock)
  const fake = makeFakeClient(state)
  const server = new McpServer({ name: 'pub-points-test', version: '0.0.0' })
  registerTools(server, fake, { readOnly, confirmations: store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  // `elicitation` overrides the declared capability (e.g. URL-only, or declared with no handler).
  const declared = elicitation ?? (elicit ? {} : undefined)
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: declared ? { elicitation: declared } : {} })
  const elicitRequests: ElicitRequestParams[] = []
  if (elicit) {
    client.setRequestHandler('elicitation/create', async (request) => {
      elicitRequests.push(request.params)
      return elicit(request.params)
    })
  }
  await client.connect(clientTransport)
  t.after(() => client.close())
  return {
    client,
    fake,
    state,
    store,
    elicitRequests,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
  }
}

export interface ConnectModernOptions {
  elicit?: ElicitHandler | null
  state?: FakeState
  confirmations?: ConfirmationStore
  clock?: ManualClock
  manual?: boolean
}

/**
 * Same as connect(), but on the 2026-07-28 protocol: the server is served by createMcpHandler
 * (one server instance per request, sharing the fake client and the store), and the client
 * reaches it through an in-process fetch, so nothing leaves the process. Elicitation then runs
 * as input_required results with a requestState round trip, and the client capability arrives
 * per request rather than at initialize.
 */
export async function connectModern(
  t: TestContext,
  { elicit = null, state = defaultState(), confirmations, clock, manual = false }: ConnectModernOptions = {}
): Promise<Harness> {
  const { registerTools } = await import('../dist/tools.js')
  const store = await storeFor(confirmations, clock)
  const fake = makeFakeClient(state)
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'pub-points-test', version: '0.0.0' })
      registerTools(server, fake, { readOnly: false, confirmations: store })
      return server
    },
    { legacy: 'reject' }
  )
  const transport = new StreamableHTTPClientTransport(new URL('http://pub-points-mcp.test/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  })
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    {
      capabilities: elicit ? { elicitation: {} } : {},
      supportedProtocolVersions: [MODERN_PROTOCOL, ...SUPPORTED_PROTOCOL_VERSIONS],
      versionNegotiation: { mode: { pin: MODERN_PROTOCOL } },
      // manual: input_required results come back to the test instead of being answered
      ...(manual ? { inputRequired: { autoFulfill: false } } : {}),
    }
  )
  const elicitRequests: ElicitRequestParams[] = []
  if (elicit) {
    client.setRequestHandler('elicitation/create', async (request) => {
      elicitRequests.push(request.params)
      return elicit(request.params)
    })
  }
  await client.connect(transport)
  t.after(() => client.close())
  return {
    client,
    fake,
    state,
    store,
    elicitRequests,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
  }
}

/**
 * A tools/call sent as written, so a test can put fields such as inputResponses on the first call.
 * With `allowInputRequired` the SDK hands back an input_required result as it is.
 */
export function rawToolCall(
  h: Harness,
  params: Record<string, unknown>,
  options?: RequestOptions
): Promise<CallToolResult | InputRequiredResult> {
  return h.client.request({ method: 'tools/call', params }, options)
}

export function textOf(result: CallToolResult | InputRequiredResult): string {
  if (isInputRequiredResult(result)) throw new TypeError(`not a complete tool result: ${JSON.stringify(result)}`)
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
}

/** The message of a thrown value, for error text in this harness. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** True for a non-null object, which a test may read fields from. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `value[key]`; throws, as reading a field of a non-object would, when `value` is not an object. */
export function field(value: unknown, key: string): unknown {
  if (!isRecord(value)) throw new TypeError(`cannot read ${key} of ${String(value)}`)
  return value[key]
}

/** `items[index]`; throws, as reading a field of a missing element would, when there is no such element. */
export function nth<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new TypeError(`no element ${index} in a list of ${items.length}`)
  return item
}

/** The value itself; throws, as reading a field of it would, when it is null or undefined. */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new TypeError(`${what} is ${String(value)}`)
  return value
}

/** The tool's structuredContent; throws when the result has none. */
export function structuredOf(result: CallToolResult | InputRequiredResult): Record<string, unknown> {
  const sc = isInputRequiredResult(result) ? undefined : result.structuredContent
  if (!isRecord(sc)) throw new TypeError(`no structuredContent in ${JSON.stringify(result)}`)
  return sc
}

/** A string field of the tool's structuredContent; throws when it is missing or not a string. */
export function structuredString(result: CallToolResult | InputRequiredResult, key: string): string {
  const value = structuredOf(result)[key]
  if (typeof value !== 'string') throw new TypeError(`structuredContent.${key} is not a string: ${JSON.stringify(value)}`)
  return value
}

/** A list of objects; throws when `value` is anything else. */
export function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new TypeError(`not a list of objects: ${JSON.stringify(value)}`)
  return value
}

/** A form elicitation's params; throws for a URL elicitation or a missing request. */
export function formParams(request: ElicitRequestParams | undefined): ElicitRequestFormParams {
  if (request === undefined) throw new TypeError('no elicitation request')
  if (request.mode === 'url') throw new TypeError(`expected a form elicitation, got ${JSON.stringify(request)}`)
  return request
}

/** The `confirm` field a form elicitation asks for; throws when it has none. */
export function confirmField(request: ElicitRequestParams | undefined): { type?: unknown; title?: unknown; description: string } {
  const confirm = formParams(request).requestedSchema.properties.confirm
  if (confirm === undefined) throw new TypeError('the elicitation asks for no confirm field')
  const { description } = confirm
  if (typeof description !== 'string') throw new TypeError(`confirm has no description: ${JSON.stringify(confirm)}`)
  return { type: confirm.type, title: confirm.title, description }
}

/** `value?.[key]` for a value of unknown shape: undefined unless `value` is an object. */
export function prop(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

/** `result.structuredContent?.[key]`: undefined when the result has no structuredContent. */
export function structuredField(result: CallToolResult | InputRequiredResult, key: string): unknown {
  return isInputRequiredResult(result) ? undefined : prop(result.structuredContent, key)
}

/** The value as an object a test may read fields from; throws when it is anything else. */
export function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${what} is not an object: ${JSON.stringify(value)}`)
  return value
}

/** `${err?.name}: ${err?.message}` for a thrown value of any type. */
export function thrownText(err: unknown): string {
  return `${String(prop(err, 'name'))}: ${String(prop(err, 'message'))}`
}

/** The URL a fetch was called with, whichever form it took. */
export function urlText(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

/** `err.message` for a thrown value of unknown type; throws, as reading it would fail, when there is no string message. */
export function messageOf(err: unknown): string {
  const message = prop(err, 'message')
  if (typeof message !== 'string') throw new TypeError(`thrown value has no message: ${thrownText(err)}`)
  return message
}
