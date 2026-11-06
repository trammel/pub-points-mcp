#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// pub-points-mcp: MCP server for The Pass loyalty app. Run as `npx -y <INSTALL_SPEC> <command>`:
//
//   serve [--read-only]   run the MCP server on stdio (the default; what MCP clients launch)
//   login                 sign in once and store a refresh token
//   status                print the points summary in the terminal
//   doctor                check the API still matches what the tools expect
//   logout                revoke and delete the stored session

import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { PubPointsClient } from './api.js'
import { deleteSession, loadSession, login, revokeRefreshToken, sessionPath } from './auth.js'
import { USAGE, UsageError, parseCli } from './cli.js'
import { ConfigError, PACKAGE_VERSION, runCommand, validateConfig } from './config.js'
import { formatDoctor, runDoctor } from './doctor.js'
import { formatBalances, formatTier } from './format.js'
import { registerTools } from './tools.js'
import { nonEmpty } from './text.js'

function serverInstructions(readOnly: boolean): string {
  const common =
    "Access to the signed-in member's account on The Pass (Australian Venue Co pubs and bars). Amounts are AUD. " +
    'Use pub_points_summary for balance questions, pub_points_discounts for "what discounts do I have", and ' +
    'pub_points_group_discounts for where a workplace or club discount applies. ' +
    `If a tool says the member is not signed in, tell the user to run \`${runCommand('login')}\` in a terminal. ` +
    `If tools start failing with missing fields or unexpected responses, suggest \`${runCommand('doctor')}\`.`
  if (readOnly) {
    return `${common} This server runs read-only: it cannot activate offers, redeem anything, join groups or change settings. Tell the user to do those in The Pass app.`
  }
  return (
    `${common} Tools that change the account (activate offers, redeem points or codes, join organisations, claim the birthday gift, ` +
    'change favourites or preferences) check the request first, then confirm it with the user. When the client can ask the user ' +
    'directly, the server asks and acts only on their yes. Otherwise the tool returns "Confirmation needed" with a confirmationToken: ' +
    'describe that exact action to the user, and only if they agree, call the same tool again with the same arguments plus the token. ' +
    'Never pass a token the user has not agreed to. A result that says the action "may have been applied" means check with the named read tool before retrying. ' +
    'To join a group discount (workplace, club) with a code, use pub_points_join_organisation.'
  )
}

async function prompt(question: string, hidden = false): Promise<string> {
  let muted = false
  const output = new Writable({
    write(chunk: string | Uint8Array, _enc, cb) {
      if (!muted) process.stderr.write(chunk)
      cb()
    },
  })
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY })
  try {
    const answer = rl.question(question)
    muted = hidden
    const value = await answer
    if (hidden) process.stderr.write('\n')
    return value
  } finally {
    rl.close()
  }
}

/** Cancelled by Ctrl-C, so a terminal command stops its requests instead of waiting out the timeout. */
function terminalSignal(): AbortSignal {
  const controller = new AbortController()
  process.once('SIGINT', () => {
    controller.abort(new Error('Interrupted'))
    process.exitCode = 130
  })
  return controller.signal
}

async function cmdLogin(signal: AbortSignal): Promise<void> {
  const email = nonEmpty(process.env.THEPASS_EMAIL) ?? (await prompt('The Pass email: '))
  const password = nonEmpty(process.env.THEPASS_PASSWORD) ?? (await prompt('Password: ', true))
  if (!email || !password) throw new Error('Email and password are required.')
  await login(email, password)
  process.stderr.write(`Signed in. Session saved to ${sessionPath()}\n`)
  await cmdStatus(signal)
}

async function cmdStatus(signal: AbortSignal): Promise<void> {
  const client = new PubPointsClient()
  const [balances, tier] = await Promise.all([client.getBalances(signal), client.getCustomerTier(signal).catch(() => null)])
  process.stdout.write([...formatBalances(balances), ...(tier ? formatTier(tier) : [])].join('\n') + '\n')
}

async function cmdDoctor(signal: AbortSignal): Promise<void> {
  const results = await runDoctor(new PubPointsClient(), signal)
  process.stdout.write(formatDoctor(results).join('\n') + '\n')
  if (results.some((r) => r.status === 'fail')) process.exitCode = 1
}

async function cmdLogout(signal: AbortSignal): Promise<void> {
  const session = await loadSession().catch((err: unknown) => {
    process.stderr.write(`pub-points-mcp: warning: ${err instanceof Error ? err.message : String(err)}\n`)
    return null
  })
  if (session) {
    const failure = await revokeRefreshToken(session, signal)
    if (failure)
      process.stderr.write(`pub-points-mcp: warning: could not revoke the session with Cognito (${failure}); deleting it anyway.\n`)
  }
  await deleteSession()
  process.stderr.write('Signed out.\n')
}

async function cmdServe(readOnly: boolean): Promise<void> {
  const server = new McpServer({ name: 'pub-points', version: PACKAGE_VERSION }, { instructions: serverInstructions(readOnly) })
  registerTools(server, new PubPointsClient(), { readOnly })
  await server.connect(new StdioServerTransport())
  process.stderr.write(
    readOnly
      ? 'pub-points-mcp: read-only mode (action tools disabled)\n'
      : 'pub-points-mcp: read-write mode (action tools need confirmation)\n'
  )
  const session = await loadSession().catch((err: unknown) => {
    process.stderr.write(`pub-points-mcp: ${err instanceof Error ? err.message : String(err)}\n`)
    return null
  })
  if (!session && !process.env.THEPASS_EMAIL) {
    process.stderr.write(`pub-points-mcp: not signed in yet; run \`${runCommand('login')}\` in a terminal.\n`)
  }
}

async function main(argv: string[]): Promise<void> {
  const { command, readOnly } = parseCli(argv, process.env)
  if (command === 'help') {
    process.stdout.write(USAGE)
    return
  }
  if (command === 'version') {
    process.stdout.write(`${PACKAGE_VERSION}\n`)
    return
  }
  validateConfig()
  switch (command) {
    case 'serve':
      return cmdServe(readOnly)
    case 'login':
      return cmdLogin(terminalSignal())
    case 'status':
      return cmdStatus(terminalSignal())
    case 'doctor':
      return cmdDoctor(terminalSignal())
    case 'logout':
      return cmdLogout(terminalSignal())
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof UsageError) {
    process.stderr.write(`pub-points-mcp: ${err.message}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  process.stderr.write(`pub-points-mcp: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = err instanceof ConfigError ? 2 : 1
})
