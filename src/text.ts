// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The string itself, or undefined when it is missing or empty. Environment variables and API text fields use an
 * empty string for "not set"; `nonEmpty(x) ?? fallback` says so explicitly where `x || fallback` would only imply it.
 */
export function nonEmpty(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : value
}

/** The value as an Error: Errors pass through unchanged, anything else becomes the cause of a new one. */
export function toError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}
