#!/usr/bin/env node

// Prints 1 when the last fetch predates the most recent 18:15 KST slot (Korean
// evening release time), else 0. KST is UTC+9 with no DST, so this is pure UTC
// arithmetic and timezone-independent.
import { readFileSync } from 'node:fs'
import { DATA_PATH } from './shared.mjs'

const KST = 9 * 3600e3, DAY = 86400e3, SLOT = (18 * 60 + 15) * 60e3
const kstNow = Date.now() + KST
let slot = Math.floor(kstNow / DAY) * DAY + SLOT
if (slot > kstNow) slot -= DAY
let fetchedAt = 0
try { fetchedAt = JSON.parse(readFileSync(DATA_PATH, 'utf8')).fetched_at } catch {}
process.stdout.write(!Number.isFinite(fetchedAt) || fetchedAt <= 0 || fetchedAt > Date.now() || fetchedAt < slot - KST ? '1' : '0')
