/**
 * Pace regression: does each practice mode keep up with a person playing at the
 * written tempo? Synthetic ragtime-like patterns for Sheet Practice (MIDI), and
 * real demo-score excerpts for the Visualizer. No samples or DOM needed.
 *
 *   npm run test:pace
 *
 * The full-piece numbers (Maple Leaf Rag, 177 s, 1026 / 1372 steps) come from
 * running tools/paceSim.mjs in the browser against the real parsers; see
 * tools/TUNING.md "Practice pace".
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { simulateSheet, simulateVisualizer, legacySheet, newSheet } from './paceSim.mjs'

const FIX = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/practice-timelines.json', import.meta.url)), 'utf8'))
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  — ' + extra : ''}`) }

// ---- Sheet Practice (MIDI) ---------------------------------------------------------
const NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
const mk = (timeSec, durationSec, notes, measure = 1 + Math.floor(timeSec / 2.4), isTied = false) => ({ timeSec, durationSec, notes, measure, isTied })
function merge(list) { // same onset -> one step, like the OSMD timeline
  const by = new Map()
  for (const e of list) {
    const k = e.timeSec.toFixed(3)
    if (!by.has(k)) by.set(k, { ...e, notes: [...e.notes] })
    else { const c = by.get(k); c.notes.push(...e.notes); c.durationSec = Math.max(c.durationSec, e.durationSec) }
  }
  return [...by.values()].sort((a, b) => a.timeSec - b.timeSec)
}

// A: oom-pah left hand (notes held across several melody notes) under a 16th-note right hand
const ragtime = []
for (let k = 0; k < 160; k++) {
  const t = k * 0.15
  ragtime.push(mk(t, 0.14, [`${NAMES[(k * 3) % 7]}4`]))
  if (k % 4 === 0) ragtime.push(mk(t, 0.58, [`${NAMES[(k / 4 * 2) % 7]}2`]))        // bass held over 4 melody notes
  if (k % 4 === 2) ragtime.push(mk(t, 0.28, [`${NAMES[k % 7]}3`, `${NAMES[(k + 2) % 7]}3`])) // chord
}
const A = merge(ragtime)

// B: the same note repeated as 16ths (150 ms apart)
const B = merge(Array.from({ length: 80 }, (_, k) => mk(k * 0.15, 0.13, ['E4'])))

// C: tied notes in the middle of a run: the OSMD timeline has NO entry for the tie continuation
const C = merge(Array.from({ length: 60 }, (_, k) => mk(k * 0.3, 0.25, [`${NAMES[k % 7]}4`], 1 + Math.floor(k / 8), k % 5 === 2)))

const row = (r) => `advanced ${String(r.advanced).padStart(4)}/${r.entries}  wrong ${String(r.wrong).padStart(5)}  median lag ${r.medianLagMs ?? '-'} ms`
console.log('Sheet Practice, MIDI, player at the written tempo')
for (const [label, entries, strong] of [['oom-pah under 16ths', A, true], ['repeated 16th notes', B, true], ['tied notes mid-run', C, false]]) {
  const o = simulateSheet(entries, legacySheet, { seed: 4 })
  const n = simulateSheet(entries, newSheet, { seed: 4 })
  console.log(`   ${label.padEnd(22)} old: ${row(o)}\n   ${''.padEnd(22)} new: ${row(n)}`)
  check(`${label}: new logic plays the whole pattern, no wrong-note flags`, n.advanced === n.entries && n.wrong === 0, `${n.advanced}/${n.entries}, ${n.wrong} wrong`)
  check(`${label}: and stays within 150 ms of the player (p90)`, (n.p90LagMs ?? 9e9) <= 150, `p90 ${n.p90LagMs} ms`)
  if (strong) check(`${label}: old logic could not keep up (reproduced)`, o.advanced < o.entries, `${o.advanced}/${o.entries}`)
}
{
  const sloppy = { seed: 8, noteJitterMs: 30, tempoWobbleMs: 14, chordSpreadMs: 45, hesitationP: 0.04 }
  const n = simulateSheet(A, newSheet, sloppy)
  console.log(`   ${'oom-pah, very sloppy'.padEnd(22)} new: ${row(n)}`)
  check('very sloppy hands (45 ms apart, 30 ms jitter, 4% hesitations) still get all the way through', n.advanced === n.entries && n.wrong === 0, `${n.advanced}/${n.entries}`)
}

// ---- Visualizer -----------------------------------------------------------------------
console.log('\nVisualizer, player following the bars at the written tempo')
const tickSecFor = (bpm) => (tick) => (tick / 960) * (60 / bpm)
for (const key of ['Fur_Elise_easy', 'Moonlight_excerpt', 'Maple_Leaf_Rag_excerpt']) {
  const fx = FIX[key]
  const timeline = fx.entries.map(([tick, duration, hand, notes]) => ({ tick, duration, hand, notes: notes.split(',') })).sort((a, b) => a.tick - b.tick)
  const f = tickSecFor(fx.bpm)
  const runs = [1, 2, 3, 4].map((seed) => simulateVisualizer(timeline, f, { seed }))
  const noGrace = [1, 2, 3, 4].map((seed) => simulateVisualizer(timeline, f, { seed, gate: { lateGraceSec: 0 } }))
  const slow = (r) => (r.wallSec / r.songSec - 1) * 100
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
  console.log(`   ${key.padEnd(26)} slowdown ${mean(runs.map(slow)).toFixed(1)}%  (without the grace ${mean(noGrace.map(slow)).toFixed(1)}%)  interventions ${runs.reduce((a, r) => a + r.interventions, 0)}`)
  check(`${key}: finishes, nobody has to step in`, runs.every((r) => r.finished && r.interventions === 0))
  check(`${key}: song runs within 4% of the written length`, runs.every((r) => slow(r) < 4), `${runs.map((r) => slow(r).toFixed(1)).join(', ')}%`)
  check(`${key}: the lateness grace is what keeps it there`, mean(noGrace.map(slow)) > mean(runs.map(slow)) + 1, `${mean(noGrace.map(slow)).toFixed(1)}% -> ${mean(runs.map(slow)).toFixed(1)}%`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
