// SPDX-License-Identifier: GPL-3.0-or-later
// How an account-changing tool gets the user's yes. The tool first checks the request against
// account state and builds an ActionPlan; this module then either asks the user through MCP
// elicitation (when the client supports it) or returns a preview with a single-use token that
// the next call must carry. Nothing is written until one of those confirms this exact plan.

import {
  CLIENT_CAPABILITIES_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { ApiError, ResponseShapeError } from './api.js'
import { AuthError } from './auth.js'
import { REQUEST_TIMEOUT_MS } from './config.js'
import { CONFIRMATION_TTL_MS, QUESTION_TTL_MS, type ConfirmationBinding, type ConfirmationStore } from './confirmation.js'
import { errorMessage, errorText, structured, type ToolResult } from './tool-helpers.js'

const ACTION_STATUSES = ['confirmation_required', 'done', 'cancelled', 'unchanged'] as const

/**
 * One object schema for every action-tool outcome. A union root would be wrapped as
 * `{ result: … }` on 2025-era connections, so the status-specific fields are optional here
 * and `status` says which are present.
 */
export const ActionOutputSchema = z.object({
  status: z.enum(ACTION_STATUSES),
  action: z.string().describe('The action, as the user was asked to confirm it, or why nothing was needed'),
  detail: z.string().optional().describe('What was done (status done)'),
  confirmationToken: z.string().optional().describe('Pass back as confirmationToken once the user agrees (status confirmation_required)'),
  expiresAt: z.string().optional().describe('ISO time the confirmation token expires (status confirmation_required)'),
})

export const confirmationTokenField = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe('Only after the user has agreed to the action a previous call described: the token that call returned.')

const INVALID_TOKEN_TEXT =
  'Confirmation token is invalid, expired or does not match these arguments. Call again without confirmationToken for a new confirmation.'

const CONFIRM_KEY = 'confirm'

/**
 * Marks the store entries issued as elicitation requestState, so one can never be replayed as a
 * confirmationToken (which needs no user answer) or the other way round.
 */
const ELICITATION_PURPOSE = 'elicitation'

interface ActionOutcome {
  /** What happened, without the "Done: " prefix or a trailing full stop. */
  summary: string
  /** A read after the write (balances); its failure is reported but never turns the result into an error. */
  followUp: ((signal: AbortSignal) => Promise<string[]>) | null
}

export interface ActionPlan {
  /** The exact action the user is asked to confirm, e.g. `redeeming $10.00 credit for 1,000 points`. */
  action: string
  /** The account state the action was checked against; a token only works while it is unchanged. */
  fingerprint: string
  /** The read tool to check with when a write's outcome is unknown. */
  checkWith: string
  perform: (signal: AbortSignal) => Promise<ActionOutcome>
}

export interface ActionDeps {
  server: McpServer
  confirmations: ConfirmationStore
}

/** Thrown by a plan that makes several writes when only some of them succeeded. */
export class PartialActionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PartialActionError'
  }
}

/** Non-error result for a request that needed no change (already activated, already a favourite). */
export function unchanged(message: string): CallToolResult {
  return structured([message], { status: 'unchanged', action: message })
}

const ElicitationCapability = z.looseObject({
  elicitation: z.looseObject({ form: z.looseObject({}).optional(), url: z.looseObject({}).optional() }),
})

/**
 * True when the client declared form elicitation: per request on the 2026-07-28 protocol, from
 * `initialize` on earlier ones. An `elicitation` object with neither mode named means form.
 */
