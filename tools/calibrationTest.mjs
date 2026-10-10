/**
 * Offline evaluation of mic calibration against REAL piano recordings.
 *
 * Calibrates a note from one recording (one dynamic), then tests octave-pair
 * targets built from OTHER dynamics, with the hazards a real player brings:
 * random relative strike timing (=> random phase between a lower note's 2nd
 * partial and the upper note's fundamental), mismatched hand volumes, and room
 * noise. Compared against the same engine with NO calibration.
 *
 * Needs tools/samples/{FF,MF,Mp,PP}_<note>.ogg (gitignored; see TUNING.md) and
 * ffmpeg on PATH. Skips cleanly (exit 0) if they are missing.
 *
 *   npm run test:calibration
 *   CALIB_K=2.2 npm run test:calibration      # try another calibK
 *   CALIB_VERBOSE=1 npm run test:calibration  # per-trial lines
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PitchEngine, DEFAULT_CONFIG, highpassInPlace } from '../src/input/predictiveDetector.js'
import { StrikeRecorder } from '../src/input/micCalibration.js'

const SR = 48000
const DIR = fileURLToPath(new URL('./samples/', import.meta.url))
const VERBOSE = !!process.env.CALIB_VERBOSE
const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const midiOf = (n) => { const m = n.match(/^([A-G])(#?)(\d)$/); return BASE[m[1]] + (m[2] ? 1 : 0) + (+m[3] + 2) * 12 }
const file = (dyn, n) => `${DIR}${dyn}_${n}.ogg`

if (!existsSync(file('FF', 'A2'))) {
  console.log('tools/samples/ not present — skipping calibration evaluation (see tools/TUNING.md).')
  process.exit(0)
}

const cache = new Map()
function sample(dyn, n) {
  const k = dyn + n
  if (!cache.has(k)) {
    const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file(dyn, n),
      '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
    cache.set(k, new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)))
  }
  return cache.get(k)
}

let seed = 424242
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
function noise(n, rms) {
  const o = new Float32Array(n); let b = 0, e = 0
  for (let i = 0; i < n; i++) { b = 0.97 * b + (rnd() * 2 - 1) * 0.2; o[i] = b; e += b * b }
  const g = rms / Math.sqrt(e / n)
  for (let i = 0; i < n; i++) o[i] *= g
  return o
}

const cfgBase = { ...DEFAULT_CONFIG }
if (process.env.CALIB_K) cfgBase.calibK = +process.env.CALIB_K
const hop = Math.round((cfgBase.analysisIntervalMs / 1000) * SR)
const LEAD = 1.0, DUR = 2.0

// ---- calibration (the wizard's exact capture path, offline) ----------------
function calibrate(dyn, note) {
  const midi = midiOf(note)
  const sig = highpassInPlace((() => {
    const s = sample(dyn, note), o = new Float32Array(Math.round((0.5 + 1.6) * SR))
    o.set(s.subarray(0, Math.min(s.length, o.length - Math.round(0.5 * SR))), Math.round(0.5 * SR))
    return o
  })(), SR, cfgBase.highpassHz)
  const eng = new PitchEngine(SR, cfgBase)
  eng.setExpected([midi], { mono: false })
  eng.watchAttack(midi)
  const rec = new StrikeRecorder(midi, { binHz: eng.binHz, bins: eng.bins })
  for (let p = 0; p + cfgBase.frameSize <= sig.length; p += hop) {
    const r = eng.process(sig.subarray(p, p + cfgBase.frameSize))
    rec.add(eng, eng.attackAge(midi), r.rms)
  }
  return rec.finish()
}

// ---- trial -----------------------------------------------------------------
function render(parts, noiseRms) {
  const n = Math.round((LEAD + DUR) * SR)
  const out = new Float32Array(n)
  for (const { dyn, note, gain, delay } of parts) {
    const s = sample(dyn, note), off = Math.round((LEAD + delay) * SR)
    for (let k = 0; k < s.length && off + k < n; k++) out[off + k] += s[k] * gain
  }
  let pk = 0; for (const v of out) pk = Math.max(pk, Math.abs(v))
  if (pk > 0.9) for (let k = 0; k < n; k++) out[k] *= 0.9 / pk
  let nz = null
  if (noiseRms) { nz = noise(n, noiseRms); for (let k = 0; k < n; k++) out[k] += nz[k] }
  return { sig: out, nz }
}

function trial({ target, parts, calib, noiseRms }) {
  const { sig, nz } = render(parts, noiseRms)
  const eng = new PitchEngine(SR, cfgBase)
  const tm = target.map(midiOf)
  eng.setExpected(tm, { mono: false })
  if (calib) eng.setCalibration({ notes: calib })
  if (nz) {
    const l = highpassInPlace(nz.slice(0, Math.round(0.9 * SR)), SR, cfgBase.highpassHz)
    for (let p = 0; p + cfgBase.frameSize <= l.length; p += hop) eng.learnNoise(l.subarray(p, p + cfgBase.frameSize))
  }
  const hp = highpassInPlace(sig, SR, cfgBase.highpassHz)
  let streak = 0, firstFull = null, maxStreak = 0
  for (let p = 0; p + cfgBase.frameSize <= hp.length; p += hop) {
    const t = (p + cfgBase.frameSize) / SR - LEAD
    const r = eng.process(hp.subarray(p, p + cfgBase.frameSize))
    if (t < 0 || t > 1.5) continue
    const cur = new Set(r.heldMidi)
    const full = tm.every((m) => cur.has(m))
    streak = full ? streak + 1 : 0
    if (streak > maxStreak) maxStreak = streak
    if (streak >= 2 && firstFull == null) firstFull = t
  }
  return { full: firstFull != null, ms: firstFull != null ? firstFull * 1000 : null, maxStreak }
}

// ---- scenarios --------------------------------------------------------------
const DYNS = { A1: ['FF', 'MF', 'Mp', 'PP'], A2: ['FF', 'MF', 'Mp', 'PP'], A3: ['FF', 'MF', 'Mp', 'PP'], A4: ['FF', 'Mp', 'PP'] }
const ONLY = process.env.CALIB_PAIR
const PAIRS = [
  { lo: 'A1', hi: 'A2', n: 2 },
  { lo: 'A2', hi: 'A3', n: 2 },
  { lo: 'A3', hi: 'A4', n: 2 },
  { lo: 'A1', hi: 'A3', n: 4 },
  { lo: 'A2', hi: 'A4', n: 4 },
]
const TRIALS = 3
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-').padStart(4)
const med = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? Math.round(s[s.length >> 1]) : null }

console.log(`calibK=${cfgBase.calibK}  (calibrate on one dynamic, test on every dynamic; ${TRIALS} random-phase trials each)\n`)
console.log('pair      | calibrated lower alone: false accept | both played: detected, latency (ms)')
console.log('          |   uncalibrated  calibrated           |   uncalibrated        calibrated')
let totals = { faU: 0, faC: 0, faN: 0, dU: 0, dC: 0, dN: 0, latC: [], latU: [], skipped: 0 }

for (const pair of PAIRS.filter((p) => !ONLY || ONLY === p.lo + '+' + p.hi)) {
  const per = { faU: 0, faC: 0, faN: 0, dU: 0, dC: 0, dN: 0, latC: [], latU: [] }
  for (const calDyn of DYNS[pair.lo]) {
    const c = calibrate(calDyn, pair.lo)
    if (!c.entry) { console.log(`  calibration of ${calDyn}_${pair.lo} failed: ${c.error}`); totals.skipped++; continue }
    const calib = { [midiOf(pair.lo)]: c.entry }
    for (const tLo of DYNS[pair.lo]) for (const tHi of DYNS[pair.hi]) {
      for (let k = 0; k < TRIALS; k++) {
        const noiseRms = k === TRIALS - 1 ? 0.004 : 0
        const gLo = 0.6 + rnd() * 0.6, gHi = 0.6 + rnd() * 0.6, delay = rnd() * 0.008
        const target = [pair.lo, pair.hi]
        // lower note ALONE: must NOT be reported as the pair
        const alone = [{ dyn: tLo, note: pair.lo, gain: gLo, delay: 0 }]
        const aU = trial({ target, parts: alone, calib: null, noiseRms })
        const aC = trial({ target, parts: alone, calib, noiseRms })
        per.faN++; if (aU.full) per.faU++; if (aC.full) per.faC++
        // both played: must be reported
        const both = [{ dyn: tLo, note: pair.lo, gain: gLo, delay: 0 }, { dyn: tHi, note: pair.hi, gain: gHi, delay }]
        const bU = trial({ target, parts: both, calib: null, noiseRms })
        const bC = trial({ target, parts: both, calib, noiseRms })
        per.dN++
        if (bU.full) { per.dU++; per.latU.push(bU.ms) }
        if (bC.full) { per.dC++; per.latC.push(bC.ms) }
        if (VERBOSE) console.log(`  cal=${calDyn} lo=${tLo} hi=${tHi} k=${k} aloneFA U/C=${+aU.full}/${+aC.full} both U/C=${+bU.full}/${+bC.full} (${bC.ms ?? '-'}ms)`)
      }
    }
  }
  console.log(`${(pair.lo + '+' + pair.hi + ' (n=' + pair.n + ')').padEnd(9)} |   ${pct(per.faU, per.faN)}           ${pct(per.faC, per.faN)}                 |   ${pct(per.dU, per.dN)} ${String(med(per.latU) ?? '-').padStart(4)}ms        ${pct(per.dC, per.dN)} ${String(med(per.latC) ?? '-').padStart(4)}ms`)
  for (const k of ['faU', 'faC', 'faN', 'dU', 'dC', 'dN']) totals[k] += per[k]
  totals.latC.push(...per.latC); totals.latU.push(...per.latU)
}
console.log('')
console.log(`TOTAL false accept (lower note alone reported as the pair): uncalibrated ${pct(totals.faU, totals.faN)}  ->  calibrated ${pct(totals.faC, totals.faN)}   (${totals.faN} trials)`)
console.log(`TOTAL pair detected when both played:                        uncalibrated ${pct(totals.dU, totals.dN)}  ->  calibrated ${pct(totals.dC, totals.dN)}   median latency ${med(totals.latU)} -> ${med(totals.latC)} ms`)
const bad = totals.faC / totals.faN > 0.15 || totals.dC / totals.dN < 0.9
if (process.env.CALIB_STRICT && bad) { console.log('FAIL (strict thresholds: false accept <= 15%, detected >= 90%)'); process.exit(1) }
