/**
 * Simulates a person playing the Visualizer's practice mode against real demo
 * score data, through the new PracticeSession gate AND a faithful
 * reproduction of the old inline logic, so the three reported problems are
 * demonstrated and then shown fixed.
 *
 *   1. holding a note counted as playing it again (repeated notes, held past the end)
 *   2. the song ran on before pausing, so bars had scrolled away from what was asked
 *   3. a note held by the other hand (still sounding in the score) paused the song
 *
 *   npm run test:practice
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PracticeSession } from '../src/practice/practiceGate.js'

const FIX = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/practice-timelines.json', import.meta.url)), 'utf8'))
const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
function noteMidi(name) {
  const m = name.match(/^([A-G])(#|b)?(-?\d+)$/)
  if (!m) return null
  return BASE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (+m[3] + 2) * 12
}
const toTimeline = (entries) => entries.map(([tick, duration, hand, notes]) => ({ tick, duration, hand, notes: notes.split(',') }))
  .sort((a, b) => a.tick - b.tick)

const FALL_PX_PER_SEC = 200
const CHORD = 15

// ---- the OLD logic, reproduced from Visualizer.jsx before this change --------------
function makeLegacy() {
  return {
    confirmedTick: -1, graceStart: null, paused: false,
    step({ timeline, now, wall, startSec, held, playing }) {
      let first = Infinity
      for (const e of timeline) {
        if (e.tick <= this.confirmedTick) continue
        if (startSec(e) <= now + 0.02) { first = e.tick; break }
      }
      const required = new Set()
      if (first < Infinity) {
        for (const e of timeline) {
          if (e.tick < first - 5) continue
          if (e.tick > first + CHORD) break
          if (startSec(e) <= now + 0.02) for (const n of e.notes) { const m = noteMidi(n); if (m != null) required.add(m) }
        }
      }
      const allHeld = required.size === 0 || [...required].every((m) => held.has(m))
      const noExtras = [...held].every((m) => required.has(m))
      const out = { required, confirmed: false, pauseNow: false, resumeNow: false }
      if (allHeld && noExtras && required.size > 0) {
        this.confirmedTick = first + CHORD; this.graceStart = null
        out.confirmed = true
        if (this.paused) { this.paused = false; out.resumeNow = true }
      } else if (!allHeld && noExtras && held.size > 0 && required.size > 0) {
        this.graceStart = null
      } else if (required.size > 0 && playing) {
        if (this.graceStart === null) this.graceStart = wall
        else if (wall - this.graceStart > 150) { this.graceStart = null; this.paused = true; out.pauseNow = true }
      } else this.graceStart = null
      return out
    },
  }
}

// ---- the simulated player ------------------------------------------------------------
/**
 * @param {'new'|'old'} gate
 * @param {object} p  player: { lateMs, releaseExtraSec, holdThrough, earlySec, stray }
 */
