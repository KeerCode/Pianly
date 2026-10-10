/**
 * Mic calibration: per-note spectral "fingerprints" of the user's own piano +
 * microphone, saved so setup only has to happen once.
 *
 * Why: whether a note an octave above a lower note is *really* being played is
 * ambiguous from a generic harmonic model — the lower note's own 2nd harmonic
 * lands exactly on it, and how strong that harmonic is varies hugely from note
 * to note (measured: A2's 2nd partial is 0.03-0.56x its fundamental, C3's is
 * ~3x) and over the life of the note. A recording of the user's actual piano
 * playing that note alone pins that curve down, so the detector can tell "A2
 * alone" from "A2 + A3" (see PitchEngine._applyCalibration).
 *
 * This module is pure data + storage: it never imports the engine (the engine
 * imports it), and nothing here touches `localStorage` at import time, so it is
 * safe to load from Node.
 *
 * Data model (localStorage, key STORE_KEY):
 *   { version, activeId, profiles: [ Profile ] }
 *   Profile = { id, name, createdAt, updatedAt, roomRms, micLabel, sampleRate,
 *               notes: { [midi]: NoteEntry } }
 *   NoteEntry = { midi, f: [Hz of partial 1..8 | null], ages: [s...],
 *                 r: { [n]: [amp(partial n)/amp(partial 1) per age] },
 *                 rms, at }
 */

export const STORE_KEY = 'pianly-mic-calibration'
export const STORE_EVENT = 'pianly-mic-calibration-changed'
export const PARTIALS = 8           // partials measured per note (1 = fundamental)
export const MAX_CURVE_AGE = 1.2    // seconds of decay curve kept per note

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const round = (v, d = 4) => { const p = 10 ** d; return Math.round(v * p) / p }

