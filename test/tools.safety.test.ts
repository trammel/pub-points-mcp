// SPDX-License-Identifier: GPL-3.0-or-later
// Safety contract for the account-changing tools: review-fix-contract.md §2 (read-only), §3
// (confirmation by elicitation or token) and §4 (write outcome reporting); test items 1, 3–9.
//
// Seams assumed beyond §11: none. The fake client is a plain object (test/harness.ts); the
// client declares elicitation through `capabilities: { elicitation: {} }` on a 2025-era
// (default) MCP connection, and answers through setRequestHandler('elicitation/create').

import './backstop.ts'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { CallToolResult, ElicitResult } from '@modelcontextprotocol/client'
import { ApiError } from '../dist/api.js'
import type { ConfirmationBinding } from '../dist/confirmation.js'
import {
  ACTION_TOOLS,
  FIVE_MINUTES_MS,
  INVALID_TOKEN_TEXT,
  T0,
  confirmField,
  connect,
  defaultState,
  formParams,
  isRecord,
  loadConfirmationStore,
  manualClock,
  nth,
  present,
  prop,
  structuredField,
  structuredOf,
  structuredString,
  textOf,
} from './harness.ts'
import type { ElicitHandler, FakeClient, FakeState, Harness, WriteMethod } from './harness.ts'

/** Checks the arguments one write call was made with. */
type ArgsCheck = (args: readonly unknown[]) => boolean

interface WriteCase {
  label: string
  tool: string
  args: Record<string, unknown>
  expectWrites: [WriteMethod, ArgsCheck][]
  readTool: string
  names?: string
  followUpBalance?: boolean
}

/**
 * One row per write path. `expectWrites` are the client calls a confirmed call makes, derived
 * from defaultState(): fav-9 is venue-2's favourite record; pref-1 is the email_news record.
 * `names` is a fixture literal the confirmation action must mention.
 */
const CASES: WriteCase[] = [
  {
    label: 'activate in-app offer',
    tool: 'pub_points_activate_offer',
    args: { offerId: 'offer-inapp' },
    expectWrites: [['activateOffer', (a) => isRecord(a[0]) && a[0].id === 'offer-inapp']],
    readTool: 'pub_points_offers',
    names: 'Free Chips',
  },
  {
    label: 'redeem points',
    tool: 'pub_points_redeem_points',
    args: { rewardId: 'reward-a' },
    expectWrites: [['redeemPoints', (a) => a[0] === 'reward-a']],
    readTool: 'pub_points_summary',
    names: '1,000',
    followUpBalance: true,
  },
  {
    label: 'redeem gift voucher code',
    tool: 'pub_points_redeem_code',
    args: { code: 'GIFT123' },
    expectWrites: [['redeemGiftVoucher', (a) => a[0] === 'GIFT123']],
    readTool: 'pub_points_activity',
    names: 'GIFT123',
  },
  {
    label: 'redeem promo code',
    tool: 'pub_points_redeem_code',
    args: { code: 'PROMO1' },
    expectWrites: [['redeemPromoCode', (a) => a[0] === 'PROMO1']],
    readTool: 'pub_points_activity',
    names: 'PROMO1',
    followUpBalance: true,
  },
  {
    label: 'redeem offer code',
    tool: 'pub_points_redeem_code',
    args: { code: 'OFFER1' },
    expectWrites: [['activateOfferCode', (a) => a[0] === 'OFFER1']],
    readTool: 'pub_points_activity',
    names: 'OFFER1',
  },
  {
    label: "redeem friend's referral code",
    tool: 'pub_points_redeem_code',
    args: { code: 'FRIEND1' },
    expectWrites: [['redeemFriendReferralCode', (a) => a[0] === 'FRIEND1']],
    readTool: 'pub_points_activity',
    names: 'FRIEND1',
    followUpBalance: true,
  },
  {
    label: 'redeem group code through redeem_code',
    tool: 'pub_points_redeem_code',
    args: { code: 'GROUP1' },
    expectWrites: [['joinOrganisation', (a) => a[0] === 'GROUP1']],
    readTool: 'pub_points_activity',
    names: 'GROUP1',
  },
  {
    label: 'join organisation',
    tool: 'pub_points_join_organisation',
    args: { code: 'GROUP1' },
    expectWrites: [['joinOrganisation', (a) => a[0] === 'GROUP1']],
    readTool: 'pub_points_group_discounts',
    names: 'GROUP1',
  },
  {
    label: 'claim birthday gift',
    tool: 'pub_points_redeem_birthday_gift',
    args: {},
    expectWrites: [['redeemBirthdayGift', () => true]],
    readTool: 'pub_points_credits',
    names: '$10.00',
    followUpBalance: true,
  },
  {
    label: 'turn a preference on',
    tool: 'pub_points_set_communication_preferences',
    args: { turnOn: ['push_offers'] },
    expectWrites: [['addCommunicationPreference', (a) => a[0] === 'push_offers']],
    readTool: 'pub_points_communication_preferences',
  },
  {
    label: 'add favourite venue',
    tool: 'pub_points_add_favourite_venue',
    args: { venueId: 'venue-1' },
    expectWrites: [['addFavouriteVenue', (a) => a[0] === 'venue-1']],
    readTool: 'pub_points_favourite_venues',
    names: 'The Local',
  },
  {
    label: 'remove favourite venue',
    tool: 'pub_points_remove_favourite_venue',
    args: { venueId: 'venue-2' },
    expectWrites: [['removeFavouriteVenue', (a) => a[0] === 'fav-9']],
    readTool: 'pub_points_favourite_venues',
    names: 'The Royal',
  },
]