function simulate(timeline, bpm, gate, p = {}) {
  const spq = 60 / bpm
  const startSec = (e) => (e.tick / 960) * spq
  const endSec = (e) => startSec(e) + (e.duration / 960) * spq
  const dtMs = 8
  const sess = new PracticeSession()
  const legacy = makeLegacy()
  const held = gate === 'new' ? sess.held : new Set()
  const noteOn = (m) => { pressSeq.set(m, (pressSeq.get(m) || 0) + 1); if (gate === 'new') sess.noteOn(m); else held.add(m) }
  const noteOff = (m) => { if (gate === 'new') sess.noteOff(m); else held.delete(m) }

  let song = 0, wall = 0, playing = true
  const stats = {
    entries: timeline.length, stallMs: 0, stallEpisodes: 0, falseConfirms: 0, vanishedAtStall: 0,
    maxOvershootPx: 0, finished: false, wrongNoteStallMs: 0, adaptations: 0,
  }
  const landedWall = new Map()     // entry index -> wall ms when it landed on screen
  const pressedAt = new Map()      // entry index -> true
  const releaseAt = new Map()      // midi -> song time to release
  const pressSeq = new Map()       // midi -> number of note-ons so far
  const usedSeq = new Map()        // midi -> number of those already spent confirming a note
  const lastPressWall = new Map()  // (kept for the adaptive player's bookkeeping)
  let stalled = false
  let lastRequired = new Set(), lastRequiredLegacy = new Set()
  let stray = p.stray ? { ...p.stray, done: false, on: false } : null
  const lateMs = p.lateMs ?? 0
  let stallStartWall = null
  let adaptations = 0
  const lastTick = timeline[timeline.length - 1].tick
  const lastEnd = Math.max(...timeline.map(endSec))

  for (let step = 0; step < 400000; step++) {
    wall += dtMs
    let nextSong = playing ? song + dtMs / 1000 : song

    // The person watches the screen: act when each entry has been on the keys for `lateMs`.
    timeline.forEach((e, i) => {
      if (!landedWall.has(i) && startSec(e) <= nextSong - 1e-9 + (p.earlySec ?? 0)) landedWall.set(i, wall)
      if (landedWall.has(i) && !pressedAt.has(i) && wall - landedWall.get(i) >= lateMs) {
        pressedAt.set(i, true)
        for (const n of e.notes) {
          const m = noteMidi(n)
          if (m == null) continue
          // "holdThrough": a lazy player who is still holding this pitch just keeps holding it
          if (!(p.holdThrough && held.has(m))) {
            if (held.has(m)) noteOff(m)
            noteOn(m)
            lastPressWall.set(m, wall)
          }
          releaseAt.set(m, endSec(e) + (p.releaseExtraSec ?? 0))
        }
      }
    })
    for (const [m, t] of [...releaseAt]) {
      if (nextSong >= t && held.has(m)) { noteOff(m); releaseAt.delete(m) }
    }
    if (stray && !stray.done) {
      if (!stray.on && nextSong >= stray.atSec) { noteOn(stray.midi); stray.on = true; stray.onWall = wall }
      if (stray.on && wall - stray.onWall >= stray.holdMs) { noteOff(stray.midi); stray.on = false; stray.done = true }
    }

    // A real person who is stuck lets go of everything and plays what is asked for.
    const isStalled = gate === 'new' ? stalled : !playing
    if (isStalled && stallStartWall === null) stallStartWall = wall
    if (!isStalled) stallStartWall = null
    if (isStalled && p.adaptive !== false && wall - stallStartWall >= 400) {
      adaptations++
      stallStartWall = wall
      for (const m of [...held]) noteOff(m)
      releaseAt.clear()
      const need = gate === 'new' ? lastRequired : lastRequiredLegacy
      for (const m of need) { noteOn(m); lastPressWall.set(m, wall); releaseAt.set(m, nextSong + 0.4) }
    }

    // ---- the gate -----------------------------------------------------------------
    let required, confirmed = false, blocked = false, landSec = null
    if (gate === 'new') {
      const r = sess.step({ timeline, nowSec: nextSong, startSec, endSec, noteMidi, nowMs: wall })
      required = r.required; confirmed = r.confirmed
      if (r.required.size) lastRequired = r.required
      // The clock keeps flowing through the lateness grace, then stops just after the landing.
      blocked = r.required.size > 0 && r.state !== 'satisfied' && r.overdue
      landSec = r.landSec
      if (blocked) nextSong = Math.min(nextSong, r.holdAt)
      if (stray && !stray.done && stray.on && blocked) stats.wrongNoteStallMs += dtMs
      if (p.debug && blocked && !stalled && !simulate._dbg) {
        simulate._dbg = true
        console.log('       [debug] first block at song', nextSong.toFixed(3), 'group tick', r.groupTick, 'required', [...r.required], 'held', [...sess.held], 'pressed', [...sess.pressed], 'missing', r.missing, 'extras', r.extras)
      }
      const showing = blocked && r.showWaiting
      if (showing && !stalled) { stats.stallEpisodes++; stalled = true } else if (!showing) stalled = false
      if (showing) stats.stallMs += dtMs
      if (blocked) {
        // bars still on screen = entries not past their end
        const g = timeline.filter((e) => e.tick >= r.groupTick - 5 && e.tick <= r.groupTick + CHORD)
        stats.maxOvershootPx = Math.max(stats.maxOvershootPx, (nextSong - landSec) * FALL_PX_PER_SEC)
        if (showing && g.some((e) => nextSong >= endSec(e))) stats.vanishedAtStall++
      }
    } else {
      const r = legacy.step({ timeline, now: nextSong, wall, startSec, held, playing })
      required = r.required; confirmed = r.confirmed
      if (r.required.size) lastRequiredLegacy = r.required
      if (r.pauseNow) {
        playing = false
        stats.stallEpisodes++
        // stall time is accumulated below while paused
        const first = timeline.find((e) => e.tick > legacy.confirmedTick && startSec(e) <= nextSong + 0.02)
        if (first) {
          stats.maxOvershootPx = Math.max(stats.maxOvershootPx, (nextSong - startSec(first)) * FALL_PX_PER_SEC)
          const g = timeline.filter((e) => e.tick >= first.tick - 5 && e.tick <= first.tick + CHORD)
          if (g.some((e) => nextSong >= endSec(e))) stats.vanishedAtStall++
        }
      }
      if (r.resumeNow) playing = true
      if (!playing) stats.stallMs += dtMs
      if (stray && !stray.done && stray.on && !playing) stats.wrongNoteStallMs += dtMs
    }

    if (confirmed) {
      // rule 1 audit: every required pitch must have been pressed anew since the previous confirmation
      for (const m of required) {
        // this note must be paid for by a note-on that no earlier note already used
        if ((pressSeq.get(m) || 0) <= (usedSeq.get(m) || 0)) stats.falseConfirms++
        else usedSeq.set(m, (usedSeq.get(m) || 0) + 1)
      }
    }
    song = nextSong
    if (song > lastEnd + 2 && (gate === 'new' ? sess.confirmedTick >= lastTick : legacy.confirmedTick >= lastTick)) { stats.finished = true; break }
  }
  stats.adaptations = adaptations
  stats.confirmedAll = (gate === 'new' ? sess.confirmedTick : legacy.confirmedTick) >= lastTick
  return stats
}

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  — ' + extra : ''}`) }
const row = (label, s) => console.log(`       ${label.padEnd(12)} interruptions ${String(s.stallEpisodes).padStart(3)} (${String(Math.round(s.stallMs)).padStart(6)} ms, player had to let go/replay ${String(s.adaptations).padStart(2)}x)  confirmed-without-a-press ${String(s.falseConfirms).padStart(3)}  bars-gone-when-paused ${String(s.vanishedAtStall).padStart(3)}  max overshoot ${s.maxOvershootPx.toFixed(0).padStart(3)} px  reached end ${s.confirmedAll}`)

