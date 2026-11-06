// SPDX-License-Identifier: GPL-3.0-or-later
// Documentation stays in step with the package: every pinned install command names the version in
// package.json, and every relative link points at a file that exists.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = packageVersion()

function packageVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string')
    throw new TypeError('package.json has no version string')
  return pkg.version
}

const DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`),
]

const INSTALL_SPEC = /github:trammel\/pub-points-mcp#v([^\s`"'\])]+)/g
const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g

/** The first capture group, which every pattern here always fills. */
function group1(match: RegExpMatchArray): string {
  const value = match[1]
  if (value === undefined) throw new TypeError(`no capture group in ${match[0]}`)
  return value
}

function read(path: string) {
  return readFileSync(join(ROOT, path), 'utf8')
}

test('the README pins at least one install command', () => {
  // Guards the next test: a pattern that matched nothing would pass it vacuously.
  assert.ok([...read('README.md').matchAll(INSTALL_SPEC)].length >= 3)
})

for (const path of DOCS) {
  test(`${path}: every pinned install command names v${version}`, () => {
    const wrong = [...read(path).matchAll(INSTALL_SPEC)].map(group1).filter((v) => v !== version && v !== '<version>')
    assert.deepEqual(wrong, [], `${path} pins versions other than ${version}; see CONTRIBUTING.md, Releasing`)
  })

  test(`${path}: every relative link resolves`, () => {
    const broken = [...read(path).matchAll(MARKDOWN_LINK)]
      .map(group1)
      .filter((target) => !/^[a-z]+:/i.test(target) && !target.startsWith('#'))
      .map((target) => target.split('#')[0] ?? target)
      .filter((target) => !existsSync(join(ROOT, dirname(path), target)))
    assert.deepEqual(broken, [], `${path} links to missing files`)
  })
}
