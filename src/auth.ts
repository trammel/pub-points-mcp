// SPDX-License-Identifier: GPL-3.0-or-later
// Cognito sign-in for The Pass. A one-off SRP login (same flow as the app) yields a refresh
// token, which is stored on disk with 0600 permissions. The server then trades the refresh
// token for short-lived ID tokens. The `login` command never stores the password; signing in
// from THEPASS_EMAIL/THEPASS_PASSWORD means the password sits in the MCP client's config.

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import cognito from 'amazon-cognito-identity-js'
import * as z from 'zod/v4'
import { COGNITO, COGNITO_ENDPOINT, REQUEST_TIMEOUT_MS, USER_AGENT, requestSignal, runCommand } from './config.js'
import { nonEmpty, toError } from './text.js'

const { AuthenticationDetails, CognitoUser, CognitoUserPool } = cognito

/** Seconds of remaining validity below which a cached ID token is refreshed. */
const TOKEN_REFRESH_MARGIN_SECONDS = 120

const StoredSessionSchema = z.object({
  email: z.string(),
  refreshToken: z.string().min(1),
  deviceKey: z.string().optional(),
  savedAt: z.string(),
})

export type StoredSession = z.infer<typeof StoredSessionSchema>

interface CachedIdToken {
  token: string
  expiresAtEpochSeconds: number
}

const SOCIAL_PROVIDER_NAMES: Record<string, string> = { Google: 'Google', SignInWithApple: 'Apple', Apple: 'Apple', Facebook: 'Facebook' }

/**
 * The Pass blocks password sign-in for emails linked to Google/Apple/Facebook: its Cognito
 * PreAuthentication trigger fails with "... SIGN_IN | Google.". Those accounts can only sign in
 * through the provider, whose redirect goes to The Pass app, so this tool cannot sign them in.
 */
export function socialProviderFromError(err: { code?: string; name?: string; message?: string }): string | null {
  if (err.code !== 'UserLambdaValidationException' && err.name !== 'UserLambdaValidationException') return null
  const raw = err.message?.match(/SIGN_IN\s*\|\s*([^.]+)/)?.[1]?.trim()
  return raw ? (SOCIAL_PROVIDER_NAMES[raw] ?? raw) : null
}

const SOCIAL_SIGN_IN_HINT =
  'Accounts created with "Continue with Google" or "Continue with Apple" cannot sign in here: The Pass only ' +
  'accepts Google/Apple sign-in for them, and that sign-in returns to the app, not to this tool.'

const CREDENTIAL_ERRORS = new Set(['NotAuthorizedException', 'UserNotFoundException'])

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

function configDir(): string {
  if (process.env.PUB_POINTS_CONFIG_DIR) return process.env.PUB_POINTS_CONFIG_DIR
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'pub-points-mcp')
  }
  const xdg = nonEmpty(process.env.XDG_CONFIG_HOME) ?? join(homedir(), '.config')
  return join(xdg, 'pub-points-mcp')
}

export function sessionPath(): string {
  return join(configDir(), 'session.json')
}

function errorCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined
  const code: unknown = Reflect.get(err, 'code')
  return typeof code === 'string' ? code : undefined
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The stored session, or null when there is none. Any other problem with the file is an error. */
export async function loadSession(): Promise<StoredSession | null> {
  const path = sessionPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null
    throw new AuthError(`Cannot read the session file ${path}: ${message(err)}`)
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new AuthError(`The session file ${path} is not valid JSON. Run \`${runCommand('login')}\` to replace it.`)
  }
  const parsed = StoredSessionSchema.safeParse(json)
  if (!parsed.success) {
    throw new AuthError(`The session file ${path} is missing fields. Run \`${runCommand('login')}\` to replace it.`)
  }
  return parsed.data
}

