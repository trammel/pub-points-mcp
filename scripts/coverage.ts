// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the test suite with coverage and holds it to the floor in coverage-floor.json.
//
//   node scripts/coverage.ts            fail if coverage is below the floor, or more than SLACK points above it
//   node scripts/coverage.ts --ratchet  raise the floor to today's coverage (never lowers it)
//
// The floor only moves up. Failing when coverage is well above the floor makes the rise permanent: the change
// that added tests also commits the raised floor, so the next change cannot quietly give it back.
//
// Test files run one at a time here. Node merges the coverage of each test process, and the merged numbers depend on
// the order the processes finish: in parallel that order changes with the machine's core count and load, so the same
// code read 94.19% of branches on one run and 94.05% on another. Sequentially the order is fixed (files sorted by
// name), and so is the result. It costs a few seconds (measured 14 s against 8 s).
//
// The floor is held on one Node major only, the one in .nvmrc. V8 counts coverage differently between Node majors
// for the same code and tests (sequentially, Node 22 counts 3,128 covered lines where Node 24 counts 3,148), so one
// floor cannot hold for both; patch releases within a major measured identical. On other majors every test still
// runs and must pass.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FLOOR_FILE = join(ROOT, 'coverage-floor.json')
const LCOV_FILE = join(ROOT, 'coverage', 'lcov.info')
/** Points above the floor allowed before the floor must be raised. */
const SLACK = 1
const FLOOR_NODE_MAJOR = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim().replace(/^v/, '').split('.')[0] ?? ''
const NODE_MAJOR = process.versions.node.split('.')[0] ?? ''

const METRICS = [
  { key: 'lines', found: 'LF', hit: 'LH' },
  { key: 'branches', found: 'BRF', hit: 'BRH' },
  { key: 'functions', found: 'FNF', hit: 'FNH' },
] as const

type Metric = (typeof METRICS)[number]['key']
type Coverage = Record<Metric, number>

function runTests(): void {
  mkdirSync(dirname(LCOV_FILE), { recursive: true })
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      '--experimental-test-coverage',
      '--test-coverage-include=dist/**',
      '--test-coverage-exclude=dist/**/*.d.ts',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=lcov',
      `--test-reporter-destination=${LCOV_FILE}`,
      'test/**/*.test.ts',
    ],
    { cwd: ROOT, stdio: 'inherit' }
  )
  if (result.status !== 0) {
    process.stderr.write('coverage: tests failed, so coverage was not checked.\n')
    process.exit(result.status ?? 1)
  }
}

/** Percentages summed over every file in the lcov report, to two decimal places. */
function readCoverage(): Coverage {
  const totals = new Map<string, number>()
  for (const line of readFileSync(LCOV_FILE, 'utf8').split('\n')) {
    const match = /^([A-Z]+):(\d+)$/.exec(line)
    if (match?.[1] && match[2]) totals.set(match[1], (totals.get(match[1]) ?? 0) + Number(match[2]))
  }
  const percent = (found: string, hit: string): number => {
    const all = totals.get(found) ?? 0
    return all === 0 ? 100 : Math.floor(((totals.get(hit) ?? 0) / all) * 10_000) / 100
  }
  return {
    lines: percent('LF', 'LH'),
    branches: percent('BRF', 'BRH'),
    functions: percent('FNF', 'FNH'),
  }
}

function readFloor(): Coverage {
  const raw: unknown = JSON.parse(readFileSync(FLOOR_FILE, 'utf8'))
  const floor: Partial<Coverage> = {}
  for (const { key } of METRICS) {
    const value: unknown = raw !== null && typeof raw === 'object' ? Reflect.get(raw, key) : undefined
    if (typeof value !== 'number') throw new Error(`${FLOOR_FILE}: "${key}" must be a number`)
    floor[key] = value
  }
  return floor as Coverage
}

function main(): void {
  const ratchet = process.argv.includes('--ratchet')
  runTests()
  const current = readCoverage()
  const floor = readFloor()

  if (NODE_MAJOR !== FLOOR_NODE_MAJOR) {
    const shown = METRICS.map(({ key }) => `${key} ${current[key].toFixed(2)}%`).join(', ')
    process.stdout.write(
      `\nCoverage of dist/ on Node ${NODE_MAJOR}: ${shown}. The floor is held on Node ${FLOOR_NODE_MAJOR} (.nvmrc) only.\n`
    )
    if (ratchet) {
      process.stderr.write(`coverage: run the ratchet on Node ${FLOOR_NODE_MAJOR} (.nvmrc); this is Node ${NODE_MAJOR}.\n`)
      process.exit(1)
    }
    return
  }

  const rows = METRICS.map(({ key }) => `  ${key.padEnd(10)} ${current[key].toFixed(2).padStart(6)}%  (floor ${floor[key].toFixed(2)}%)`)
  process.stdout.write(`\nCoverage of dist/:\n${rows.join('\n')}\n`)

  if (ratchet) {
    const raised = Object.fromEntries(METRICS.map(({ key }) => [key, Math.max(floor[key], current[key])]))
    writeFileSync(FLOOR_FILE, `${JSON.stringify(raised, null, 2)}\n`)
    process.stdout.write(`Floor written to coverage-floor.json.\n`)
    return
  }

  const below = METRICS.filter(({ key }) => current[key] < floor[key]).map(({ key }) => key)
  const stale = METRICS.filter(({ key }) => current[key] - floor[key] > SLACK).map(({ key }) => key)
  if (below.length) {
    process.stderr.write(`coverage: ${below.join(', ')} fell below the floor. Add tests for the code you changed.\n`)
    process.exit(1)
  }
  if (stale.length) {
    process.stderr.write(
      `coverage: ${stale.join(', ')} rose more than ${SLACK} point above the floor. Run \`npm run coverage:ratchet\` and commit coverage-floor.json.\n`
    )
    process.exit(1)
  }
}

main()
