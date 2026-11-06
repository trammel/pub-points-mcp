// SPDX-License-Identifier: GPL-3.0-or-later
// Public client configuration for The Pass API.
// None of these are secrets: every client of the API uses the same values.

import { createRequire } from 'node:module'
import * as z from 'zod/v4'
import { nonEmpty } from './text.js'

const DEFAULT_API_BASE_URL = 'https://api.prod.v1.avc.eonx.com'

/** Override for testing against another deployment; `validateConfig` refuses anything but https. */
export const API_BASE_URL = nonEmpty(process.env.THEPASS_API_URL?.trim()) ?? DEFAULT_API_BASE_URL

export const COGNITO = {
  region: 'ap-southeast-2',
  userPoolId: 'ap-southeast-2_yLZxf0JXk',
  clientId: '51j5rt0ebmti4ddud4jn0rt8j6',
} as const

export const COGNITO_ENDPOINT = `https://cognito-idp.${COGNITO.region}.amazonaws.com/`

export const ALGOLIA_APP_ID = '84CP50NOB1'

/** The client version this server targets; `doctor` checks The Pass still accepts it. */
export const APP_VERSION = '12.11.8'

/** Single source of the version: package.json, which ships next to dist/. */
export const PACKAGE_VERSION = z.object({ version: z.string() }).parse(createRequire(import.meta.url)('../package.json')).version

export const USER_AGENT = `pub-points-mcp/${PACKAGE_VERSION}`

/** Pinned to the release tag so every launch runs the reviewed code, not whatever the default branch holds. */
const INSTALL_SPEC = `github:trammel/pub-points-mcp#v${PACKAGE_VERSION}`

/** The command a person types to run one of this tool's commands. */
export function runCommand(command: string): string {
  return `npx -y ${INSTALL_SPEC} ${command}`
}

/** Upper bound on any single outbound request (API, Cognito, Algolia). */
export const REQUEST_TIMEOUT_MS = 15_000

const DEFAULT_TIMEZONE = 'Australia/Sydney'

/** Time zone for date filters, month grouping, displayed dates and the utcOffset sent to the API. */
export const TIMEZONE = nonEmpty(process.env.PUB_POINTS_TIMEZONE?.trim()) ?? DEFAULT_TIMEZONE

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Checks the environment-derived settings; run once at startup so a bad value fails before any request. */
export function validateConfig(): void {
  let url: URL
  try {
    url = new URL(API_BASE_URL)
  } catch {
    throw new ConfigError(`THEPASS_API_URL is not a valid URL: ${API_BASE_URL}`)
  }
  if (url.protocol !== 'https:') {
    throw new ConfigError(`THEPASS_API_URL must start with https:// (got ${url.protocol}//). The ID token is sent with every request.`)
  }
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: TIMEZONE })
  } catch {
    throw new ConfigError(
      `PUB_POINTS_TIMEZONE is not a time zone this Node.js knows: ${TIMEZONE}. Use an IANA name such as ${DEFAULT_TIMEZONE}.`
    )
  }
}

/** Signal for one outbound request: aborts when the caller cancels or after REQUEST_TIMEOUT_MS. */
export function requestSignal(caller: AbortSignal): AbortSignal {
  return AbortSignal.any([caller, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
}