/** Writes to a temp file in the same directory and renames it, so a crash never leaves half a file. */
export async function saveSession(session: StoredSession): Promise<void> {
  const dir = configDir()
  // The default folder is this tool's own, so it is always tightened. A folder named by
  // PUB_POINTS_CONFIG_DIR may already exist with a mode that is not ours to change (it could be
  // $HOME), so it is tightened only if this code just created it (mkdir reports the first folder made).
  const created = await mkdir(dir, { recursive: true, mode: 0o700 })
  if (!process.env.PUB_POINTS_CONFIG_DIR || created !== undefined) await chmod(dir, 0o700)
  const path = sessionPath()
  const temp = join(dir, `.session.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, path)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

export async function deleteSession(): Promise<void> {
  await rm(sessionPath(), { force: true })
}

function decodeJwtExpiry(jwt: string): number {
  const payload = jwt.split('.')[1]
  if (!payload) throw new AuthError('Cognito returned a malformed ID token')
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new AuthError('Cognito returned an ID token whose claims are not JSON')
  }
  const exp: unknown = claims !== null && typeof claims === 'object' ? Reflect.get(claims, 'exp') : undefined
  if (typeof exp !== 'number') throw new AuthError('Cognito ID token has no exp claim')
  return exp
}

/** In-memory storage so the Cognito SDK never reaches for a browser/Node localStorage. */
class MemoryStorage {
  private data = new Map<string, string>()
  setItem(key: string, value: string) {
    this.data.set(key, value)
  }
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  clear() {
    this.data.clear()
  }
}

/** Rejects after REQUEST_TIMEOUT_MS. The Cognito library has no abort hook, so this stops the wait, not the request. */
function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AuthError(`${what} timed out after ${REQUEST_TIMEOUT_MS / 1000} s`))
    }, REQUEST_TIMEOUT_MS)
  })
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer)
  })
}

/**
 * Signs in with email + password using Cognito SRP (the password never leaves this machine
 * in plain form) and stores the resulting refresh token.
 */
export async function login(
  emailInput: string,
  password: string,
  save: (s: StoredSession) => Promise<void> = saveSession
): Promise<StoredSession> {
  const email = emailInput.trim().toLowerCase()
  const storage = new MemoryStorage()
  const pool = new CognitoUserPool({
    UserPoolId: COGNITO.userPoolId,
    ClientId: COGNITO.clientId,
    Storage: storage,
  })
  const user = new CognitoUser({ Username: email, Pool: pool, Storage: storage })
  const details = new AuthenticationDetails({
    Username: email,
    Password: password,
    ClientMetadata: { email },
  })

  const authenticated = new Promise<cognito.CognitoUserSession>((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (s) => {
        resolve(s)
      },
      onFailure: (err: { message?: string; code?: string; name?: string }) => {
        const provider = socialProviderFromError(err)
        if (provider) {
          reject(new AuthError(`Sign-in failed: this email is linked to a ${provider} account. ${SOCIAL_SIGN_IN_HINT}`))
          return
        }
        const failure = `Sign-in failed: ${err.message ?? err.code ?? 'unknown error'}`
        reject(
          new AuthError(
            CREDENTIAL_ERRORS.has(err.code ?? '')
              ? `${failure} Check the email and password you use in The Pass app. ${SOCIAL_SIGN_IN_HINT}`
              : failure
          )
        )
      },
      newPasswordRequired: () => {
        reject(new AuthError('Cognito wants a new password. Sign in once in The Pass app, then retry.'))
      },
      mfaRequired: () => {
        reject(new AuthError('SMS MFA is enabled on this account; not supported.'))
      },
      totpRequired: () => {
        reject(new AuthError('TOTP MFA is enabled on this account; not supported.'))
      },
      customChallenge: () => {
        reject(new AuthError('Cognito issued a custom challenge; not supported.'))
      },
    })
  })
  const session = await withTimeout(authenticated, 'Sign-in')

  const deviceKey = storage.getItem(`CognitoIdentityServiceProvider.${COGNITO.clientId}.${user.getUsername()}.deviceKey`)
  const stored: StoredSession = {
    email,
    refreshToken: session.getRefreshToken().getToken(),
    ...(deviceKey ? { deviceKey } : {}),
    savedAt: new Date().toISOString(),
  }
  await save(stored)
  return stored
}

const InitiateAuthResponseSchema = z.looseObject({
  AuthenticationResult: z.looseObject({
    IdToken: z.string().min(1),
    RefreshToken: z.string().optional(),
  }),
})

const CognitoErrorSchema = z.looseObject({ __type: z.string().optional(), message: z.string().optional() })

/** Cognito's own error text (`message`, else `__type`), never the raw body. */
async function cognitoFailure(res: Response): Promise<string> {
  try {
    const parsed = CognitoErrorSchema.safeParse(await res.json())
    if (parsed.success) {
      const reason = parsed.data.message ?? parsed.data.__type
      if (reason) return `${reason}, HTTP ${res.status}`
    }
  } catch {
    // not JSON; the status says enough
  }
  return `HTTP ${res.status}`
}

function cognitoHeaders(target: string): Record<string, string> {
  return {
    'Content-Type': 'application/x-amz-json-1.1',
    'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    'User-Agent': USER_AGENT,
  }
}

export interface TokenProviderDeps {
  fetch?: typeof fetch
  loadSession?: () => Promise<StoredSession | null>
  saveSession?: (s: StoredSession) => Promise<void>
}

/** Rejects as soon as `signal` aborts, without cancelling the shared work behind `promise`. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(toError(signal.reason, 'Aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(toError(signal.reason, 'Aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(toError(err, 'Sign-in failed'))
      }
    )
  })
}

/** Supplies a valid ID token, refreshing or (with env credentials) re-logging in as needed. */
/** What PubPointsClient needs from sign-in: a current Cognito ID token, refreshed on request. */
export interface IdTokenSource {
  getIdToken(forceRefresh?: boolean, signal?: AbortSignal): Promise<string>
}

export class TokenProvider implements IdTokenSource {
  private cached: CachedIdToken | null = null
  private inflight: Promise<string> | null = null
  private readonly deps: TokenProviderDeps

  constructor(deps: TokenProviderDeps = {}) {
    this.deps = deps
  }

  private get fetchImpl(): typeof fetch {
    return this.deps.fetch ?? globalThis.fetch
  }

  private load(): Promise<StoredSession | null> {
    return (this.deps.loadSession ?? loadSession)()
  }

  private save(session: StoredSession): Promise<void> {
    return (this.deps.saveSession ?? saveSession)(session)
  }

  /**
   * Concurrent callers share one refresh. The shared refresh is bounded by REQUEST_TIMEOUT_MS
   * only, so one caller cancelling never fails the others; `signal` ends this caller's wait.
   */
  async getIdToken(forceRefresh = false, signal: AbortSignal = new AbortController().signal): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    if (!forceRefresh && this.cached && this.cached.expiresAtEpochSeconds - now > TOKEN_REFRESH_MARGIN_SECONDS) {
      return this.cached.token
    }
    this.inflight ??= this.obtain().finally(() => {
      this.inflight = null
    })
    return untilAborted(this.inflight, signal)
  }

  private async obtain(): Promise<string> {
    let session = await this.load()
    const envEmail = process.env.THEPASS_EMAIL
    const envPassword = process.env.THEPASS_PASSWORD

    if (!session) {
      if (!envEmail || !envPassword) {
        throw new AuthError(
          `Not signed in to The Pass. Run \`${runCommand('login')}\` in a terminal (or set THEPASS_EMAIL and THEPASS_PASSWORD).`
        )
      }
      session = await login(envEmail, envPassword, (s) => this.save(s))
    }

    try {
      this.cached = await this.refresh(session)
    } catch (err) {
      if (!envEmail || !envPassword) throw err
      this.cached = await this.refresh(await login(envEmail, envPassword, (s) => this.save(s)))
    }
    return this.cached.token
  }

  private async refresh(session: StoredSession): Promise<CachedIdToken> {
    const authParameters: Record<string, string> = { REFRESH_TOKEN: session.refreshToken }
    if (session.deviceKey) authParameters.DEVICE_KEY = session.deviceKey

    const res = await this.fetchImpl(COGNITO_ENDPOINT, {
      method: 'POST',
      headers: cognitoHeaders('InitiateAuth'),
      body: JSON.stringify({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: COGNITO.clientId,
        AuthParameters: authParameters,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const again = `Run \`${runCommand('login')}\` again.`
    if (!res.ok) throw new AuthError(`Session refresh failed (${await cognitoFailure(res)}). ${again}`)
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new AuthError(`Session refresh failed (Cognito answered HTTP ${res.status} with a body that is not JSON). ${again}`)
    }
    const parsed = InitiateAuthResponseSchema.safeParse(json)
    if (!parsed.success) throw new AuthError(`Session refresh failed (Cognito's answer has no ID token). ${again}`)
    const { IdToken, RefreshToken } = parsed.data.AuthenticationResult
    if (RefreshToken) {
      try {
        await this.save({ ...session, refreshToken: RefreshToken, savedAt: new Date().toISOString() })
      } catch (err) {
        process.stderr.write(
          `pub-points-mcp: warning: could not save the rotated refresh token (${message(err)}); the next start may need \`${runCommand('login')}\`.\n`
        )
      }
    }
    return { token: IdToken, expiresAtEpochSeconds: decodeJwtExpiry(IdToken) }
  }
}

/**
 * Revokes the refresh token with Cognito (public client: ClientId + Token, no secret). Best
 * effort: returns the failure reason instead of throwing, so logout still deletes the file.
 */
export async function revokeRefreshToken(
  session: StoredSession,
  signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<string | null> {
  try {
    const res = await fetchImpl(COGNITO_ENDPOINT, {
      method: 'POST',
      headers: cognitoHeaders('RevokeToken'),
      body: JSON.stringify({ ClientId: COGNITO.clientId, Token: session.refreshToken }),
      signal: requestSignal(signal),
    })
    return res.ok ? null : await cognitoFailure(res)
  } catch (err) {
    return message(err)
  }
}
