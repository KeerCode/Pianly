/**
 * Open-loop pace simulator: a player who plays a piece at its WRITTEN tempo,
 * like a person with a metronome — not watching the screen, not waiting for
 * the app — and what each practice mode does with them.
 *
 * Pure (no DOM, no Node APIs) so it runs in Node against fixtures and in the
 * browser pane against the real parsers' output:
 *
 *   const { simulateVisualizer, simulateSheet, makePlayer } =
 *     await import('/tools/paceSim.mjs')
 *
 * The player is realistic rather than ideal: a random-walk tempo wobble, a few
 * ms of per-note jitter, chord notes spread over ~20 ms, notes released a
 * little before their written end (legato but not welded), and the odd
 * hesitation.
 */
import { PracticeSession } from '../src/practice/practiceGate.js'
import { MidiStepGate } from '../src/practice/midiStepGate.js'

// ---- deterministic RNG ---------------------------------------------------------
export function rng(seed = 1) {
  let s = seed >>> 0
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  const g = () => { let a = 0; for (let i = 0; i < 6; i++) a += u(); return (a - 3) / Math.sqrt(0.5) } // ~N(0,1)
  return { u, g }
}

const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
export function noteMidi(name) {
  const m = /^([A-G])(#|b)?(-?\d+)$/.exec(name)
  if (!m) return null
  return BASE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (+m[3] + 2) * 12
}
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export const midiName = (m) => `${SHARP[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 2}`

/**
 * Turn timed entries into MIDI events a person would produce.
 * @param {{startSec:number, durSec:number, notes:string[]}[]} entries  sorted by startSec
 * @param {object} [o]
 * @returns {{t:number, type:'on'|'off', midi:number, entry:number}[]}  sorted by t (seconds)
 */
export function makePlayer(entries, o = {}) {
  const { seed = 7, tempoWobbleMs = 6, driftCapMs = 90, noteJitterMs = 10, chordSpreadMs = 20,
    holdMin = 0.78, holdMax = 0.97, hesitationP = 0.01, hesitationMs = [120, 320], speed = 1 } = o
  const R = rng(seed)
  const ev = []
  let drift = 0
  const out = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    drift += R.g() * tempoWobbleMs / 1000
    if (R.u() < hesitationP) drift += (hesitationMs[0] + R.u() * (hesitationMs[1] - hesitationMs[0])) / 1000
    drift = Math.max(-driftCapMs / 1000, Math.min(driftCapMs * 3 / 1000, drift))
    const base = e.startSec / speed + drift
    for (const n of e.notes) {
      const m = noteMidi(n)
      if (m == null) continue
      const on = base + R.g() * noteJitterMs / 1000 + R.u() * chordSpreadMs / 1000
      out.push({ i, m, on, hold: (e.durSec / speed) * (holdMin + R.u() * (holdMax - holdMin)), end: (e.startSec + e.durSec) / speed })
    }
  }
  out.sort((a, b) => a.on - b.on)
  // A key can't be pressed again before it was let go: cut the earlier hold short.
  const byPitch = new Map()
  for (const p of out) {
    if (!byPitch.has(p.m)) byPitch.set(p.m, [])
    byPitch.get(p.m).push(p)
  }
  for (const list of byPitch.values()) {
    for (let k = 0; k < list.length - 1; k++) {
      const maxHold = list[k + 1].on - list[k].on - 0.03
      list[k].hold = Math.max(0.04, Math.min(list[k].hold, maxHold))
    }
    for (const p of list) p.hold = Math.max(0.04, p.hold)
  }
  for (const p of out) {
    ev.push({ t: p.on, type: 'on', midi: p.m, entry: p.i })
    ev.push({ t: p.on + p.hold, type: 'off', midi: p.m, entry: p.i })
  }
  ev.sort((a, b) => a.t - b.t || (a.type === 'off' ? -1 : 1))
  return ev
}

// ---- Visualizer (clock-driven wait mode) -----------------------------------------
/**
 * A person watching the falling bars: each note is pressed when its bar lands,
 * give or take. Early (anticipating) presses fire when the SONG clock gets
 * there; late ones fire a human delay after the bar actually landed on screen
 * (the song may be stopped waiting for them, so song time cannot be the
 * reference). Releases follow the bar's written length in song time.
 *
 * @param {{tick:number,duration:number,durationSec?:number,notes:string[]}[]} timeline  Visualizer entries
 * @param {(tick:number)=>number} tickSec   tick -> song seconds
 * @param {object} [o] { seed, dtMs, leadIn, wobbleMs, jitterMs, hesitationP, hesitationMs:[lo,hi],
 *                       holdMin, holdMax, chordSpreadMs, reactive, reactMs, gate }
 */
