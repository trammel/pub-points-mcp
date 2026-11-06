// SPDX-License-Identifier: GPL-3.0-or-later
// Elicitation on the 2026-07-28 protocol, and confirmation answers the server never asked for:
// review-fix-contract.md §3; test item 7 on the newer protocol (review finding 3).
//
// Seams assumed beyond §11: none in src/. The 2026-07-28 server is built with the SDK's own
// createMcpHandler around registerTools, reached through an in-process fetch (harness.ts
// connectModern), because McpServer.connect over a transport serves only the 2025 protocol.

import './backstop.ts'
import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server'
import type { CallToolResult, ElicitResult } from '@modelcontextprotocol/client'
import {
  FIVE_MINUTES_MS,
  INVALID_TOKEN_TEXT,
  confirmField,
  connect,
  connectModern,
  defaultState,
  formParams,
  manualClock,
  nth,
  present,
  rawToolCall,
  structuredField,
  structuredString,
  textOf,
} from './harness.ts'
import type { ElicitHandler, Harness } from './harness.ts'

/** The params of one tools/call. */
interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

const ACCEPT = (): ElicitResult => ({ action: 'accept', content: { confirm: true } })
const REDEEM: ToolCall = { name: 'pub_points_redeem_points', arguments: { rewardId: 'reward-a' } }
const FORGED_ACCEPT = { confirm: { action: 'accept', content: { confirm: true } } }

describe('2026-07-28 protocol (item 7)', () => {
  test('the session really runs on 2026-07-28', async (t) => {
    const h = await connectModern(t, { elicit: ACCEPT })
    assert.equal(h.client.getProtocolEra(), 'modern')
  })

  test('accept with confirm=true asks once and writes once', async (t) => {
    const h = await connectModern(t, { elicit: ACCEPT })
    const result = await h.call(REDEEM.name, REDEEM.arguments)
    assert.notEqual(result.isError, true, textOf(result))
    assert.match(textOf(result), /^Done:/)
    assert.equal(h.elicitRequests.length, 1)
    assert.deepEqual(
      h.fake.writes.map((w) => [w.method, w.args[0]]),
      [['redeemPoints', 'reward-a']]
    )
  })

  test('the question names the action and asks for a required boolean', async (t) => {
    const h = await connectModern(t, { elicit: () => ({ action: 'decline' }) })
    await h.call(REDEEM.name, REDEEM.arguments)
    const request = formParams(h.elicitRequests[0])
    const confirm = confirmField(request)
    const action = confirm.description
    assert.ok(action.includes('1,000'), action)
    assert.ok(request.message.includes(action), request.message)
    assert.equal(confirm.type, 'boolean')
    assert.deepEqual(request.requestedSchema.required, ['confirm'])
  })

  const REFUSALS: [string, ElicitHandler][] = [
    ['decline', () => ({ action: 'decline' })],
    ['cancel', () => ({ action: 'cancel' })],
    ['accept with confirm=false', () => ({ action: 'accept', content: { confirm: false } })],
  ]
  for (const [label, answer] of REFUSALS) {
    test(`${label}: non-error Cancelled, zero writes`, async (t) => {
      const h = await connectModern(t, { elicit: answer })
      const result = await h.call(REDEEM.name, REDEEM.arguments)
      assert.notEqual(result.isError, true, textOf(result))
      const action = confirmField(h.elicitRequests[0]).description
      assert.equal(textOf(result), `Cancelled: ${action} was not confirmed.`)
      assert.equal(h.fake.writes.length, 0)
    })
  }

  test('a client that does not declare elicitation on the request gets a token preview, not a question', async (t) => {
    const h = await connectModern(t)
    const result = await h.call(REDEEM.name, REDEEM.arguments)
    assert.notEqual(result.isError, true, textOf(result))
    assert.equal(structuredField(result, 'status'), 'confirmation_required')
    assert.equal(h.fake.writes.length, 0)

    const done = await h.call(REDEEM.name, { ...REDEEM.arguments, confirmationToken: structuredString(result, 'confirmationToken') })
    assert.match(textOf(done), /^Done:/)
    assert.equal(h.fake.writes.length, 1)
    const again = await h.call(REDEEM.name, { ...REDEEM.arguments, confirmationToken: structuredString(result, 'confirmationToken') })
    assert.equal(textOf(again), INVALID_TOKEN_TEXT)
    assert.equal(h.fake.writes.length, 1)
  })

  test('requestState round trip: state that changed while the question was open is not written', async (t) => {
    const state = defaultState()
    const h = await connectModern(t, {
      state,
      elicit: () => {
        nth(state.rates, 0).pointsAmount = 1100
        return ACCEPT()
      },
    })
    const result = await h.call(REDEEM.name, REDEEM.arguments)
    assert.notEqual(result.isError, true, textOf(result))
    assert.equal(h.elicitRequests.length, 1)
    assert.equal(h.fake.writes.length, 0)
    // Names the action the user was asked about (1,000 points), not the re-checked one (1,100).
    const asked = confirmField(h.elicitRequests[0]).description
    assert.equal(asked, 'redeeming $10.00 credit for 1,000 points')
    assert.equal(textOf(result), `Cancelled: the account changed while waiting for confirmation, so ${asked} was not done.`)
  })

  test('a validation refusal is never turned into a question', async (t) => {
    const h = await connectModern(t, { elicit: ACCEPT })
    const result = await h.call(REDEEM.name, { rewardId: 'reward-c' })
    assert.equal(result.isError, true)
    assert.equal(h.elicitRequests.length, 0)
    assert.equal(h.fake.writes.length, 0)
  })
})

