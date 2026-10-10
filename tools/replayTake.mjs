/**
 * Replay a saved take (the "Save last 30 s" button in the mic debug panel)
 * through the exact PitchEngine, with the same expected-note timeline and the
 * calibration profile it was recorded with, and compare with what the live
 * run reported.
 *
 *   node tools/replayTake.mjs take.json
 *   node tools/replayTake.mjs take.json --no-calibration      # what would it do without the profile?
 *   node tools/replayTake.mjs take.json --set calibK=1.3      # try a knob on YOUR piano
 *   node tools/replayTake.mjs take.json --wav take.wav        # listen to it
 *   node tools/replayTake.mjs take.json --verbose             # every reported change
 *
 * One row per expected-note segment (each time the page called setExpected):
 * when the whole target was first reported, in the live run and the replay,
 * and any extra notes that showed up while it was the target.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { PitchEngine, DEFAULT_CONFIG, midiToNoteNamePitch as nm } from '../src/input/predictiveDetector.js'
import { decodeTake } from '../src/input/takeRecorder.js'

const argv = process.argv.slice(2)
const o = { set: {}, calibration: true }
let file = null
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--no-calibration') o.calibration = false
  else if (a === '--verbose') o.verbose = true
  else if (a === '--wav') o.wav = argv[++i]
  else if (a === '--set') { const [k, v] = argv[++i].split('='); o.set[k] = isNaN(+v) ? v : +v }
  else if (a.startsWith('--')) { console.error('unknown flag', a); process.exit(2) }
  else file = a
}
if (!file) { console.error('usage: node tools/replayTake.mjs <take.json> [--no-calibration] [--set k=v] [--wav out.wav] [--verbose]'); process.exit(2) }

const take = decodeTake(readFileSync(file, 'utf8'))
const SR = take.sampleRate
const cfg = { ...DEFAULT_CONFIG, ...(take.meta?.config || {}), ...o.set }
const engine = new PitchEngine(SR, cfg)
const cal = take.meta?.calibration
if (cal && o.calibration) engine.setCalibration({ id: cal.id, name: cal.name, roomRms: cal.roomRms, notes: cal.notes })

console.log(`${file}: ${take.duration.toFixed(1)} s @ ${SR} Hz, ${take.expected.length} expected-note changes, ${take.detections.length} live reports`)
console.log(`calibration: ${cal && o.calibration ? `${cal.name} (${Object.keys(cal.notes).length} notes)` : cal ? 'present in take, IGNORED (--no-calibration)' : 'none in this take'}`)
if (Object.keys(take.meta?.config || {}).length) console.log('config from take:', JSON.stringify(take.meta.config))
if (Object.keys(o.set).length) console.log('overrides:', JSON.stringify(o.set))
if (take.meta?.context && Object.keys(take.meta.context).length) console.log('context:', JSON.stringify(take.meta.context))
console.log('')

// ---- replay -------------------------------------------------------------
const hop = Math.round((cfg.analysisIntervalMs / 1000) * SR)
const events = [...take.expected].sort((a, b) => a.t - b.t)
let ei = 0
const rep = []
let last = ''
for (let p = 0; p + cfg.frameSize <= take.audio.length; p += hop) {
  const tEnd = (p + cfg.frameSize) / SR
  while (ei < events.length && events[ei].t <= tEnd) {
    const e = events[ei++]
    engine.setExpected(e.midis, { mono: e.mono, anyOctave: e.anyOctave })
  }
  const r = engine.process(take.audio.subarray(p, p + cfg.frameSize), tEnd)
  rep.push({ t: tEnd, held: r.heldMidi, onset: r.onset })
  if (o.verbose) {
    const s = r.held.join(' ')
    if (s !== last) { console.log(`  ${tEnd.toFixed(3)}s  ${s || '-'}`); last = s }
  }
}
if (o.verbose) console.log('')

// ---- per-segment analysis ------------------------------------------------
const pc = (m) => ((m % 12) + 12) % 12
function covers(held, e) {
  const h = new Set(held)
  if (e.anyOctave) {
    const need = new Set(e.midis.map(pc))
    return [...need].every((c) => [...h].some((m) => pc(m) === c))
  }
  return e.midis.every((m) => h.has(m))
}
function extras(held, e) {
  if (e.anyOctave) { const ok = new Set(e.midis.map(pc)); return held.filter((m) => !ok.has(pc(m))) }
  return held.filter((m) => !e.midis.includes(m))
}
function analyse(series, seg, tEnd) {
  const frames = series.filter((f) => f.t >= seg.t && f.t < tEnd)
  const full = frames.find((f) => covers(f.held, seg))
  const ex = new Map()
  for (const f of frames) for (const m of extras(f.held, seg)) ex.set(m, (ex.get(m) || 0) + 1)
  return { full: full ? full.t - seg.t : null, heldOver: !!(full && full.t - seg.t < 0.08), extras: [...ex].filter(([, c]) => c >= 3).map(([m]) => nm(m)) }
}

const rows = []
for (let i = 0; i < events.length; i++) {
  const seg = events[i]
  if (!seg.midis.length) continue
  const tEnd = i + 1 < events.length ? events[i + 1].t : take.duration
  if (tEnd - seg.t < 0.1) continue
  rows.push({ seg, tEnd, live: analyse(take.detections, seg, tEnd), rep: analyse(rep, seg, tEnd) })
}

const fmt = (x) => (x == null ? '   —  ' : `${String(Math.round(x * 1000)).padStart(5)}ms`)
console.log(' #   at     target                   live      replay    extras in replay')
rows.forEach((r, i) => {
  const tgt = (r.seg.anyOctave ? [...new Set(r.seg.midis.map(pc))].map((c) => nm(c + 48).replace(/-?\d+$/, '') + '*') : r.seg.midis.map(nm)).join(' ')
  const flag = r.rep.full == null && r.live.full != null ? '  <- replay MISSED what live caught'
    : r.rep.full != null && r.live.full == null ? '  <- replay caught what live MISSED'
      : r.rep.full == null ? '  <- never completed' : r.rep.heldOver ? '  (already sounding at step start)' : ''
  console.log(`${String(i + 1).padStart(2)}  ${r.seg.t.toFixed(1).padStart(5)}s  ${tgt.padEnd(22)} ${fmt(r.live.full)}  ${fmt(r.rep.full)}   ${r.rep.extras.join(' ') || '-'}${flag}`)
})
const done = rows.filter((r) => r.rep.full != null)
const lat = done.map((r) => r.rep.full).sort((a, b) => a - b)
console.log(`\n${rows.length} steps · replay completed ${done.length}, live completed ${rows.filter((r) => r.live.full != null).length}`
  + (lat.length ? ` · replay latency median ${Math.round(lat[lat.length >> 1] * 1000)} ms, max ${Math.round(lat[lat.length - 1] * 1000)} ms` : '')
  + ` · steps with extra notes: ${rows.filter((r) => r.rep.extras.length).length}`)

if (o.wav) {
  const n = take.audio.length, buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, take.audio[i])) * 32767), 44 + i * 2)
  writeFileSync(o.wav, buf)
  console.log(`wrote ${o.wav}`)
}