export function simulateVisualizer(timeline, tickSec, o = {}) {
  const dtMs = o.dtMs ?? 8
  const leadIn = o.leadIn ?? 2.4
  const R = rng(o.seed ?? 7)
  const { wobbleMs = 5, driftCapMs = 70, jitterMs = 12, chordSpreadMs = 18, hesitationP = 0.01,
    hesitationMs = [120, 320], holdMin = 0.78, holdMax = 0.97 } = o
  const startSec = (e) => tickSec(e.tick) + leadIn
  const durOf = (e) => (e.durationSec != null ? e.durationSec : tickSec(e.tick + e.duration) - tickSec(e.tick))
  const endSec = (e) => startSec(e) + durOf(e)

  // The player's intent per note: offset from the landing (s), and hold length.
  const plan = []
  let drift = 0
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i]
    drift += R.g() * wobbleMs / 1000
    drift = Math.max(-driftCapMs / 1000, Math.min(driftCapMs / 1000, drift))
    let late = 0
    if (R.u() < hesitationP) late = (hesitationMs[0] + R.u() * (hesitationMs[1] - hesitationMs[0])) / 1000
    for (const n of e.notes) {
      const m = noteMidi(n)
      if (m == null) continue
      const off = drift + late + R.g() * jitterMs / 1000 + R.u() * chordSpreadMs / 1000
      plan.push({ i, m, off, hold: durOf(e) * (holdMin + R.u() * (holdMax - holdMin)), armedWall: null, pressed: false, released: false, pressWall: 0 })
    }
  }
  // a key cannot be pressed again before the earlier press of it was let go
  const byPitch = new Map()
  for (const p of plan) { if (!byPitch.has(p.m)) byPitch.set(p.m, []); byPitch.get(p.m).push(p) }
  for (const list of byPitch.values()) {
    for (let k = 0; k < list.length - 1; k++) {
      const gap = (startSec(timeline[list[k + 1].i]) + list[k + 1].off) - (startSec(timeline[list[k].i]) + list[k].off) - 0.035
      list[k].hold = Math.max(0.04, Math.min(list[k].hold, gap))
    }
  }

  const sess = new PracticeSession(o.gate)
  const stats = { entries: timeline.length, stallEpisodes: 0, stallMs: 0, releaseBlocks: 0, finished: false, longestStallMs: 0,
    interventions: 0, diag: [], ivDiag: [], lagAtEndMs: 0, confirmedFrac: 0, shortStalls: 0, shortStallMs: 0 }
  const reactMs = o.reactMs ?? 600
  let blockedSince = null, showing = false, stallStart = 0, song = 0, wall = 0, playing = true
  let rawBlockStart = null
  const lastTick = timeline[timeline.length - 1].tick
  for (let step = 0; step < 5e6; step++) {
    wall += dtMs / 1000
    // --- the person ---
    for (const p of plan) {
      if (p.pressed && p.released) continue
      const land = startSec(timeline[p.i])
      if (!p.pressed) {
        const target = land + Math.min(p.off, 0)
        if (p.armedWall === null && song >= target - 1e-9) p.armedWall = wall
        if (p.armedWall !== null && wall - p.armedWall >= Math.max(p.off, 0) - 1e-9) {
          if (sess.held.has(p.m)) sess.noteOff(p.m)
          sess.noteOn(p.m); p.pressed = true; p.pressSong = song; p.pressWall = wall
        }
      } else if (!p.released && song - p.pressSong >= p.hold) { sess.noteOff(p.m); p.released = true }
    }
    // --- the app ---
    let next = playing ? song + dtMs / 1000 : song
    const r = sess.step({ timeline, nowSec: next, startSec, endSec, noteMidi, nowMs: wall * 1000 })
    const blocked = r.required.size > 0 && r.state !== 'satisfied' && r.overdue
    if (blocked) { next = Math.min(next, r.holdAt); playing = false } else playing = true
    if (blocked && rawBlockStart === null) rawBlockStart = wall
    if (!blocked && rawBlockStart !== null) {
      const d = (wall - rawBlockStart) * 1000
      if (d < 120) { stats.shortStalls++; stats.shortStallMs += d }
      rawBlockStart = null
    }
    const show = blocked && r.showWaiting
    if (show && !showing) {
      stats.stallEpisodes++; stallStart = wall; if (r.missing.length === 0) stats.releaseBlocks++
      if (stats.diag.length < (o.diagN ?? 0)) {
        stats.diag.push({ songSec: +(r.landSec - leadIn).toFixed(2), asked: [...r.required].map(midiName), missing: r.missing.map(midiName), extras: r.extras.map(midiName), held: [...sess.held].map(midiName) })
      }
    }
    if (show) stats.stallMs += dtMs
    if (!show && showing) stats.longestStallMs = Math.max(stats.longestStallMs, (wall - stallStart) * 1000)
    showing = show
    // a person who has been looking at "Waiting for…" a while fixes it
    if (blocked) { if (blockedSince === null) blockedSince = wall } else blockedSince = null
    if (o.reactive !== false && blocked && blockedSince !== null && (wall - blockedSince) * 1000 >= reactMs) {
      stats.interventions++
      if (stats.ivDiag.length < (o.diagN ?? 0)) stats.ivDiag.push({ songSec: +(r.landSec - leadIn).toFixed(2), asked: [...r.required].map(midiName), missing: r.missing.map(midiName), extras: r.extras.map(midiName), held: [...sess.held].map(midiName), pressedNotHeld: [...sess.pressed.keys()].filter((m) => !sess.held.has(m)).map(midiName) })
      for (const m of r.extras) sess.noteOff(m)
      for (const m of r.missing) { sess.noteOff(m); sess.noteOn(m) }
      blockedSince = wall
    }
    song = next
    if (sess.confirmedTick >= lastTick) { stats.finished = true; break }
    if (wall > (endSec(timeline[timeline.length - 1]) + 600)) break
  }
  stats.wallSec = +(wall - leadIn).toFixed(1)   // time from the first bar landing to the last note confirmed
  stats.songSec = +(song - leadIn).toFixed(1)
  stats.lagAtEndMs = Math.round((wall - leadIn - (song - leadIn)) * 1000) // total time spent waiting
  stats.confirmedFrac = +(sess.confirmedTick / lastTick).toFixed(3)
  return stats
}