function assertNotError(result: CallToolResult, context: string) {
  assert.notEqual(result.isError, true, `${context}: expected a non-error result, got: ${textOf(result)}`)
}

function assertWrites(fake: FakeClient, expected: WriteCase['expectWrites'], context: string) {
  assert.deepEqual(
    fake.writes.map((w) => w.method),
    expected.map(([m]) => m),
    `${context}: write calls`
  )
  expected.forEach(([method, argsOk], i) => {
    const { args } = nth(fake.writes, i)
    assert.ok(argsOk(args), `${context}: ${method} called with ${JSON.stringify(args)}`)
  })
}

/** `<action> may have been applied (the request failed with <reason>). …` — the action may be capitalised. */
function assertMayHaveBeenApplied(text: string, action: string) {
  const expected = `${action} may have been applied (the request failed with `
  assert.ok(text.slice(0, expected.length).toLowerCase() === expected.toLowerCase(), `expected "${text}" to start with "${expected}"`)
}

async function preview(h: Harness, tool: string, args: Record<string, unknown>) {
  const result = await h.call(tool, args)
  assertNotError(result, `${tool} preview`)
  assert.ok(result.structuredContent, `${tool} preview has structuredContent; text: ${textOf(result)}`)
  const sc = structuredOf(result)
  assert.equal(sc.status, 'confirmation_required')
  assert.equal(typeof sc.confirmationToken, 'string')
  return {
    result,
    sc: {
      status: sc.status,
      expiresAt: sc.expiresAt,
      action: structuredString(result, 'action'),
      confirmationToken: structuredString(result, 'confirmationToken'),
    },
  }
}

// ---- §10 item 1: read-only mode ----

describe('tools/list (item 1)', () => {
  test('read-only mode lists exactly 21 tools and none of the 8 action tools', async (t) => {
    const h = await connect(t, { readOnly: true })
    const { tools } = await h.client.listTools()
    const names = tools.map((tool) => tool.name)
    assert.equal(names.length, 21, names.join(', '))
    for (const action of ACTION_TOOLS) assert.ok(!names.includes(action), `${action} is listed in read-only mode`)
    assert.ok(names.includes('pub_points_check_code'), 'check_code stays in read-only mode')
  })

  test('normal mode lists 29 tools including every action tool', async (t) => {
    const h = await connect(t, { readOnly: false })
    const { tools } = await h.client.listTools()
    const names = tools.map((tool) => tool.name)
    assert.equal(names.length, 29, names.join(', '))
    for (const action of ACTION_TOOLS) assert.ok(names.includes(action), `${action} missing`)
  })

  test('no action tool accepts `confirm`; each takes an optional string confirmationToken', async (t) => {
    const h = await connect(t)
    const { tools } = await h.client.listTools()
    for (const name of ACTION_TOOLS) {
      const schema = present(
        tools.find((tool) => tool.name === name),
        name
      ).inputSchema
      assert.ok(!('confirm' in (schema.properties ?? {})), `${name} still has a confirm input`)
      assert.equal(prop(schema.properties?.confirmationToken, 'type'), 'string', `${name} confirmationToken`)
      assert.ok(!(schema.required ?? []).includes('confirmationToken'), `${name} must not require confirmationToken`)
    }
  })

  test('no tool in any mode accepts `confirm`', async (t) => {
    for (const readOnly of [true, false]) {
      const h = await connect(t, { readOnly })
      const { tools } = await h.client.listTools()
      for (const tool of tools) assert.ok(!('confirm' in (tool.inputSchema.properties ?? {})), `${tool.name} (readOnly=${readOnly})`)
    }
  })
})

