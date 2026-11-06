// SPDX-License-Identifier: GPL-3.0-or-later
// Packs the package, installs the tarball into an empty folder, and runs the installed binary, so a file left out of
// package.json's `files` or a broken `bin` fails here instead of on a colleague's machine. Needs the npm registry
// (the install fetches dependencies), so it runs in CI rather than in `npm test`.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version: unknown = pkg !== null && typeof pkg === 'object' ? Reflect.get(pkg, 'version') : undefined
if (typeof version !== 'string') throw new Error('package.json has no version')

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const work = mkdtempSync(join(tmpdir(), 'pub-points-smoke-'))

function step(what: string): void {
  process.stdout.write(`smoke: ${what}\n`)
}

function check(condition: boolean, failure: string): void {
  if (!condition) {
    process.stderr.write(`smoke: FAIL ${failure}\n`)
    process.exit(1)
  }
}

step(`packing into ${work}`)
const packed: unknown = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', work], { cwd: ROOT, encoding: 'utf8' }))
const filename: unknown =
  Array.isArray(packed) && packed[0] !== null && typeof packed[0] === 'object' ? Reflect.get(packed[0], 'filename') : undefined
check(typeof filename === 'string', 'npm pack did not report a tarball name')
const tarball = join(work, String(filename))

const install = join(work, 'install')
step('installing the tarball into an empty folder')
execFileSync(npm, ['install', '--prefix', install, '--no-audit', '--no-fund', tarball], { stdio: 'inherit' })

const installed = join(install, 'node_modules', 'pub-points-mcp')
for (const file of ['dist/index.js', 'LICENSE', 'README.md', 'CHANGELOG.md']) {
  check(existsSync(join(installed, file)), `installed package is missing ${file}`)
}
check(!existsSync(join(installed, 'dist', 'index.d.ts')), 'declaration files were published; package.json files should exclude them')
check(!existsSync(join(installed, 'src')) && !existsSync(join(installed, 'test')), 'source or tests were published')

const bin = join(install, 'node_modules', '.bin', process.platform === 'win32' ? 'pub-points-mcp.cmd' : 'pub-points-mcp')
step('running the installed binary')
const reported = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()
check(reported === version, `\`pub-points-mcp --version\` printed "${reported}", expected "${version}"`)
const usage = execFileSync(bin, ['--help'], { encoding: 'utf8' })
check(usage.startsWith('Usage: pub-points-mcp'), '`pub-points-mcp --help` did not print the usage text')

step(`OK: pub-points-mcp ${version} installs and runs`)