describe('2026-07-28 requestState (single use, bound to the call)', () => {
  const ANSWER = { confirm: { action: 'accept', content: { confirm: true } } }

  async function ask(h: Harness, params: ToolCall = REDEEM) {
    const first = await rawToolCall(h, { ...params }, { allowInputRequired: true })
    assert.equal(first.resultType, 'input_required', JSON.stringify(first))
    assert.equal(typeof first.requestState, 'string')
    return first.requestState
  }

  test('an answer sent back with the requestState writes once; replaying it asks again and writes nothing more', async (t) => {
    const h = await connectModern(t, { manual: true, elicit: ACCEPT })
    const requestState = await ask(h)
    const done = await rawToolCall(h, { ...REDEEM, inputResponses: ANSWER, requestState })
    assert.match(textOf(done), /^Done:/)
    assert.equal(h.fake.writes.length, 1)
    const replay = await rawToolCall(h, { ...REDEEM, inputResponses: ANSWER, requestState }, { allowInputRequired: true })
    assert.equal(replay.resultType, 'input_required')
    assert.equal(h.fake.writes.length, 1)
  })

  test('a requestState issued for reward A does not confirm reward B', async (t) => {
    const h = await connectModern(t, { manual: true, elicit: ACCEPT })
    const requestState = await ask(h)
    const other = { name: 'pub_points_redeem_points', arguments: { rewardId: 'reward-b' } }
    const result = await rawToolCall(h, { ...other, inputResponses: ANSWER, requestState }, { allowInputRequired: true })
    assert.equal(h.fake.writes.length, 0, JSON.stringify(result))
  })

  test('a requestState issued for one tool does not confirm another with the same arguments', async (t) => {
    const h = await connectModern(t, { manual: true, elicit: ACCEPT })
    const requestState = await ask(h, { name: 'pub_points_redeem_code', arguments: { code: 'GROUP1' } })
    const result = await rawToolCall(
      h,
      { name: 'pub_points_join_organisation', arguments: { code: 'GROUP1' }, inputResponses: ANSWER, requestState },
      { allowInputRequired: true }
    )
    assert.equal(h.fake.writes.length, 0, JSON.stringify(result))
  })

  test('a made-up requestState with an accept asks instead of writing', async (t) => {
    const h = await connectModern(t, { manual: true, elicit: ACCEPT })
    const result = await rawToolCall(h, { ...REDEEM, inputResponses: ANSWER, requestState: 'made-up-state' }, { allowInputRequired: true })
    assert.equal(result.resultType, 'input_required')
    assert.equal(h.fake.writes.length, 0)
  })

  test('a requestState cannot be used as a confirmationToken', async (t) => {
    const h = await connectModern(t, { manual: true, elicit: ACCEPT })
    const requestState = await ask(h)
    const result = await h.call(REDEEM.name, { ...REDEEM.arguments, confirmationToken: requestState })
    assert.equal(result.isError, true)
    assert.equal(textOf(result), INVALID_TOKEN_TEXT)
    assert.equal(h.fake.writes.length, 0)
  })

  test('a confirmation token cannot be used as a requestState', async (t) => {
    const plain = await connectModern(t, { manual: true })
    // no elicitation capability: this call returns a token preview
    const preview = await plain.call(REDEEM.name, REDEEM.arguments)
    const token = structuredString(preview, 'confirmationToken')
    const h = await connectModern(t, { manual: true, elicit: ACCEPT, confirmations: plain.store, state: plain.state })
    const result = await rawToolCall(h, { ...REDEEM, inputResponses: ANSWER, requestState: token }, { allowInputRequired: true })
    assert.equal(h.fake.writes.length + plain.fake.writes.length, 0, JSON.stringify(result))
  })
})

