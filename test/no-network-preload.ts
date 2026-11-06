// SPDX-License-Identifier: GPL-3.0-or-later
// Loaded with `node --import` into every dist/index.js process binary.test.ts starts. Replaces
// fetch before the server's own code runs, so a started binary can never reach the network.
//
// - Every fetch is appended as a JSON line to PPM_FETCH_LOG (when set).
// - Cognito RevokeToken is answered according to PPM_REVOKE: `ok` (HTTP 200), `fail` (HTTP 400
//   NotAuthorizedException) or `throw` (a network error). A body without ClientId or Token gets
//   InvalidParameterException, as the real service answers.
// - Every other fetch throws.
//
// node --test also loads this file on its own (it sits under test/); it declares no tests and
// only replaces fetch in that throwaway process.

import { appendFileSync } from 'node:fs'

function answer(input: string | URL | Request, init: RequestInit = {}): Response {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const headers = new Headers(init.headers)
  const entry = { url, target: headers.get('X-Amz-Target'), body: typeof init.body === 'string' ? init.body : null }
  if (process.env.PPM_FETCH_LOG) appendFileSync(process.env.PPM_FETCH_LOG, JSON.stringify(entry) + '\n')
  const mode = process.env.PPM_REVOKE
  if (entry.target === 'AWSCognitoIdentityProviderService.RevokeToken' && mode) {
    if (mode === 'throw') throw new TypeError('fetch failed')
    const body: unknown = JSON.parse(entry.body ?? '{}')
    if (typeof body !== 'object' || body === null || !('ClientId' in body) || !body.ClientId || !('Token' in body) || !body.Token) {
      return new Response(JSON.stringify({ __type: 'InvalidParameterException', message: 'Missing ClientId or Token' }), { status: 400 })
    }
    if (mode === 'ok') return new Response('{}', { status: 200 })
    return new Response(JSON.stringify({ __type: 'NotAuthorizedException', message: 'Refresh Token has been revoked' }), { status: 400 })
  }
  throw new TypeError(`network disabled in tests: ${url}`)
}

// Async like the real fetch: whatever answer() throws comes back as a rejection.
globalThis.fetch = (input, init) =>
  new Promise((resolve) => {
    resolve(answer(input, init))
  })