const PIECES = Object.entries(FIX).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, toTimeline(v.entries), v.bpm])

console.log('\nA. An ideal player: presses each note as it lands, holds it for its written length, lets go.')
for (const [name, tl, bpm] of PIECES) {
  const o = simulate(tl, bpm, 'old'), n = simulate(tl, bpm, 'new')
  console.log(`     ${name}`); row('old logic', o); row('new gate', n)
  check(`${name}: new gate never stalls an ideal player`, n.stallEpisodes === 0 && n.confirmedAll, `${n.stallEpisodes} stalls`)
  check(`${name}: old logic did stall them (problem 3 reproduced)`, o.stallEpisodes > 0, `${o.stallEpisodes} stalls`)
}

console.log('\nB. A sloppy legato player: lets go of each note 200 ms after it was written to end.')
for (const [name, tl, bpm] of PIECES) {
  const n = simulate(tl, bpm, 'new', { releaseExtraSec: 0.2 })
  row(name, n)
  check(`${name}: a 200 ms late release is not a wrong key`, n.stallEpisodes === 0 && n.confirmedAll, `${n.stallEpisodes} stalls`)
}

console.log('\nC. A player who keeps a key down when the same note comes round again instead of playing it again (problem 1).')
{
  // C4 four times in a row; the player presses once and just keeps holding it.
  const tl = [0, 960, 1920, 2880].map((tick) => ({ tick, duration: 960, hand: 'R', notes: ['C4'] }))
  const o = simulate(tl, 120, 'old', { holdThrough: true, adaptive: false })
  const n = simulate(tl, 120, 'new', { holdThrough: true })
  console.log('     C4 C4 C4 C4, one key press'); row('old logic', o); row('new gate', n)
  check('old logic counted repeats of a note that was only held, with no new press', o.falseConfirms >= 2 && o.confirmedAll, `${o.falseConfirms} free`)
  check('new gate asked for a fresh press each time (nothing confirmed for free)', n.falseConfirms === 0 && n.stallEpisodes >= 1, `${n.falseConfirms} free, ${n.stallEpisodes} interruptions`)
  check('...and the player gets through the moment they press again', n.confirmedAll)
}
for (const [name, tl, bpm] of PIECES) {
  const n = simulate(tl, bpm, 'new', { holdThrough: true })
  check(`${name}: holding through repeats never confirms a note for free`, n.falseConfirms === 0, `${n.falseConfirms}`)
}

