/**
 * Offline driver for the predictive note detector.
 *
 * Feeds a recorded audio file through the exact PitchEngine used live and prints
 * the notes it detects, so detector tuning can be checked against real playing
 * without rebuilding the desktop app.
 *
 * Requires ffmpeg on PATH (any input format is accepted; it is decoded to mono
 * float PCM at --rate).
 *
 * Usage:
 *   node tools/analyzeAudio.mjs play.wav
 *   node tools/analyzeAudio.mjs play.m4a --expected "C4,E4,G4"
 *   node tools/analyzeAudio.mjs play.wav --noise room.wav --truth truth.json
 *   node tools/analyzeAudio.mjs play.wav --set tOnScan=0.38 --set frameSize=16384
 *   node tools/analyzeAudio.mjs play.wav --csv > frames.csv
 *
 * --expected  comma list of note names or MIDI numbers, applied for the whole file
 * --noise     an audio file of room tone; its spectrum is learned before analysis
 * --truth     JSON: [60,64,67]  or  [{midi,onset,offset}, ...]  (seconds)
 * --rate      decode sample rate (default 48000)
 * --hop       analysis hop in ms (default = engine analysisIntervalMs)
 * --set k=v   override a DEFAULT_CONFIG field (repeatable). Numbers are parsed.
 * --csv       print per-hop "time,held" rows instead of the event summary
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PitchEngine, DEFAULT_CONFIG, highpassInPlace, midiToNoteNamePitch }
  from '../src/input/predictiveDetector.js'

// ---- args ---------------------------------------------------------------

const argv = process.argv.slice(2)
const files = []
const opts = { rate: 48000, set: {} }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--expected') opts.expected = argv[++i]
  else if (a === '--noise') opts.noise = argv[++i]
  else if (a === '--truth') opts.truth = argv[++i]
  else if (a === '--rate') opts.rate = +argv[++i]
  else if (a === '--hop') opts.hop = +argv[++i]
  else if (a === '--csv') opts.csv = true
  else if (a === '--set') { const [k, v] = argv[++i].split('='); opts.set[k] = isNaN(+v) ? v : +v }
  else if (a.startsWith('--')) { console.error('unknown flag', a); process.exit(2) }
  else files.push(a)
}
if (files.length !== 1) {
  console.error('usage: node tools/analyzeAudio.mjs <audio> [flags]  (see header)')
  process.exit(2)
}

const NAME_RE = /^([A-Ga-g])([#b]?)(-?\d+)$/
const BASE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
function toMidi(tok) {
  tok = tok.trim()
  if (/^-?\d+$/.test(tok)) return +tok
  const m = tok.match(NAME_RE)
  if (!m) return null
  let s = BASE[m[1].toLowerCase()]
  if (m[2] === '#') s++
  else if (m[2] === 'b') s--
  return s + (parseInt(m[3], 10) + 2) * 12 // app convention: middle C = C3 = 60
}

// ---- decode via ffmpeg -> Float32Array --------------------------------

function decode(path, rate) {
  const raw = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', path, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-',
  ], { maxBuffer: 1 << 30 })
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
}


const cfg = { ...DEFAULT_CONFIG, ...opts.set }
const SR = opts.rate
const hopMs = opts.hop ?? cfg.analysisIntervalMs
const hop = Math.max(1, Math.round((hopMs / 1000) * SR))

const engine = new PitchEngine(SR, cfg)
if (opts.expected) {
  const midis = opts.expected.split(',').map(toMidi).filter((x) => x != null)
  engine.setExpected(midis)
  console.error('expected prior:', midis.map(midiToNoteNamePitch).join(' '))
}

if (opts.noise) {
  const n = highpassInPlace(decode(opts.noise, SR), SR, cfg.highpassHz)
  let learned = 0
  for (let p = 0; p + cfg.frameSize <= n.length; p += hop) {
    engine.learnNoise(n.subarray(p, p + cfg.frameSize)); learned++
  }
  console.error(`learned noise profile from ${learned} frames of ${opts.noise}`)
}

const sig = highpassInPlace(decode(files[0], SR), SR, cfg.highpassHz)
console.error(`${files[0]}: ${(sig.length / SR).toFixed(2)}s @ ${SR}Hz, frame ${cfg.frameSize}, hop ${hopMs}ms\n`)

// ---- run ---------------------------------------------------------------

const heldSince = new Map()   // midi -> onset time (s)
const events = []             // { midi, onset, offset }
let prev = new Set()

function emitOffsets(now, curSet) {
  for (const midi of prev) {
    if (!curSet.has(midi)) {
      events.push({ midi, onset: heldSince.get(midi), offset: now })
      heldSince.delete(midi)
    }
  }
}

for (let p = 0; p + cfg.frameSize <= sig.length; p += hop) {
  const t = p / SR
  const r = engine.process(sig.subarray(p, p + cfg.frameSize))
  const cur = new Set(r.heldMidi)
  emitOffsets(t, cur)
  for (const midi of cur) if (!heldSince.has(midi)) heldSince.set(midi, t)
  prev = cur
  if (opts.csv) console.log(`${t.toFixed(3)},${r.held.join(' ')}`)
}
const end = sig.length / SR
emitOffsets(end, new Set())

if (opts.csv) process.exit(0)

// ---- report ----------------------------------------------------------

events.sort((a, b) => a.onset - b.onset || a.midi - b.midi)
console.log('detected note events:')
for (const e of events) {
  console.log(
    `  ${e.onset.toFixed(2)}s  ${midiToNoteNamePitch(e.midi).padEnd(4)} `
    + `midi ${String(e.midi).padStart(3)}  (${(e.offset - e.onset).toFixed(2)}s)`,
  )
}
console.log(`\n${events.length} events`)

if (opts.truth) {
  const truthRaw = JSON.parse(readFileSync(opts.truth, 'utf8'))
  const truth = truthRaw.map((x) => (typeof x === 'number' ? { midi: x } : x))
  const used = new Array(events.length).fill(false)
  let tp = 0, octave = 0
  const missed = []
  for (const gt of truth) {
    let hit = -1
    for (let i = 0; i < events.length; i++) {
      if (used[i]) continue
      if (events[i].midi !== gt.midi) continue
      if (gt.onset != null && Math.abs(events[i].onset - gt.onset) > 0.3) continue
      hit = i; break
    }
    if (hit >= 0) { used[hit] = true; tp++; continue }
    // octave-error credit
    const oct = events.findIndex((e, i) => !used[i] && Math.abs(e.midi - gt.midi) % 12 === 0 && e.midi !== gt.midi)
    if (oct >= 0) { used[oct] = true; octave++; missed.push({ ...gt, note: 'octave error -> ' + midiToNoteNamePitch(events[oct].midi) }) }
    else missed.push(gt)
  }
  const fp = used.filter((u) => !u).length
  const precision = tp / (tp + fp || 1)
  const recall = tp / (truth.length || 1)
  const f1 = (2 * precision * recall) / (precision + recall || 1)
  console.log('\n--- vs truth ---')
  console.log(`true positives : ${tp}/${truth.length}`)
  console.log(`octave errors  : ${octave}`)
  console.log(`false positives: ${fp}`)
  console.log(`precision ${precision.toFixed(3)}  recall ${recall.toFixed(3)}  F1 ${f1.toFixed(3)}`)
  if (missed.length) {
    console.log('missed / wrong:')
    for (const m of missed) console.log(`  ${midiToNoteNamePitch(m.midi)} (midi ${m.midi})${m.note ? '  ' + m.note : ''}`)
  }
  if (fp) {
    console.log('unmatched detections:')
    events.forEach((e, i) => { if (!used[i]) console.log(`  ${e.onset.toFixed(2)}s ${midiToNoteNamePitch(e.midi)} (midi ${e.midi})`) })
  }
}
