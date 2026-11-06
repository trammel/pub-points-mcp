// SPDX-License-Identifier: GPL-3.0-or-later
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import type { Location } from './api.js'

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true } as const

/** Changes account state (activates, redeems, joins). Not reversible from this server. */
export const WRITE = { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false } as const

/** Changes a setting that can be flipped back. */
export const SETTING = { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: true } as const

/** API record ids: letters, digits and dashes only, so an id can never reshape a request path or IRI. */
export const idField = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'Expected an id: 1 to 64 letters, digits or dashes')

/** Codes are trimmed and upper-cased first, then must be 1 to 32 letters or digits. */
export const codeField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Za-z0-9]{1,32}$/, 'Expected a code: 1 to 32 letters or digits')

export const locationShape = {
  latitude: z.number().min(-90).max(90).optional().describe('Latitude, to include location-limited offers'),
  longitude: z.number().min(-180).max(180).optional().describe('Longitude, to include location-limited offers'),
}

export function toLocation(args: { latitude?: number | undefined; longitude?: number | undefined }): Location | undefined {
  return args.latitude !== undefined && args.longitude !== undefined ? { latitude: args.latitude, longitude: args.longitude } : undefined
}

export type ToolResult = CallToolResult | InputRequiredResult

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function text(lines: string[]): CallToolResult {
  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

/** Text for people and models that read content, plus the same answer as data for clients that read structuredContent. */
export function structured(lines: string[], data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: data }
}

export function errorText(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: errorMessage(err) }] }
}

/**
 * The one place a tool handler's failures become results: any throw becomes `isError` text.
 * Hands the handler the request's cancellation signal, which every client call takes.
 */
export function handle<A>(
  fn: (args: A, signal: AbortSignal, ctx: ServerContext) => Promise<ToolResult>
): (args: A, ctx: ServerContext) => Promise<ToolResult> {
  return async (args, ctx) => {
    try {
      return await fn(args, ctx.mcpReq.signal, ctx)
    } catch (err) {
      return errorText(err)
    }
  }
}

export function section<T>(title: string, result: PromiseSettledResult<T>, render: (value: T) => string[]): string[] {
  if (result.status === 'rejected') return [`## ${title}`, `(unavailable: ${errorMessage(result.reason)})`, '']
  const body = render(result.value)
  return [`## ${title}`, ...(body.length ? body : ['(none)']), '']
}

/** Settles `fn(item)` for every item with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results = new Map<number, PromiseSettledResult<R>>()
  // One iterator shared by every worker: each pulls the next unclaimed item.
  const queue = items.entries()
  async function worker(): Promise<void> {
    for (const [index, item] of queue) {
      try {
        results.set(index, { status: 'fulfilled', value: await fn(item) })
      } catch (reason) {
        results.set(index, { status: 'rejected', reason })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return items.map((_, index) => results.get(index) ?? { status: 'rejected', reason: new Error('not run') })
}

/** Note shown in place of venue names when the Algolia lookup failed, so a missing name is never silent. */
export function venueNamesNote(failure: unknown): string {
  return `(venue names unavailable: ${errorMessage(failure)})`
}