// ---- Sheet Practice MIDI path ------------------------------------------------------
const ENH = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb', Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' }
function notesMatch(a, b) {
  const x = /^([A-G][#b]?)(-?\d+)$/.exec(a), y = /^([A-G][#b]?)(-?\d+)$/.exec(b)
  if (!x || !y) return false
  return (x[1] === y[1] || ENH[x[1]] === y[1]) && x[2] === y[2]
}

/**
 * Reproduction of App.jsx's MIDI practice path BEFORE this change:
 * advance only when every key is released; any held key outside the target is a
 * wrong note; 150 ms cooldown after an advance; a delayed advance across a
 * whole empty measure.
 */
export function legacySheet() {
  const held = new Set()
  const st = { idx: 0, waiting: false, cooldownUntil: -1, wrong: 0, pendingIdx: null, pendingAt: 0 }
  return {
    st,
    held,
    tick(t) { // fire a delayed index update
      if (st.pendingIdx != null && t >= st.pendingAt) { st.idx = st.pendingIdx; st.pendingIdx = null }
    },
    noteOn(name, t, entries) {
      held.add(name)
      this.check(t, entries)
    },
    noteOff(name, t, entries) {
      held.delete(name)
      if (held.size === 0 && st.waiting) { st.waiting = false; this.advance(t, entries) }
    },
    check(t, entries) {
      if (t < st.cooldownUntil) return
      const target = entries[st.idx]
      if (!target || held.size === 0) return
      const all = target.notes.every((tn) => [...held].some((h) => notesMatch(h, tn)))
      const noExtras = [...held].every((h) => target.notes.some((tn) => notesMatch(h, tn)))
      if (all && noExtras) st.waiting = true
      else if (noExtras && !all) { /* building the chord */ }
      else { st.waiting = false; st.wrong++ }
    },
    advance(t, entries) {
      st.cooldownUntil = t + 0.15
      let n = st.idx + 1
      while (n < entries.length && n > 0 && entries[n - 1].isTied) n++
      if (n >= entries.length) { st.idx = entries.length; return }
      const prev = entries[st.idx], next = entries[n]
      const gapMs = Math.max(0, (next.timeSec - (prev.timeSec + prev.durationSec)) * 1000)
      if (gapMs >= 400 && (next.measure - prev.measure) > 1) { st.pendingIdx = n; st.pendingAt = t + gapMs / 1000 } else st.idx = n
    },
    get index() { return st.idx },
  }
}

/**
 * The Sheet Practice MIDI path AFTER this change: same MidiStepGate the page
 * uses, advance the moment a step is complete, no cooldown, no wait-for-release.
 */
export function newSheet() {
  const gate = new MidiStepGate((a, b) => notesMatch(a, b))
  const st = { idx: 0, wrong: 0, pendingIdx: null, pendingAt: 0 }
  return {
    st,
    held: gate.held,
    tick(t) { if (st.pendingIdx != null && t >= st.pendingAt) { st.idx = st.pendingIdx; st.pendingIdx = null } },
    noteOn(name, t, entries) { gate.noteOn(name, t * 1000); this.check(t, entries) },
    noteOff(name, t, entries) { gate.noteOff(name, t * 1000); this.check(t, entries) }, // letting go of a stray key can complete a step
    check(t, entries) {
      for (let guard = 0; guard < 8; guard++) {
        const target = entries[st.idx]
        if (!target) return
        const r = gate.evaluate(target.notes, false, entries[st.idx + 1]?.notes ?? null, t * 1000)
        if (r === 'wrong') { st.wrong++; return }
        if (r !== 'complete') return
        // No tie skipping: the OSMD timeline already omits tie continuations, so the
        // entry after a tied one is a real step (skipping it jumped over chords).
        const n = st.idx + 1
        if (n >= entries.length) { st.idx = entries.length; return }
        const prev = entries[st.idx], next = entries[n]
        const gapMs = Math.max(0, (next.timeSec - (prev.timeSec + prev.durationSec)) * 1000)
        if (gapMs >= 400 && (next.measure - prev.measure) > 1) { st.pendingIdx = n; st.pendingAt = t + gapMs / 1000; return }
        st.idx = n // keys already down for the next step are judged straight away
      }
    },
    get index() { return st.idx },
  }
}

/**
 * Drive a Sheet-mode logic object with the open-loop player.
 * @param {{timeSec:number,durationSec:number,measure:number,isTied:boolean,notes:string[]}[]} entries
 * @param {() => object} makeLogic  e.g. legacySheet
 */
export function simulateSheet(entries, makeLogic, o = {}) {
  const logic = makeLogic()
  const pe = entries.map((e) => ({ startSec: e.timeSec, durSec: e.durationSec, notes: e.notes }))
  const events = makePlayer(pe, o)
  const dtMs = 4
  const end = events[events.length - 1].t + 8
  const advancedAt = new Array(entries.length).fill(null)
  const playedAt = new Array(entries.length).fill(null)
  for (const e of events) if (e.type === 'on' && playedAt[e.entry] === null) playedAt[e.entry] = e.t
  let ei = 0
  let lastIdx = 0
  const stats = { entries: entries.length, wrong: 0, finalIdx: 0, stuckAt: null, maxLagSec: 0, lateEntries: 0, medianLagMs: null, advanced: 0 }
  for (let t = 0; t < end; t += dtMs / 1000) {
    logic.tick?.(t, entries)
    while (ei < events.length && events[ei].t <= t) {
      const e = events[ei++]
      const name = midiName(e.midi)
      if (e.type === 'on') logic.noteOn(name, e.t, entries); else logic.noteOff(name, e.t, entries)
    }
    logic.tick?.(t, entries)
    while (lastIdx < logic.index) { advancedAt[lastIdx] = t; lastIdx++ }
  }
  stats.finalIdx = logic.index
  stats.wrong = logic.st?.wrong ?? 0
  stats.advanced = advancedAt.filter((x) => x != null).length
  const lags = []
  for (let i = 0; i < entries.length; i++) {
    if (advancedAt[i] == null || playedAt[i] == null) continue
    lags.push((advancedAt[i] - playedAt[i]) * 1000)
  }
  lags.sort((a, b) => a - b)
  stats.medianLagMs = lags.length ? Math.round(lags[lags.length >> 1]) : null
  stats.p90LagMs = lags.length ? Math.round(lags[Math.floor(lags.length * 0.9)]) : null
  stats.maxLagSec = lags.length ? Math.round(lags[lags.length - 1]) / 1000 : null
  stats.lateEntries = lags.filter((l) => l > 250).length
  // first entry the cursor never got past while the player had long moved on
  for (let i = 0; i < entries.length; i++) if (advancedAt[i] == null) { stats.stuckAt = i; break }
  stats.neverAdvanced = entries.length - stats.advanced
  return stats
}
