// SPDX-License-Identifier: GPL-3.0-or-later
// ConfirmationStore: review-fix-contract.md §3 token rules and the §11 seam; supports items 4–6.
// Seams assumed beyond §11: none.

import './backstop.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConfirmationStoreOptions } from '../dist/confirmation.js'
import { FIVE_MINUTES_MS, T0, loadConfirmationStore, manualClock } from './harness.ts'

const BINDING = { tool: 'pub_points_redeem_points', args: { rewardId: 'reward-a' }, fingerprint: 'reward-a|1000|1000' }

async function store(options?: ConfirmationStoreOptions) {
  const ConfirmationStore = await loadConfirmationStore()
  return new ConfirmationStore(options)
}

test('issue returns a token and an ISO expiry 5 minutes after the injected now', async () => {
  const s = await store({ now: () => T0 })
  const { token, expiresAt } = s.issue(BINDING)
  assert.equal(typeof token, 'string')
  assert.equal(expiresAt, '2026-11-05T01:05:00.000Z')
})

test('ttlMs overrides the 5-minute default', async () => {
  const s = await store({ now: () => T0, ttlMs: 61_000 })
  assert.equal(s.issue(BINDING).expiresAt, '2026-11-05T01:01:01.000Z')
})

test('the default clock is the real clock', async () => {
  const before = Date.now()
  const s = await store()
  const expires = Date.parse(s.issue(BINDING).expiresAt)
  const after = Date.now()
  assert.ok(
    expires >= before + FIVE_MINUTES_MS && expires <= after + FIVE_MINUTES_MS,
    `${expires} not within [${before}, ${after}] + 5 min`
  )
})

/** Bits a token can carry, from its character set: hex is 4 bits a character, base64url 6. */
function tokenBits(token: string) {
  // A v4 UUID is 122 random bits whatever its length
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) return 122
  if (/^[0-9a-f]+$/.test(token) || /^[0-9A-F]+$/.test(token)) return token.length * 4
  if (/^[A-Za-z0-9_-]+$/.test(token)) return token.length * 6
  return 0
}

test('tokens are distinct and carry at least 128 bits in hex or base64url', async () => {
  const s = await store({ now: () => T0 })
  const tokens = new Set<string>()
  for (let i = 0; i < 200; i++) tokens.add(s.issue(BINDING).token)
  assert.equal(tokens.size, 200)
  for (const token of tokens) assert.ok(tokenBits(token) >= 128, `${token} carries ${tokenBits(token)} bits`)
})

test('the bit count rejects short and non-alphabet tokens', () => {
  assert.equal(tokenBits('0123456789abcdef0123456789abcdef'), 128)
  assert.ok(tokenBits('0123456789abcdef012345') < 128, '22 hex characters are 88 bits')
  assert.equal(tokenBits('not a token!'), 0)
  assert.equal(tokenBits('3b241101-e2bb-4255-8caf-4136c566a962'), 122)
})

test('consume is true once for a matching binding, then false', async () => {
  const s = await store({ now: () => T0 })
  const { token } = s.issue(BINDING)
  assert.equal(s.consume(token, structuredClone(BINDING)), true)
  assert.equal(s.consume(token, structuredClone(BINDING)), false)
})

test('consume is false for an unknown token and for an empty string', async () => {
  const s = await store({ now: () => T0 })
  s.issue(BINDING)
  assert.equal(s.consume('not-a-token', BINDING), false)
  assert.equal(s.consume('', BINDING), false)
})

const MISMATCHES = [
  { label: 'another tool', binding: { ...BINDING, tool: 'pub_points_redeem_code' } },
  { label: 'another argument value', binding: { ...BINDING, args: { rewardId: 'reward-b' } } },
  { label: 'an extra argument', binding: { ...BINDING, args: { rewardId: 'reward-a', extra: 1 } } },
  { label: 'a missing argument', binding: { ...BINDING, args: {} } },
  { label: 'another fingerprint', binding: { ...BINDING, fingerprint: 'reward-a|1100|1000' } },
  { label: 'a number where a string was', binding: { ...BINDING, args: { rewardId: 1 } } },
]

for (const m of MISMATCHES) {
  test(`consume is false for ${m.label}`, async () => {
    const s = await store({ now: () => T0 })
    const { token } = s.issue(BINDING)
    assert.equal(s.consume(token, m.binding), false)
  })
}

test('argument key order does not change the binding (canonical JSON)', async () => {
  const s = await store({ now: () => T0 })
  const { token } = s.issue({
    tool: 'pub_points_set_communication_preferences',
    args: { turnOn: ['push_offers'], turnOff: ['email_news'], nested: { a: 1, b: 2 } },
    fingerprint: 'f',
  })
  assert.equal(
    s.consume(token, {
      tool: 'pub_points_set_communication_preferences',
      args: { nested: { b: 2, a: 1 }, turnOff: ['email_news'], turnOn: ['push_offers'] },
      fingerprint: 'f',
    }),
    true
  )
})

test('a token is live 1 ms before expiry and dead 1 ms after', async () => {
  const early = manualClock()
  const s1 = await store({ now: early.now })
  const t1 = s1.issue(BINDING).token
  early.advance(FIVE_MINUTES_MS - 1)
  assert.equal(s1.consume(t1, BINDING), true)

  const late = manualClock()
  const s2 = await store({ now: late.now })
  const t2 = s2.issue(BINDING).token
  late.advance(FIVE_MINUTES_MS + 1)
  assert.equal(s2.consume(t2, BINDING), false)
})

test('tokens from one store are unknown to another', async () => {
  const a = await store({ now: () => T0 })
  const b = await store({ now: () => T0 })
  const { token } = a.issue(BINDING)
  assert.equal(b.consume(token, BINDING), false)
  assert.equal(a.consume(token, BINDING), true)
})
