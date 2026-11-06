// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar dates in the configured time zone (PUB_POINTS_TIMEZONE). Date filters, month
// grouping and the utcOffset sent to the API all go through here so they agree.

import { TIMEZONE } from './config.js'

const MINUTE_MS = 60_000

/** Minutes east of UTC that `timeZone` is at instant `at`. */
function offsetMinutes(timeZone: string, at: Date): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value
  const m = part?.match(/^GMT([+-])(\d{2}):(\d{2})$/)
  if (!m) return 0 // "GMT" alone means UTC
  const minutes = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -minutes : minutes
}

/** "+11:00" style offset. */
function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/** The configured zone's current UTC offset, as the API expects it. */
export function utcOffset(timeZone = TIMEZONE, now = new Date()): string {
  return formatOffset(offsetMinutes(timeZone, now))
}

/** YYYY-MM-DD of an instant, in the configured zone. */
function localDay(iso: string, timeZone = TIMEZONE): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone })
}

/** YYYY-MM of an instant, in the configured zone. */
export function localMonth(iso: string, timeZone = TIMEZONE): string {
  return localDay(iso, timeZone).slice(0, 7)
}

/** Wall-clock time `hhmmss` on `day` in `timeZone`, as an ISO timestamp with that zone's offset. */
function zonedTimestamp(day: string, time: string, timeZone: string): string {
  const guess = new Date(`${day}T${time}Z`)
  // The offset at the wall-clock instant; re-read once so a DST change that day lands right.
  const first = offsetMinutes(timeZone, new Date(guess.getTime() - offsetMinutes(timeZone, guess) * MINUTE_MS))
  return `${day}T${time}${formatOffset(first)}`
}

/** First instant of a calendar day in the configured zone. */
export function dayStart(day: string, timeZone = TIMEZONE): string {
  return zonedTimestamp(day, '00:00:00', timeZone)
}

/** Last whole second of a calendar day in the configured zone. */
export function dayEnd(day: string, timeZone = TIMEZONE): string {
  return zonedTimestamp(day, '23:59:59', timeZone)
}

/** True when the instant's local day lies within [from, to] (either bound optional, both inclusive). */
export function inLocalRange(iso: string, from: string | undefined, to: string | undefined, timeZone = TIMEZONE): boolean {
  const day = localDay(iso, timeZone)
  return (!from || day >= from) && (!to || day <= to)
}