// ---- §10 item 3: no elicitation, no token -> preview ----

describe('preview without elicitation support (item 3)', () => {
  for (const c of CASES) {
    test(`${c.label}: non-error preview with a token, zero writes`, async (t) => {
      const h = await connect(t)
      const { result, sc } = await preview(h, c.tool, c.args)
      assert.equal(h.fake.writes.length, 0)
      assert.equal(typeof sc.action, 'string')
      assert.ok(sc.action.length > 0)
      if (c.names) assert.ok(sc.action.includes(c.names), `action "${sc.action}" should name ${c.names}`)
      assert.equal(sc.expiresAt, new Date(T0 + FIVE_MINUTES_MS).toISOString())
      assert.equal(
        textOf(result),
        `Confirmation needed: ${sc.action}. Ask the user; if they agree, call ${c.tool} again with the same arguments plus confirmationToken "${sc.confirmationToken}". Expires in 5 minutes.`
      )
    })
  }

  test('two previews of the same call get different tokens', async (t) => {
    const h = await connect(t)
    const first = await preview(h, 'pub_points_redeem_points', { rewardId: 'reward-a' })
    const second = await preview(h, 'pub_points_redeem_points', { rewardId: 'reward-a' })
    assert.notEqual(first.sc.confirmationToken, second.sc.confirmationToken)
    assert.equal(h.fake.writes.length, 0)
  })
})

// ---- §10 item 4: token round trip, single use ----

describe('token round trip (item 4)', () => {
  for (const c of CASES) {
    test(`${c.label}: token performs the write once; reusing it is refused`, async (t) => {
      const h = await connect(t)
      const { sc } = await preview(h, c.tool, c.args)

      const done = await h.call(c.tool, { ...c.args, confirmationToken: sc.confirmationToken })
      assertNotError(done, `${c.tool} confirmed`)
      assert.match(textOf(done), /^Done:/)
      assert.equal(structuredField(done, 'status'), 'done')
      assertWrites(h.fake, c.expectWrites, c.label)

      const again = await h.call(c.tool, { ...c.args, confirmationToken: sc.confirmationToken })
      assert.equal(again.isError, true)
      assert.equal(textOf(again), INVALID_TOKEN_TEXT)
      assertWrites(h.fake, c.expectWrites, `${c.label} after reuse`)
    })
  }

  test('a preference change with an add and a remove makes both writes on one token', async (t) => {
    const h = await connect(t)
    const args = { turnOn: ['push_offers'], turnOff: ['email_news'] }
    const { sc } = await preview(h, 'pub_points_set_communication_preferences', args)
    const done = await h.call('pub_points_set_communication_preferences', { ...args, confirmationToken: sc.confirmationToken })
    assertNotError(done, 'preferences confirmed')
    assert.deepEqual(
      h.fake.writes.map((w) => [w.method, w.args[0]]),
      [
        ['addCommunicationPreference', 'push_offers'],
        ['removeCommunicationPreference', 'pref-1'],
      ]
    )
  })

  test('confirmationToken position among the arguments does not matter', async (t) => {
    const h = await connect(t)
    const { sc } = await preview(h, 'pub_points_redeem_points', { rewardId: 'reward-a' })
    const done = await h.call('pub_points_redeem_points', { confirmationToken: sc.confirmationToken, rewardId: 'reward-a' })
    assertNotError(done, 'token first')
    assert.equal(h.fake.writes.length, 1)
  })

  test('a token that was never issued is refused with no write', async (t) => {
    const h = await connect(t)
    const result = await h.call('pub_points_redeem_points', {
      rewardId: 'reward-a',
      confirmationToken: '00000000-0000-4000-8000-000000000000',
    })
    assert.equal(result.isError, true)
    assert.equal(textOf(result), INVALID_TOKEN_TEXT)
    assert.equal(h.fake.writes.length, 0)
  })

  test('a token issued by another server instance is refused', async (t) => {
    const issuer = await connect(t)
    const { sc } = await preview(issuer, 'pub_points_redeem_points', { rewardId: 'reward-a' })
    const other = await connect(t)
    const result = await other.call('pub_points_redeem_points', { rewardId: 'reward-a', confirmationToken: sc.confirmationToken })
    assert.equal(result.isError, true)
    assert.equal(other.fake.writes.length + issuer.fake.writes.length, 0)
  })
})