function clientSupportsElicitation(server: McpServer, ctx: ServerContext): boolean {
  const envelope: Record<string, unknown> = ctx.mcpReq.envelope ?? {}
  // Deprecated for 2026-07-28 connections, which carry capabilities in the envelope; still the only source on 2025-era ones.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const declared = envelope[CLIENT_CAPABILITIES_META_KEY] ?? server.server.getClientCapabilities()
  const parsed = ElicitationCapability.safeParse(declared)
  if (!parsed.success) return false
  const { form, url } = parsed.data.elicitation
  return form !== undefined || url === undefined
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Why a write's outcome is unknown, in words. */
export function failureReason(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') return `a timeout after ${REQUEST_TIMEOUT_MS / 1000} s`
  if (err instanceof Error && err.name === 'AbortError') return 'the request being cancelled'
  if (err instanceof ResponseShapeError) return `an unexpected answer: ${err.message}`
  if (err instanceof ApiError) return err.message
  if (err instanceof TypeError) return `a network error (${err.message})`
  return errorMessage(err)
}

/** A 4xx from the API, or a sign-in failure before sending, means the write was not applied. */
export function definitelyNotApplied(err: unknown): boolean {
  if (err instanceof AuthError) return true
  return err instanceof ApiError && !(err instanceof ResponseShapeError) && err.status >= 400 && err.status < 500
}

async function execute(plan: ActionPlan, signal: AbortSignal): Promise<CallToolResult> {
  let outcome: ActionOutcome
  try {
    outcome = await plan.perform(signal)
  } catch (err) {
    if (err instanceof PartialActionError) return errorText(`${err.message}\nCheck with ${plan.checkWith} before trying again.`)
    if (definitelyNotApplied(err)) return errorText(err)
    return errorText(
      `${capitalise(plan.action)} may have been applied (the request failed with ${failureReason(err)}). Check with ${plan.checkWith} before trying again.`
    )
  }
  const lines = [`Done: ${outcome.summary}.`]
  if (outcome.followUp) {
    try {
      lines.push(...(await outcome.followUp(signal)))
    } catch (err) {
      lines.push(`(Balance unavailable: ${errorMessage(err)})`)
    }
  }
  return structured(lines, { status: 'done', action: plan.action, detail: outcome.summary })
}

function cancelled(action: string, why = `${action} was not confirmed`): CallToolResult {
  return structured([`Cancelled: ${why}.`], { status: 'cancelled', action })
}

/** A tool's check against account state: the plan to confirm, or the result (refusal, "nothing to change") to return instead. */
export type ActionCheck = ActionPlan | CallToolResult

function isPlan(checked: ActionCheck): checked is ActionPlan {
  return typeof Reflect.get(checked, 'perform') === 'function'
}

const ElicitAnswer = z.looseObject({
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z.looseObject({ confirm: z.boolean().optional() }).optional(),
})

function elicitParams(plan: ActionPlan) {
  return {
    mode: 'form' as const,
    message: `Pub Points is about to change your account: ${plan.action}. Confirm?`,
    requestedSchema: {
      type: 'object' as const,
      properties: { confirm: { type: 'boolean' as const, title: 'Confirm', description: plan.action } },
      required: ['confirm'],
    },
  }
}

function isAcceptedConfirm(answer: unknown): boolean {
  const parsed = ElicitAnswer.safeParse(answer)
  return parsed.success && parsed.data.action === 'accept' && parsed.data.content?.confirm === true
}

/**
 * The client cannot show the question at all: it has no such method, or it lacks the (form)
 * elicitation capability. Only then does the token take over. Any other failure (a timeout,
 * a dialog the client reports as closed) means the user was asked and did not say yes.
 */
const METHOD_NOT_FOUND: number = ProtocolErrorCode.MethodNotFound

function clientCannotAsk(err: unknown): boolean {
  if (err instanceof ProtocolError && err.code === METHOD_NOT_FOUND) return true
  return err instanceof SdkError && err.code === SdkErrorCode.CapabilityNotSupported
}

function isEraError(err: unknown): boolean {
  return err instanceof SdkError && err.code === SdkErrorCode.MethodNotSupportedByProtocolVersion
}

function preview(tool: string, plan: ActionPlan, binding: ConfirmationBinding, deps: ActionDeps): CallToolResult {
  const { token, expiresAt } = deps.confirmations.issue(binding)
  const minutes = Math.round(CONFIRMATION_TTL_MS / 60_000)
  return structured(
    [
      `Confirmation needed: ${plan.action}. Ask the user; if they agree, call ${tool} again with the same arguments plus confirmationToken "${token}". Expires in ${minutes} minutes.`,
    ],
    { status: 'confirmation_required', action: plan.action, confirmationToken: token, expiresAt }
  )
}

/** `askedAbout` is the action as the user saw it in the question, which may differ from the re-checked plan. */
function accountChanged(askedAbout: string): CallToolResult {
  return cancelled(askedAbout, `the account changed while waiting for confirmation, so ${askedAbout} was not done`)
}

/**
 * Checks the request against account state (`check`), confirms the resulting plan with the
 * user, then performs it. `args` are the tool's parsed arguments; every confirmation is bound
 * to them (minus the token), the tool name and the plan's state fingerprint.
 *
 * - With a confirmationToken: the token must be live, unused and issued for this binding.
 * - Client with elicitation, 2025 protocol: the server asks inside this call. The client's
 *   answer is the reply to that request, never anything sent with the call. Account state is
 *   checked again after the answer, and a change cancels. Only a client that cannot ask at all
 *   (no such method, no form capability) gets the token preview; any other failure cancels.
 * - Client with elicitation, 2026-07-28 protocol: the server returns an input_required result
 *   whose requestState is a single-use value from the store. Answers count only when they come
 *   back with that value for this binding; anything else is ignored and the user is asked again.
 * - Client without elicitation: the token preview.
 */
export async function confirmAndRun(
  tool: string,
  args: { confirmationToken?: string | undefined } & Record<string, unknown>,
  check: (signal: AbortSignal) => Promise<ActionCheck>,
  ctx: ServerContext,
  deps: ActionDeps
): Promise<ToolResult> {
  const signal = ctx.mcpReq.signal
  const plan = await check(signal)
  if (!isPlan(plan)) return plan
  const { confirmationToken, ...bound } = args
  const binding: ConfirmationBinding = { tool, args: bound, fingerprint: plan.fingerprint }

  if (confirmationToken !== undefined) {
    if (!deps.confirmations.consume(confirmationToken, binding)) return errorText(INVALID_TOKEN_TEXT)
    return execute(plan, signal)
  }

  if (!clientSupportsElicitation(deps.server, ctx)) return preview(tool, plan, binding, deps)

  let answer: unknown
  try {
    // Deprecated for 2026-07-28 requests, which take the inputRequired path instead; this is the 2025-era path.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    answer = await ctx.mcpReq.elicitInput(elicitParams(plan), { timeout: QUESTION_TTL_MS, resetTimeoutOnProgress: true, signal })
  } catch (err) {
    if (isEraError(err)) return askInBand(tool, bound, plan, ctx, deps)
    if (signal.aborted) throw err
    if (clientCannotAsk(err)) return preview(tool, plan, binding, deps)
    return cancelled(plan.action)
  }
  if (!isAcceptedConfirm(answer)) return cancelled(plan.action)
  const again = await check(signal)
  if (!isPlan(again) || again.fingerprint !== plan.fingerprint) return accountChanged(plan.action)
  return execute(again, signal)
}

/** The 2026-07-28 round trip: input_required with a server-issued, single-use requestState. */
function askInBand(
  tool: string,
  bound: Record<string, unknown>,
  plan: ActionPlan,
  ctx: ServerContext,
  deps: ActionDeps
): ToolResult | Promise<ToolResult> {
  const questionBinding: ConfirmationBinding = { tool, args: bound, fingerprint: `${ELICITATION_PURPOSE}:${plan.fingerprint}` }
  const state = ctx.mcpReq.requestState()
  const asked = typeof state === 'string' ? deps.confirmations.consumeForRequest(state, tool, bound) : null
  if (asked?.fingerprint === questionBinding.fingerprint) {
    const response = inputResponse(ctx.mcpReq.inputResponses, CONFIRM_KEY)
    const confirmed = response.kind === 'elicit' && response.action === 'accept' && response.content?.confirm === true
    return confirmed ? execute(plan, ctx.mcpReq.signal) : cancelled(plan.action)
  }
  // Our own question for this request, but the account moved while it was open.
  // The action named is the one stored with the question when it was issued, never client text.
  if (asked?.fingerprint.startsWith(`${ELICITATION_PURPOSE}:`)) return accountChanged(asked.action ?? plan.action)
  const question = deps.confirmations.issue(questionBinding, QUESTION_TTL_MS, plan.action)
  return inputRequired({
    inputRequests: { [CONFIRM_KEY]: inputRequired.elicit(elicitParams(plan)) },
    requestState: question.token,
  })
}