export function midiToHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12) }

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
/** App naming: middle C = C3 = MIDI 60. */
export function noteLabel(midi) {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 2}`
}

/**
 * Does the engine's current spectrum really contain a note at `midi`'s pitch?
 * The engine's expected-note prior is lenient on purpose (it should find the
 * note the score asks for in noise), which is exactly wrong for setup: a wrong
 * key's attack transient can light the asked-for note up. Setup demands real
 * evidence instead: the fundamental clear of the noise AND at least three of
 * the first five partials.
 *
 * @param {{mag: Float32Array, binHz: number, bins: number, lastRawMagMean: number}} engine
 */
export function supportsNote(engine, midi) {
  const mean = engine.lastRawMagMean
  if (!(mean > 0)) return false
  const f0 = midiToHz(midi)
  if (fundamentalAmp(engine, midi) < 5 * mean) return false
  let hits = 0
  for (let n = 1; n <= 5; n++) {
    if (n * f0 > engine.binHz * engine.bins * 0.9) break
    if (peakNear(engine, n * f0) > 6 * mean) hits++
  }
  return hits >= 3
}

function peakNear(engine, hz) {
  const c = hz / engine.binHz
  const w = Math.max(1, Math.round(c * 0.012))
  const lo = Math.max(1, Math.round(c) - w)
  const hi = Math.min(engine.bins - 2, Math.round(c) + w)
  let v = 0
  for (let b = lo; b <= hi; b++) if (engine.mag[b] > v) v = engine.mag[b]
  return v
}

/** Spectral amplitude at `midi`'s fundamental (+-1.2 %). */
export function fundamentalAmp(engine, midi) { return peakNear(engine, midiToHz(midi)) }

// Setup presets (app naming, middle C = C3 = 60). Partial ratios are NOT
// interpolated between keys (neighbours differ by up to ~6x), so an uncalibrated
// key just uses the standard detector — coverage is what the user chooses here.
//   essential  every white key C2-C5: all of Read Practice, most of the repertoire
//   bass       white keys E0-B1: the octave pairs below C2 (the weakest register —
//              see "Known limits" in tools/TUNING.md — so worth having covered).
//              Note this app names middle C "C3", so a textbook piano's lowest
//              keys read A-1..D0 here; they sit below the useful range of a
//              laptop mic and are left to "Everything".
//   full       every key from the piano's lowest A (shown "A-1") to C6
export const SETUP_PRESETS = {
  essential: { label: 'Essential · white keys C2–C5', midis: whiteKeys(48, 84) },
  bass: { label: 'Bass · white keys E0–B1', midis: whiteKeys(28, 47) },
  full: { label: 'Everything · every key, lowest A to C6', midis: range(21, 96) },
}
/**
 * Lower notes of the octave pairs in a piece: for each step (array of MIDI
 * numbers), every note X that has X+12 or X+24 in the SAME step. Those are
 * exactly the notes calibration can help with (see PitchEngine._applyCalibration).
 * @param {number[][]} steps
 * @returns {number[]} sorted, unique
 */
export function octavePairLowers(steps) {
  const out = new Set()
  for (const step of steps) {
    const have = new Set(step)
    for (const m of have) if (have.has(m + 12) || have.has(m + 24)) out.add(m)
  }
  return [...out].sort((a, b) => a - b)
}

function range(a, b) { const o = []; for (let m = a; m <= b; m++) o.push(m); return o }
function whiteKeys(a, b) { return range(a, b).filter((m) => [0, 2, 4, 5, 7, 9, 11].includes(((m % 12) + 12) % 12)) }

// ---------------------------------------------------------------------------
// Strike recording
// ---------------------------------------------------------------------------

/**
 * Records one struck note, frame by frame, from the engine's own spectra, and
 * turns it into a NoteEntry. Feed it AFTER `engine.process(frame)` each tick.
 *
 * `age` is `engine.attackAge(midi)` — seconds since the engine detected this
 * note's attack. Live detection uses the same clock, so a curve recorded here
 * is read back at exactly the same ages.
 */
export class StrikeRecorder {
  constructor(midi, { binHz, bins }) {
    this.midi = midi
    this.binHz = binHz
    this.bins = bins
    this.nominal = midiToHz(midi)
    this.frames = []        // { age, mean, rms, slices: Float32Array[] (index n-1), sub: Float32Array }
    this.peakRms = 0
    this.slicesFor = []     // per partial: [lo, hi] bin range, or null if out of range
    const nyq = binHz * bins
    for (let n = 1; n <= PARTIALS; n++) {
      const f = this.nominal * n
      if (f > nyq * 0.85) { this.slicesFor.push(null); continue }
      const w = Math.max(3, Math.ceil((f * 0.045) / binHz) + 1)
      const c = Math.round(f / binHz)
      const lo = Math.max(1, c - w)
      const hi = Math.min(bins - 2, c + w)
      this.slicesFor.push(hi > lo ? [lo, hi] : null)
    }
    const cs = Math.round((this.nominal / 2) / binHz)
    const sw = Math.max(2, Math.ceil((this.nominal / 2 * 0.045) / binHz))
    this.subRange = cs - sw >= 1 ? [cs - sw, cs + sw] : null
  }

  /**
   * Snapshot this tick's spectrum as a frame (or null if out of range). Split
   * from `push` so a caller can hold the last few frames back and discard the
   * damper-release ramp. @param {{mag: Float32Array, lastRawMagMean: number}} engine
   */
  capture(engine, age, rms) {
    if (age == null || age < 0 || age > MAX_CURVE_AGE) return null
    const mag = engine.mag
    const slices = this.slicesFor.map((r) => (r ? mag.slice(r[0], r[1] + 1) : null))
    const sub = this.subRange ? mag.slice(this.subRange[0], this.subRange[1] + 1) : null
    return { age, mean: engine.lastRawMagMean, rms, slices, sub }
  }

  push(frame) {
    if (!frame) return
    this.frames.push(frame)
    if (frame.rms > this.peakRms) this.peakRms = frame.rms
  }

  add(engine, age, rms) { this.push(this.capture(engine, age, rms)) }

  /** Enough decay data captured to build a curve? */
  get ready() {
    return this.frames.length >= 14 && this.frames[this.frames.length - 1].age >= 1.0
  }

  /**
   * @returns {{entry: object}|{error: string, code: string}}
   */
  finish() {
    const F = this.frames
    if (F.length < 10) return { code: 'short', error: 'Too short — hold the key a little longer.' }
    const ok = F.filter((fr) => fr.age >= 0.04)
    if (ok.length < 8) return { code: 'short', error: 'Too short — hold the key a little longer.' }
    // The curve has to outlast the engine's early-decision window with room to
    // spare, or the resolver would be judging against an extrapolated tail.
    if (F[F.length - 1].age < 0.6) return { code: 'short', error: 'Too short — hold the key a little longer.' }

    // Pool each partial's frequency over the whole strike (peak of the summed
    // slice, parabolic-interpolated) — absorbs stretch tuning + inharmonicity.
    const f = new Array(PARTIALS).fill(null)
    const peakBins = new Array(PARTIALS).fill(null)
    for (let n = 1; n <= PARTIALS; n++) {
      const r = this.slicesFor[n - 1]
      if (!r) continue
      const len = r[1] - r[0] + 1
      const acc = new Float64Array(len)
      for (const fr of ok) { const s = fr.slices[n - 1]; for (let i = 0; i < len; i++) acc[i] += s[i] }
      let bi = 0
      for (let i = 1; i < len; i++) if (acc[i] > acc[bi]) bi = i
      let frac = 0
      if (bi > 0 && bi < len - 1) {
        const a = acc[bi - 1], b = acc[bi], c = acc[bi + 1]
        const d = a - 2 * b + c
        if (d < 0) frac = clamp(0.5 * (a - c) / d, -0.5, 0.5)
      }
      const bin = r[0] + bi + frac
      f[n - 1] = bin * this.binHz
      peakBins[n - 1] = r[0] + bi
    }
    if (f[0] == null) return { code: 'range', error: 'This note is outside the measurable range.' }
    const cents = 1200 * Math.log2(f[0] / this.nominal)
    if (Math.abs(cents) > 75) {
      return { code: 'pitch', error: `That is ${Math.abs(Math.round(cents))}¢ ${cents < 0 ? 'flat' : 'sharp'} of ${noteLabel(this.midi)} — wrong note, or the piano is badly out of tune.` }
    }

    // Per-frame amplitude at each pooled partial (max of +-1 bin, like the
    // engine's own _magAt, so calibration and live reading agree).
    const ampAt = (fr, n) => {
      const r = this.slicesFor[n - 1]
      const s = fr.slices[n - 1]
      if (!r || !s || f[n - 1] == null) return 0
      const c = Math.round(f[n - 1] / this.binHz) - r[0]
      let v = 0
      for (let i = c - 1; i <= c + 1; i++) if (i >= 0 && i < s.length && s[i] > v) v = s[i]
      return v
    }

    // Quality gates on the fundamental, judged where the note is loudest.
    const a1 = ok.map((fr) => ampAt(fr, 1))
    const snr = ok.map((fr, i) => a1[i] / (fr.mean + 1e-12))
    const med = (arr) => { const s = [...arr].sort((x, y) => x - y); return s[s.length >> 1] }
    const earlyIdx = ok.map((fr, i) => i).filter((i) => ok[i].age <= 0.5)
    if (earlyIdx.length < 6 || med(earlyIdx.map((i) => snr[i])) < 6) {
      return { code: 'weak', error: 'Too quiet or too noisy to measure — play a little firmer, or move the mic closer.' }
    }
    // Sub-octave energy means the octave BELOW was sounding (wrong octave).
    if (this.subRange) {
      const subAmp = ok.map((fr) => (fr.sub ? Math.max(...fr.sub) : 0))
      const rel = med(earlyIdx.map((i) => subAmp[i] / (a1[i] + 1e-12)))
      if (rel > 0.5) return { code: 'octave', error: 'That sounds an octave too low.' }
    }

    // Build the decay curve: ratio of each partial to the fundamental at each
    // frame age. Frames whose fundamental is under the noise are dropped.
    const ages = []
    const r = {}
    for (let n = 2; n <= PARTIALS; n++) if (f[n - 1] != null) r[n] = []
    for (let i = 0; i < ok.length; i++) {
      if (snr[i] < 3 || a1[i] <= 0) continue
      ages.push(round(ok[i].age, 3))
      for (let n = 2; n <= PARTIALS; n++) if (r[n]) r[n].push(round(ampAt(ok[i], n) / a1[i], 4))
    }
    if (ages.length < 6) return { code: 'weak', error: 'Too quiet or too noisy to measure.' }

    // Prepend age 0 so interpolation is defined from the very first frame.
    const entry = {
      midi: this.midi,
      f: f.map((v) => (v == null ? null : round(v, 2))),
      ages, r,
      rms: round(this.peakRms, 4),
      at: Date.now(),
    }
    return { entry }
  }
}

/** Linear interpolation of a calibrated curve at `age` (clamped at the ends). */
export function curveAt(ages, vals, age) {
  const n = ages.length
  if (n === 0) return null
  if (age <= ages[0]) return vals[0]
  if (age >= ages[n - 1]) return vals[n - 1]
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ages[mid] <= age) lo = mid; else hi = mid }
  const t = (age - ages[lo]) / (ages[hi] - ages[lo] || 1)
  return vals[lo] + t * (vals[hi] - vals[lo])
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function emptyStore() { return { version: 1, activeId: null, profiles: [] } }

function storage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

export function loadStore() {
  const ls = storage()
  if (!ls) return emptyStore()
  try {
    const raw = ls.getItem(STORE_KEY)
    if (!raw) return emptyStore()
    const s = JSON.parse(raw)
    if (!s || s.version !== 1 || !Array.isArray(s.profiles)) return emptyStore()
    if (s.activeId && !s.profiles.some((p) => p.id === s.activeId)) s.activeId = s.profiles[0]?.id ?? null
    return s
  } catch {
    return emptyStore()
  }
}

export function saveStore(store) {
  const ls = storage()
  if (!ls) return false
  try {
    ls.setItem(STORE_KEY, JSON.stringify(store))
    try { window.dispatchEvent(new Event(STORE_EVENT)) } catch { /* no window in Node */ }
    return true
  } catch {
    return false // quota / blocked storage: calibration just won't persist
  }
}

export function getActiveProfile(store) {
  return store.profiles.find((p) => p.id === store.activeId) ?? null
}

function uid() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }

/** Add a new, empty piano profile and make it active. Returns the new store. */
export function addProfile(store, name = 'My piano') {
  const now = Date.now()
  const p = { id: uid(), name: name.trim() || 'My piano', createdAt: now, updatedAt: now, roomRms: null, micLabel: null, sampleRate: null, notes: {} }
  return { ...store, activeId: p.id, profiles: [...store.profiles, p] }
}

export function updateProfile(store, id, patch) {
  return { ...store, profiles: store.profiles.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)) }
}

export function upsertNote(store, id, entry) {
  return {
    ...store,
    profiles: store.profiles.map((p) => (p.id === id
      ? { ...p, updatedAt: Date.now(), notes: { ...p.notes, [entry.midi]: entry } }
      : p)),
  }
}

export function removeNote(store, id, midi) {
  return {
    ...store,
    profiles: store.profiles.map((p) => {
      if (p.id !== id) return p
      const notes = { ...p.notes }
      delete notes[midi]
      return { ...p, updatedAt: Date.now(), notes }
    }),
  }
}

/** Wipe one profile's notes (recalibrate from scratch, keeping the name). */
export function clearProfile(store, id) {
  return updateProfile(store, id, { notes: {}, roomRms: null })
}

export function deleteProfile(store, id) {
  const profiles = store.profiles.filter((p) => p.id !== id)
  return { ...store, profiles, activeId: store.activeId === id ? (profiles[0]?.id ?? null) : store.activeId }
}

export function setActive(store, id) {
  return store.profiles.some((p) => p.id === id) ? { ...store, activeId: id } : store
}

/** Profile -> the shape PitchEngine.setCalibration() consumes (or null). */
export function toEngineCalibration(profile) {
  if (!profile) return null
  const notes = {}
  for (const [k, e] of Object.entries(profile.notes || {})) {
    if (e && Array.isArray(e.f) && Array.isArray(e.ages) && e.r) notes[k] = e
  }
  if (Object.keys(notes).length === 0) return null
  return { id: profile.id, name: profile.name, roomRms: profile.roomRms ?? null, notes }
}

/** The active profile's engine calibration, straight from storage (or null). */
export function loadActiveCalibration() {
  const s = loadStore()
  return toEngineCalibration(getActiveProfile(s))
}

/** rmsGate suggestion from a measured room-tone RMS (null = keep the default). */
export function gateFromRoomRms(roomRms) {
  if (!Number.isFinite(roomRms) || roomRms <= 0) return null
  return round(clamp(roomRms * 4, 0.003, 0.01), 4)
}