// ---- §10 item 5: binding to arguments, tool and state ----

describe('token binding (item 5)', () => {
  test('a token for reward A used with reward B is refused, zero writes', async (t) => {
    const h = await connect(t)
    const { sc } = await preview(h, 'pub_points_redeem_points', { rewardId: 'reward-a' })
    const result = await h.call('pub_points_redeem_points', { rewardId: 'reward-b', confirmationToken: sc.confirmationToken })
    assert.equal(result.isError, true)
    assert.equal(textOf(result), INVALID_TOKEN_TEXT)
    assert.equal(h.fake.writes.length, 0)
  })

  test('a token issued by redeem_code is refused by join_organisation for the same code', async (t) => {
    const h = await connect(t)
    const { sc } = await preview(h, 'pub_points_redeem_code', { code: 'GROUP1' })
    const result = await h.call('pub_points_join_organisation', { code: 'GROUP1', confirmationToken: sc.confirmationToken })
    assert.equal(result.isError, true)
    assert.equal(textOf(result), INVALID_TOKEN_TEXT)
    assert.equal(h.fake.writes.length, 0)
  })

  test('a token for adding venue-1 does not add venue-2', async (t) => {
    const state = defaultState()
    state.favourites = []
    const h = await connect(t, { state })
    const { sc } = await preview(h, 'pub_points_add_favourite_venue', { venueId: 'venue-1' })
    const result = await h.call('pub_points_add_favourite_venue', { venueId: 'venue-2', confirmationToken: sc.confirmationToken })
    assert.equal(result.isError, true)
    assert.equal(h.fake.writes.length, 0)
  })

  /** The arguments stay identical; only the account state behind the fingerprint moves. */
  const STATE_CHANGES: { label: string; tool: string; args: Record<string, unknown>; change: (s: FakeState) => void }[] = [
    {
      label: 'reward costs more points than when previewed',
      tool: 'pub_points_redeem_points',
      args: { rewardId: 'reward-a' },
      change: (s) => {
        nth(s.rates, 0).pointsAmount = 1100
      },
    },
    {
      label: 'reward pays less credit than when previewed',
      tool: 'pub_points_redeem_points',
      args: { rewardId: 'reward-a' },
      change: (s) => {
        nth(s.rates, 0).creditAmount = 900
      },
    },
    {
      label: 'offer value changed since preview',
      tool: 'pub_points_activate_offer',
      args: { offerId: 'offer-inapp' },
      change: (s) => {
        s.offers['offer-inapp'].value = 250
      },
    },
    {
      label: 'offer strategy changed since preview',
      tool: 'pub_points_activate_offer',
      args: { offerId: 'offer-inapp' },
      change: (s) => {
        s.offers['offer-inapp'].strategy = 'points'
      },
    },
    {
      label: 'code now checks as a different type',
      tool: 'pub_points_redeem_code',
      args: { code: 'PROMO1' },
      change: (s) => {
        s.codes.PROMO1 = 'gift_voucher'
      },
    },
    {
      label: 'birthday gift value changed since preview',
      tool: 'pub_points_redeem_birthday_gift',
      args: {},
      change: (s) => {
        present(s.birthday, 'birthday').value = 500
      },
    },
    {
      label: 'the favourite record behind the venue was replaced since preview',
      tool: 'pub_points_remove_favourite_venue',
      args: { venueId: 'venue-2' },
      change: (s) => {
        // same venue, new favourite record: removing it now would delete a record the user never saw
        s.favourites = [{ id: 'fav-10', venue: { id: 'venue-2' } }]
      },
    },
    {
      label: 'preferences changed so the computed change set differs',
      tool: 'pub_points_set_communication_preferences',
      args: { turnOn: ['push_offers'], turnOff: ['email_news'] },
      change: (s) => {
        // email_news is already off now, so only the add remains
        s.preferences = []
      },
    },
  ]

  for (const c of STATE_CHANGES) {
    test(`${c.label}: token refused, zero writes`, async (t) => {
      const h = await connect(t)
      const { sc } = await preview(h, c.tool, c.args)
      c.change(h.state)
      const result = await h.call(c.tool, { ...c.args, confirmationToken: sc.confirmationToken })
      assert.equal(result.isError, true, textOf(result))
      assert.equal(textOf(result), INVALID_TOKEN_TEXT)
      assert.equal(h.fake.writes.length, 0)
    })
  }
})