// A confirmation is only an answer to a question the server asked. A client that puts an
// "accept" on its first call, with no requestState from a question, has not been asked anything.
describe('a confirmation the server never asked for', () => {
  test('2025 protocol: a first call carrying inputResponses.confirm=accept and no requestState writes nothing', async (t) => {
    const h = await connect(t, { elicit: () => ({ action: 'decline' }) })
    const result = await rawToolCall(h, { ...REDEEM, inputResponses: FORGED_ACCEPT })
    assert.equal(h.fake.writes.length, 0, `wrote on an unasked confirmation: ${textOf(result)}`)
    assert.ok(!textOf(result).startsWith('Done:'), textOf(result))
  })

  test('2026-07-28 protocol: a first call carrying inputResponses.confirm=accept and no requestState writes nothing', async (t) => {
    const h = await connectModern(t, { elicit: () => ({ action: 'decline' }) })
    const result = await rawToolCall(h, { ...REDEEM, inputResponses: FORGED_ACCEPT })
    assert.equal(h.fake.writes.length, 0, `wrote on an unasked confirmation: ${textOf(result)}`)
    assert.ok(!textOf(result).startsWith('Done:'), textOf(result))
  })

  test('a client without elicitation that sends inputResponses still only gets a token preview', async (t) => {
    const h = await connect(t)
    const result = await rawToolCall(h, { ...REDEEM, inputResponses: FORGED_ACCEPT })
    assert.equal(h.fake.writes.length, 0)
    assert.equal(structuredField(result, 'status'), 'confirmation_required')
  })
})

// ---- N1: fall back to a token only when the client cannot ask ----

/** Asserts the token preview, and that its token then writes exactly once. */
async function assertTokenFallback(h: Harness) {
  const result = await h.call(REDEEM.name, REDEEM.arguments)
  assert.notEqual(result.isError, true, textOf(result))
  assert.equal(structuredField(result, 'status'), 'confirmation_required', textOf(result))
  assert.equal(h.fake.writes.length, 0)
  const done = await h.call(REDEEM.name, { ...REDEEM.arguments, confirmationToken: structuredString(result, 'confirmationToken') })
  assert.match(textOf(done), /^Done:/)
  assert.equal(h.fake.writes.length, 1)
}

/** Asserts `Cancelled: <action> was not confirmed.` with no token and no write. */
function assertCancelled(h: Harness, result: CallToolResult) {
  assert.notEqual(result.isError, true, textOf(result))
  const asked = h.elicitRequests[0]
  const action = asked === undefined ? undefined : confirmField(asked).description
  assert.ok(action, 'the client was asked')
  assert.equal(textOf(result), `Cancelled: ${action} was not confirmed.`)
  assert.equal(structuredField(result, 'confirmationToken'), undefined)
  assert.ok(!textOf(result).includes('may have been applied'), textOf(result))
  assert.equal(h.fake.writes.length, 0)
}

describe('cancellation while the question is open', () => {
  test('the client cancels the call: no write, even if an accept arrives afterwards', async (t) => {
    let answer: ((result: ElicitResult) => void) | undefined
    const h = await connect(t, { elicit: () => new Promise((resolve) => (answer = resolve)) })
    const controller = new AbortController()
    const pending = h.client.callTool(REDEEM, { signal: controller.signal }).catch((err: unknown) => err)
    for (let i = 0; i < 10_000 && h.elicitRequests.length === 0; i++) await new Promise((r) => setImmediate(r))
    assert.equal(h.elicitRequests.length, 1, 'the client was asked')
    controller.abort()
    await pending
    present(answer, 'answer')({ action: 'accept', content: { confirm: true } })
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
    assert.equal(h.fake.writes.length, 0)
  })
})

