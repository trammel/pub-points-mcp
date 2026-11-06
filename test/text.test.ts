// SPDX-License-Identifier: GPL-3.0-or-later
import './backstop.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nonEmpty, toError } from '../dist/text.js'

test('nonEmpty treats missing and empty strings as unset', () => {
  assert.equal(nonEmpty(undefined), undefined)
  assert.equal(nonEmpty(null), undefined)
  assert.equal(nonEmpty(''), undefined)
  assert.equal(nonEmpty(' '), ' ')
  assert.equal(nonEmpty('x'), 'x')
})

test('toError passes Errors through unchanged', () => {
  const err = new TypeError('boom')
  assert.equal(toError(err, 'unused'), err)
  const abort = new DOMException('stopped', 'AbortError')
  assert.equal(toError(abort, 'unused'), abort)
})

test('toError wraps anything else, keeping it as the cause', () => {
  const wrapped = toError('a string reason', 'Aborted')
  assert.ok(wrapped instanceof Error)
  assert.equal(wrapped.message, 'Aborted')
  assert.equal(wrapped.cause, 'a string reason')
  assert.equal(toError(undefined, 'Aborted').cause, undefined)
})