// ---- §10 item 6: expiry ----

describe('token expiry (item 6)', () => {
  test('a token used 5 minutes and 1 ms after issue is refused, zero writes', async (t) => {
    const clock = manualClock()
    const h = await connect(t, { clock })
    const { sc } = await preview(h, 'pub_points_redeem_points', { rewardId: 'reward-a' })
    clock.advance(FIVE_MINUTES_MS + 1)
    const result = await h.call('pub_points_redeem_points', { rewardId: 'reward-a', confirmationToken: sc.confirmationToken })
    assert.equal(result.isError, true)
    assert.equal(textOf(result), INVALID_TOKEN_TEXT)
    assert.equal(h.fake.writes.length, 0)
  })

  test('a token used 1 ms before expiry still works', async (t) => {
    const clock = manualClock()
    const h = await connect(t, { clock })
    const { sc } = await preview(h, 'pub_points_redeem_points', { rewardId: 'reward-a' })
    clock.advance(FIVE_MINUTES_MS - 1)
    const result = await h.call('pub_points_redeem_points', { rewardId: 'reward-a', confirmationToken: sc.confirmationToken })
    assertNotError(result, 'just before expiry')
    assert.equal(h.fake.writes.length, 1)
  })

  test('the tools use the store passed to registerTools', async (t) => {
    const ConfirmationStore = await loadConfirmationStore()
    const clock = manualClock(T0 + 1234567)
    const store = new ConfirmationStore({ now: clock.now, ttlMs: 61_000 })
    const h = await connect(t, { confirmations: store })
    const { sc } = await preview(h, 'pub_points_redeem_points', { rewardId: 'reward-a' })
    assert.equal(sc.expiresAt, new Date(T0 + 1234567 + 61_000).toISOString())
  })
})

// ---- §10 item 7: elicitation ----

const ACCEPT = (): ElicitResult => ({ action: 'accept', content: { confirm: true } })