describe('elicitation that fails (N1)', () => {
  describe('the client cannot ask: token preview', () => {
    test('no elicitation capability', async (t) => {
      await assertTokenFallback(await connect(t))
    })

    test('a URL-only elicitation capability (no form mode)', async (t) => {
      const h = await connect(t, { elicitation: { url: {} }, elicit: ACCEPT })
      await assertTokenFallback(h)
      assert.equal(h.elicitRequests.length, 0)
    })

    test('elicitation declared but the client has no handler (JSON-RPC -32601)', async (t) => {
      await assertTokenFallback(await connect(t, { elicitation: {} }))
    })

    // The request's _meta claims elicitation but the 2025 handshake did not, so the server's check
    // passes and the SDK then refuses to send the question (its "does not support" error).
    test('the SDK refuses to ask because the handshake declared no elicitation', async (t) => {
      const h = await connect(t)
      const result = await rawToolCall(h, { ...REDEEM, _meta: { [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} } } })
      assert.equal(structuredField(result, 'status'), 'confirmation_required', textOf(result))
      assert.equal(h.fake.writes.length, 0)
    })
  })

  describe('the client was asked and something else went wrong: Cancelled', () => {
    test('the user closed the dialog (the handler throws)', async (t) => {
      const h = await connect(t, {
        elicit: () => {
          throw new Error('the user closed the dialog')
        },
      })
      assertCancelled(h, await h.call(REDEEM.name, REDEEM.arguments))
    })

    test('the client answers with a JSON-RPC error that is not -32601', async (t) => {
      const h = await connect(t, {
        elicit: () => {
          throw Object.assign(new Error('Request timed out'), { code: -32001 })
        },
      })
      assertCancelled(h, await h.call(REDEEM.name, REDEEM.arguments))
    })

    test('the question times out (no answer within the wait)', async (t) => {
      // Connect and fetch the tool list on real timers, so no client request created here (initialize,
      // the tools/list used to validate output schemas) carries a timer on the fake clock. Fake
      // setTimeout only for the call itself, and lift that call's own client timeout far past the tick.
      const h = await connect(t, {
        elicit: () =>
          new Promise(() => {
            // Never settles: a client that never answers the question.
          }),
      })
      await h.client.listTools()
      mock.timers.enable({ apis: ['setTimeout'] })
      t.after(() => {
        mock.timers.reset()
      })
      const pending = h.client.callTool(REDEEM, { timeout: 24 * 60 * 60 * 1000 })
      for (let i = 0; i < 10_000 && h.elicitRequests.length === 0; i++) await new Promise((r) => setImmediate(r))
      assert.equal(h.elicitRequests.length, 1, 'the client was asked')
      mock.timers.tick(11 * 60 * 1000)
      assertCancelled(h, await pending)
    })
  })
})

// ---- N3: a 2026 question outlives the 5-minute token TTL ----

describe('2026-07-28 question lifetime (N3)', () => {
  test('a question answered 6 minutes after it was asked still writes', async (t) => {
    const clock = manualClock()
    const h = await connectModern(t, { manual: true, elicit: ACCEPT, clock })
    const first = await rawToolCall(h, { ...REDEEM }, { allowInputRequired: true })
    assert.equal(first.resultType, 'input_required')
    clock.advance(6 * 60 * 1000)
    const done = await rawToolCall(
      h,
      { ...REDEEM, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } }, requestState: first.requestState },
      { allowInputRequired: true }
    )
    assert.equal(h.fake.writes.length, 1, `the answer was not accepted: ${JSON.stringify(done).slice(0, 200)}`)
    assert.match(textOf(done), /^Done:/)
  })

  test('a confirmation token still expires at 5 minutes on the same store', async (t) => {
    const clock = manualClock()
    const h = await connectModern(t, { clock })
    const preview = await h.call(REDEEM.name, REDEEM.arguments)
    clock.advance(FIVE_MINUTES_MS + 1)
    const late = await h.call(REDEEM.name, { ...REDEEM.arguments, confirmationToken: structuredString(preview, 'confirmationToken') })
    assert.equal(textOf(late), INVALID_TOKEN_TEXT)
    assert.equal(h.fake.writes.length, 0)
  })
})