console.log('\nD. A late player (250 ms behind the bars): waits, nothing scrolls past what is being asked for (problem 2).')
for (const [name, tl, bpm] of PIECES) {
  const o = simulate(tl, bpm, 'old', { lateMs: 250 })
  const n = simulate(tl, bpm, 'new', { lateMs: 250 })
  console.log(`     ${name}`); row('old logic', o); row('new gate', n)
  // The clock stops lateGraceSec (0.12 s = 24 px) after the landing and the page pins the
  // asked-for bars to the keys, so what is waited for is always on screen.
  check(`${name}: new gate stops within the lateness grace of the asked-for notes`, n.maxOvershootPx <= 0.12 * FALL_PX_PER_SEC + 1.5, `overshoot ${n.maxOvershootPx.toFixed(1)} px`)
  check(`${name}: new gate still gets to the end`, n.confirmedAll)
  check(`${name}: old logic let bars scroll past before pausing`, o.maxOvershootPx > 20 || o.vanishedAtStall > 0, `overshoot ${o.maxOvershootPx.toFixed(0)} px, gone ${o.vanishedAtStall}`)
}

if (process.env.DEBUG_E) { const m = PIECES.find(([n]) => n.startsWith('Moon')); simulate(m[1], m[2], 'new', { earlySec: 0.12, debug: true }); process.exit(0) }
console.log('\nE. Pressing early (120 ms before the bars land) still counts.')
for (const [name, tl, bpm] of PIECES) {
  const n = simulate(tl, bpm, 'new', { earlySec: 0.12 })
  row(name, n)
  check(`${name}: early presses are accepted without stalling`, n.stallEpisodes === 0 && n.confirmedAll, `${n.stallEpisodes} stalls`)
}

console.log('\nF. A genuinely wrong key held for 1.2 s: still blocks, then recovers once released.')
{
  const [name, tl, bpm] = PIECES[0]
  const n = simulate(tl, bpm, 'new', { stray: { midi: 61, atSec: 4.0, holdMs: 1200 } }) // C#3: not in Für Elise's bar there
  row(name, n)
  check('stray key stalls the song while it is held', n.wrongNoteStallMs > 300, `${Math.round(n.wrongNoteStallMs)} ms`)
  check('...and the song finishes once it is released', n.confirmedAll)
}


console.log('\nG. The reported case: hold a whole note while quarter notes are played over it.')
{
  // C3 whole note (4 beats) in the left hand; E4, F4, G4 quarter notes in the right hand on beats 2-4.
  const tl = [
    { tick: 0, duration: 3840, hand: 'L', notes: ['C3'] },
    { tick: 960, duration: 960, hand: 'R', notes: ['E4'] },
    { tick: 1920, duration: 960, hand: 'R', notes: ['F4'] },
    { tick: 2880, duration: 960, hand: 'R', notes: ['G4'] },
  ]
  // The only note asked for on beat 2 is E4, but the whole note is still being held.
  const o = simulate(tl, 120, 'old', { adaptive: false })
  const n = simulate(tl, 120, 'new', { adaptive: false })
  row('old logic', o); row('new gate', n)
  check('old logic made the player let go of the whole note to progress', !o.confirmedAll && o.stallEpisodes >= 1)
  check('new gate lets the whole note ring while the quarter notes are played', n.stallEpisodes === 0 && n.confirmedAll, `${n.stallEpisodes} stalls`)

  // A direct, readable check of the same moment.
  const s2 = new PracticeSession()
  const startSec = (e) => (e.tick / 960) * 0.5, endSec = (e) => startSec(e) + (e.duration / 960) * 0.5
  const C3 = noteMidi('C3'), E4 = noteMidi('E4'), F4 = noteMidi('F4'), G4 = noteMidi('G4')
  s2.noteOn(C3)                                               // C3 down at the start
  s2.step({ timeline: tl, nowSec: 0, startSec, endSec, noteMidi, nowMs: 0 })
  s2.noteOn(E4)                                               // E4 on beat 2, C3 still held
  const r = s2.step({ timeline: tl, nowSec: 0.5, startSec, endSec, noteMidi, nowMs: 600 })
  check('beat 2: only E4 is asked for, and the held C3 is not a wrong key', r.required.size === 1 && r.required.has(E4) && r.extras.length === 0 && r.state === 'satisfied', JSON.stringify({ req: [...r.required], extras: r.extras, state: r.state }))
  // ...but once the whole note is over (4 beats + grace) and still held, it IS a stray key.
  s2.noteOn(F4)                                               // F4
  s2.step({ timeline: tl, nowSec: 1.0, startSec, endSec, noteMidi, nowMs: 1100 })
  s2.noteOn(G4)                                               // G4 at beat 4
  // G4 is asked for at 1.5 s; by 3.0 s the whole note (2.0 s long, +0.35 s grace) is long over.
  const late = s2.step({ timeline: tl, nowSec: 3.0, startSec, endSec, noteMidi, nowMs: 3100 })
  check('well after its written end, a still-held C3 is reported as a key to let go of', late.extras.includes(C3) && late.state === 'blocked', JSON.stringify({ req: [...late.required], extras: late.extras, state: late.state }))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