describe('elicitation (item 7)', () => {
  for (const c of CASES) {
    test(`${c.label}: accept with confirm=true performs the write once`, async (t) => {
      const h = await connect(t, { elicit: ACCEPT })
      const result = await h.call(c.tool, c.args)
      assertNotError(result, c.label)
      assert.match(textOf(result), /^Done:/)
      assert.equal(structuredField(result, 'status'), 'done')
      assert.equal(h.elicitRequests.length, 1)
      assertWrites(h.fake, c.expectWrites, c.label)
    })
  }

  test('the elicitation names the same action as the preview and asks for a required boolean', async (t) => {
    const previewer = await connect(t)
    const { sc } = await preview(previewer, 'pub_points_redeem_points', { rewardId: 'reward-a' })

    const h = await connect(t, { elicit: ACCEPT })
    await h.call('pub_points_redeem_points', { rewardId: 'reward-a' })
    const request = formParams(h.elicitRequests[0])
    assert.ok(request.message.includes(sc.action), `message "${request.message}" should contain "${sc.action}"`)
    const schema = request.requestedSchema
    const confirm = confirmField(request)
    assert.equal(schema.type, 'object')
    assert.equal(confirm.type, 'boolean')
    assert.equal(confirm.title, 'Confirm')
    assert.equal(confirm.description, sc.action)
    assert.deepEqual(schema.required, ['confirm'])
  })

  const REFUSALS: { label: string; answer: ElicitHandler }[] = [
    { label: 'decline', answer: () => ({ action: 'decline' }) },
    { label: 'cancel', answer: () => ({ action: 'cancel' }) },
    { label: 'accept with confirm=false', answer: () => ({ action: 'accept', content: { confirm: false } }) },
    { label: 'decline that still carries confirm=true', answer: () => ({ action: 'decline', content: { confirm: true } }) },
  ]
  const ELICIT_TOOLS = [
    { tool: 'pub_points_redeem_points', args: { rewardId: 'reward-a' } },
    { tool: 'pub_points_add_favourite_venue', args: { venueId: 'venue-1' } },
  ]

  for (const { label, answer } of REFUSALS) {
    for (const { tool, args } of ELICIT_TOOLS) {
      test(`${tool}: ${label} gives a non-error Cancelled result and zero writes`, async (t) => {
        const h = await connect(t, { elicit: answer })
        const result = await h.call(tool, args)
        assertNotError(result, label)
        assert.equal(h.elicitRequests.length, 1)
        const action = confirmField(h.elicitRequests[0]).description
        assert.equal(textOf(result), `Cancelled: ${action} was not confirmed.`)
        assert.equal(h.fake.writes.length, 0)
      })
    }
  }

  test('state that changes while the question is open is not written, even on accept', async (t) => {
    const state = defaultState()
    const h = await connect(t, {
      state,
      elicit: () => {
        nth(state.rates, 0).pointsAmount = 1100
        return ACCEPT()
      },
    })
    const result = await h.call('pub_points_redeem_points', { rewardId: 'reward-a' })
    assertNotError(result, 'state moved during elicitation')
    assert.equal(h.elicitRequests.length, 1)
    assert.equal(h.fake.writes.length, 0)
    const action = confirmField(h.elicitRequests[0]).description
    assert.equal(textOf(result), `Cancelled: the account changed while waiting for confirmation, so ${action} was not done.`)
  })

  test('an elicitation-capable client is not handed a confirmation token', async (t) => {
    const h = await connect(t, { elicit: () => ({ action: 'decline' }) })
    const result = await h.call('pub_points_redeem_points', { rewardId: 'reward-a' })
    assert.equal(structuredField(result, 'confirmationToken'), undefined)
    assert.ok(!textOf(result).includes('confirmationToken'))
  })
})

// ---- §10 item 8: write outcome reporting ----

describe('write outcome reporting (item 8)', () => {
  for (const c of CASES.filter((x) => x.followUpBalance)) {
    test(`${c.label}: write succeeds, follow-up getBalances throws -> non-error Done with the reason`, async (t) => {
      const state = defaultState()
      state.balancesErrorAfterWrite = new Error('balances endpoint down')
      const h = await connect(t, { state, elicit: ACCEPT })
      const result = await h.call(c.tool, c.args)
      assertNotError(result, c.label)
      const text = textOf(result)
      assert.match(text, /^Done:/)
      assert.ok(text.includes('(Balance unavailable: balances endpoint down)'), text)
      assert.equal(h.fake.writes.length, 1)
    })
  }

  const UNCERTAIN_FAILURES = [
    { label: 'network error', error: () => new TypeError('fetch failed') },
    { label: 'timeout', error: () => new DOMException('The operation was aborted due to timeout', 'TimeoutError') },
    { label: 'abort', error: () => new DOMException('This operation was aborted', 'AbortError') },
    { label: 'HTTP 503', error: () => new ApiError('Service Unavailable (HTTP 503 on POST /x)', 503) },
    { label: 'HTTP 500', error: () => new ApiError('Internal Server Error (HTTP 500 on POST /x)', 500) },
  ]

  for (const failure of UNCERTAIN_FAILURES) {
    test(`redeem points: ${failure.label} on the write -> isError "may have been applied"`, async (t) => {
      const state = defaultState()
      state.writeErrors.redeemPoints = failure.error()
      const h = await connect(t, { state, elicit: ACCEPT })
      const result = await h.call('pub_points_redeem_points', { rewardId: 'reward-a' })
      assert.equal(result.isError, true)
      const text = textOf(result)
      const action = confirmField(h.elicitRequests[0]).description
      assertMayHaveBeenApplied(text, action)
      assert.ok(text.endsWith('Check with pub_points_summary before trying again.'), text)
    })
  }

  for (const c of CASES) {
    test(`${c.label}: a network failure on the write points at ${c.readTool}`, async (t) => {
      const state = defaultState()
      state.writeErrors[nth(c.expectWrites, 0)[0]] = new TypeError('fetch failed')
      const h = await connect(t, { state, elicit: ACCEPT })
      const result = await h.call(c.tool, c.args)
      assert.equal(result.isError, true)
      const text = textOf(result)
      const action = confirmField(h.elicitRequests[0]).description
      assertMayHaveBeenApplied(text, action)
      assert.ok(text.endsWith(`Check with ${c.readTool} before trying again.`), text)
    })
  }

  test('redeem points: HTTP 4xx on the write -> isError with the API message, not "may have been applied"', async (t) => {
    const state = defaultState()
    state.writeErrors.redeemPoints = new ApiError('Not enough points (HTTP 422 on POST /points-redemptions)', 422)
    const h = await connect(t, { state, elicit: ACCEPT })
    const result = await h.call('pub_points_redeem_points', { rewardId: 'reward-a' })
    assert.equal(result.isError, true)
    const text = textOf(result)
    assert.ok(text.includes('Not enough points'), text)
    assert.ok(!text.includes('may have been applied'), text)
  })
})

