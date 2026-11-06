// SPDX-License-Identifier: GPL-3.0-or-later
// Command-line parsing. Strict on purpose: a mistyped read-only switch must stop the server,
// never start it with the action tools registered.

import { parseArgs } from 'node:util'

export const COMMANDS = ['serve', 'login', 'status', 'doctor', 'logout'] as const
export type Command = (typeof COMMANDS)[number] | 'help' | 'version'

export interface CliOptions {
  command: Command
  readOnly: boolean
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const USAGE = `Usage: pub-points-mcp [command] [--read-only]

Commands:
  serve     Run the MCP server on stdio (default)
  login     Sign in to The Pass and store a session
  status    Print points, credit and tier
  doctor    Check the API still answers the way the tools expect
  logout    Revoke and delete the stored session

Options:
  --read-only    Serve only tools that read; nothing can be activated, redeemed or changed.
                 Same as PUB_POINTS_READ_ONLY=1.
  -v, --version  Print the version
  -h, --help     Print this help
`

const READ_ONLY_ENV = 'PUB_POINTS_READ_ONLY'
const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const FALSY = new Set(['', '0', 'false', 'no', 'off'])

function isCommand(value: string): value is (typeof COMMANDS)[number] {
  return COMMANDS.some((c) => c === value)
}

function readOnlyFromEnv(env: Record<string, string | undefined>): boolean {
  const value = (env[READ_ONLY_ENV] ?? '').trim().toLowerCase()
  if (TRUTHY.has(value)) return true
  if (FALSY.has(value)) return false
  throw new UsageError(
    `${READ_ONLY_ENV} must be one of ${[...TRUTHY].join(', ')} (read-only) or ${[...FALSY].filter(Boolean).join(', ')} or empty (read-write); got "${env[READ_ONLY_ENV]}".`
  )
}

export function parseCli(argv: readonly string[], env: Record<string, string | undefined>): CliOptions {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err))
  }
  const { values, positionals } = parsed
  const envReadOnly = readOnlyFromEnv(env)
  if (positionals.length > 1) throw new UsageError(`Expected at most one command, got: ${positionals.join(' ')}`)
  const readOnly = values['read-only'] === true || envReadOnly
  if (values.help === true) return { command: 'help', readOnly }
  if (values.version === true) return { command: 'version', readOnly }
  const command = positionals[0] ?? 'serve'
  if (!isCommand(command)) throw new UsageError(`Unknown command "${command}".`)
  return { command, readOnly }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      'read-only': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })
}
