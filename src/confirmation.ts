// SPDX-License-Identifier: GPL-3.0-or-later
// Single-use confirmation tokens for clients that cannot ask the user themselves (no MCP
// elicitation). A token is bound to the tool, its exact arguments and a fingerprint of the
// account state the preview described, so it cannot approve a different or changed action.

import { randomBytes } from 'node:crypto'

export const CONFIRMATION_TTL_MS = 300_000

/**
 * How long the user has to answer an elicitation, on either protocol: the 2025 wait for the
 * client's reply and the life of a 2026 question's requestState are both this long.
 */
export const QUESTION_TTL_MS = 600_000

/** 32 random bytes, hex encoded: well above the 128 bits the token needs. */
const TOKEN_BYTES = 32

export interface ConfirmationBinding {
  tool: string
  args: Record<string, unknown>
  fingerprint: string
}

export interface ConfirmationStoreOptions {
  now?: () => number
  ttlMs?: number
}

interface Issued {
  key: string
  /** Tool and arguments only, so `consumeForRequest` can tell a state change from a stranger. */
  requestKey: string
  fingerprint: string
  /** Text the server stored with the entry (the action an elicitation asked about); null if none. */
  action: string | null
  expiresAt: number
  used: boolean
}

/** JSON with object keys sorted at every depth, so argument order never changes the binding. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(Reflect.get(value, key))
    return out
  }
  return value
}

function requestKey(tool: string, args: Record<string, unknown>): string {
  return canonicalJson({ tool, args })
}

function bindingKey(binding: ConfirmationBinding): string {
  return canonicalJson({ tool: binding.tool, args: binding.args, fingerprint: binding.fingerprint })
}

export class ConfirmationStore {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly tokens = new Map<string, Issued>()

  constructor(options: ConfirmationStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? CONFIRMATION_TTL_MS
  }

  /**
   * `ttlMs` overrides the store's lifetime for this one entry (elicitation questions use
   * QUESTION_TTL_MS). `action` is server-side text kept with the entry and returned by
   * `consumeForRequest`; it never leaves the server.
   */
  issue(binding: ConfirmationBinding, ttlMs: number = this.ttlMs, action: string | null = null): { token: string; expiresAt: string } {
    this.prune()
    const token = randomBytes(TOKEN_BYTES).toString('hex')
    const expiresAt = this.now() + ttlMs
    this.tokens.set(token, {
      key: bindingKey(binding),
      requestKey: requestKey(binding.tool, binding.args),
      fingerprint: binding.fingerprint,
      action,
      expiresAt,
      used: false,
    })
    return { token, expiresAt: new Date(expiresAt).toISOString() }
  }

  /** True only for a live, unused token issued for this exact binding; a true answer uses it up. */
  consume(token: string, binding: ConfirmationBinding): boolean {
    const issued = this.tokens.get(token)
    if (!issued || issued.used || this.now() >= issued.expiresAt) return false
    if (issued.key !== bindingKey(binding)) return false
    issued.used = true
    return true
  }

  /**
   * For a live, unused token issued for this tool and these arguments, uses it up and returns
   * the state fingerprint it was bound to; null (and nothing used) for anything else. Lets the
   * caller tell "the account changed since the question" from an unknown or forged token.
   */
  consumeForRequest(token: string, tool: string, args: Record<string, unknown>): { fingerprint: string; action: string | null } | null {
    const issued = this.tokens.get(token)
    if (!issued || issued.used || this.now() >= issued.expiresAt) return null
    if (issued.requestKey !== requestKey(tool, args)) return null
    issued.used = true
    return { fingerprint: issued.fingerprint, action: issued.action }
  }

  private prune(): void {
    const now = this.now()
    for (const [token, issued] of this.tokens) {
      if (issued.used || now >= issued.expiresAt) this.tokens.delete(token)
    }
  }
}