// ---- §10 item 9: validation refusals ----

describe('validation refusals (item 9)', () => {
  const REFUSALS = [
    { label: 'insufficient points', tool: 'pub_points_redeem_points', args: { rewardId: 'reward-c' } },
    { label: 'auto-activating offer', tool: 'pub_points_activate_offer', args: { offerId: 'offer-auto' } },
    { label: 'gift voucher sent to the join tool', tool: 'pub_points_join_organisation', args: { code: 'GIFT123' } },
    { label: 'promo code sent to the join tool', tool: 'pub_points_join_organisation', args: { code: 'PROMO1' } },
  ]

  async function spyStore() {
    const ConfirmationStore = await loadConfirmationStore()
    class SpyStore extends ConfirmationStore {
      issued: ConfirmationBinding[] = []
      override issue(binding: ConfirmationBinding) {
        this.issued.push(binding)
        return super.issue(binding)
      }
    }
    return new SpyStore({ now: manualClock().now })
  }

  for (const r of REFUSALS) {
    test(`${r.label}: error, zero writes, no token issued`, async (t) => {
      const store = await spyStore()
      const h = await connect(t, { confirmations: store })
      const result = await h.call(r.tool, r.args)
      assert.equal(result.isError, true, textOf(result))
      assert.equal(h.fake.writes.length, 0)
      assert.equal(store.issued.length, 0)
      assert.equal(structuredField(result, 'confirmationToken'), undefined)
      assert.ok(!textOf(result).includes('confirmationToken "'), textOf(result))
    })

    test(`${r.label}: an elicitation-capable client is never asked`, async (t) => {
      const h = await connect(t, { elicit: ACCEPT })
      const result = await h.call(r.tool, r.args)
      assert.equal(result.isError, true, textOf(result))
      assert.equal(h.elicitRequests.length, 0)
      assert.equal(h.fake.writes.length, 0)
    })
  }

  test('a valid token does not bypass a refusal when the balance has since dropped', async (t) => {
    const h = await connect(t)
    const { sc } = await preview(h, 'pub_points_redeem_points', { rewardId: 'reward-a' })
    h.state.balances.pointsBalance = 500
    const result = await h.call('pub_points_redeem_points', { rewardId: 'reward-a', confirmationToken: sc.confirmationToken })
    assert.equal(result.isError, true)
    assert.equal(h.fake.writes.length, 0)
  })

  test('a valid token does not bypass a refusal when the offer has since ended', async (t) => {
    const h = await connect(t)
    const { sc } = await preview(h, 'pub_points_activate_offer', { offerId: 'offer-inapp' })
    h.state.offers['offer-inapp'].endAt = '2020-01-01T00:00:00Z'
    const result = await h.call('pub_points_activate_offer', { offerId: 'offer-inapp', confirmationToken: sc.confirmationToken })
    assert.equal(result.isError, true)
    assert.equal(h.fake.writes.length, 0)
  })
})
