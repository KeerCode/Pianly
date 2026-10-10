/**
 * End-to-end test of the mic-setup wizard (CalibrationSession) and its saved
 * profile, driven from real piano recordings through the real engine.
 *
 * The "player" does what a person does wrong in setup: plays a wrong note,
 * plays the right note an octave off, lets a key go too early — and the
 * wizard must refuse each, say what it heard, and still end with a correct
 * profile that survives a save/load round-trip.
 *
 * Needs tools/samples/FF_{A2,E3,C4,G3,E4,C3}.ogg (gitignored) + ffmpeg;
 * skips cleanly (exit 0) without them.   npm run test:wizard
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PitchEngine, DEFAULT_CONFIG, highpassInPlace } from '../src/input/predictiveDetector.js'
import { CalibrationSession, noteName } from '../src/input/calibrationSession.js'
import * as store from '../src/input/micCalibration.js'

const DIR = fileURLToPath(new URL('./samples/', import.meta.url))
if (!existsSync(`${DIR}FF_A2.ogg`)) { console.log('tools/samples/ not present — skipping wizard test.'); process.exit(0) }

// Minimal localStorage so the persistence layer is exercised for real.
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)) },
  removeItem: (k) => { mem.delete(k) },
}

const SR = 48000
const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const midiOf = (n) => { const m = n.match(/^([A-G])(#?)(\d)$/); return BASE[m[1]] + (m[2] ? 1 : 0) + (+m[3] + 2) * 12 }
const load = (n) => {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${DIR}FF_${n}.ogg`,
    '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
}

// ---- the scripted player ---------------------------------------------------
// [startSec, note, heldSec]  — what the human actually does.
const SCRIPT = [
  [2.6, 'G3', 1.0],   // asked for A2: wrong note
  [5.2, 'A2', 0.25],  // right note, lifted far too early
  [7.8, 'A2', 1.8],   // right note, held properly
  [11.0, 'E4', 1.0],  // asked for E3: an octave up
  [13.4, 'E3', 1.8],  // right
  [16.6, 'C3', 1.2],  // asked for C4: an octave DOWN
  [19.2, 'C4', 1.8],  // right
]
const TOTAL = 22.5
const sig = new Float32Array(Math.round(TOTAL * SR))
// quiet room tone
let seed = 7
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
let brown = 0
for (let i = 0; i < sig.length; i++) { brown = 0.97 * brown + (rnd() * 2 - 1) * 0.002; sig[i] = brown }
for (const [t0, note, hold] of SCRIPT) {
  const s = load(note), off = Math.round(t0 * SR), len = Math.min(s.length, Math.round(hold * SR))
  const fade = Math.round(0.08 * SR) // damper: short fade, not a click
  for (let i = 0; i < len; i++) sig[off + i] += s[i] * (i > len - fade ? (len - i) / fade : 1)
}
const hp = highpassInPlace(sig, SR, DEFAULT_CONFIG.highpassHz)

// ---- run the wizard ---------------------------------------------------------
const ASK = ['A2', 'E3', 'C4'].map(midiOf)
const engine = new PitchEngine(SR, DEFAULT_CONFIG)
const entries = []
let roomRms = null
const messages = []
const session = new CalibrationSession({
  engine, midis: ASK,
  onEntry: (e) => entries.push(e),
  onRoom: (r) => { roomRms = r },
  onChange: () => { const v = session.view; if (messages[messages.length - 1] !== v.message) messages.push(v.message) },
})
const hop = Math.round((DEFAULT_CONFIG.analysisIntervalMs / 1000) * SR)
let clock = 0
for (let p = 0; p + DEFAULT_CONFIG.frameSize <= hp.length && !session.finished; p += hop) {
  clock = (p + DEFAULT_CONFIG.frameSize) / SR
  const r = engine.process(hp.subarray(p, p + DEFAULT_CONFIG.frameSize), clock)
  session.feed({ t: clock, rms: r.rms, silent: r.silent, heldMidi: r.heldMidi })
}

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  — ' + extra : ''}`) }

console.log('wizard session messages:')
for (const m of messages) console.log('   ·', m)
console.log('')
check('session finishes with all three notes', session.finished && entries.length === 3, `${entries.length} entries, finished=${session.finished}`)
check('room tone measured (quiet room)', roomRms != null && roomRms < 0.01, roomRms != null ? `rms ${roomRms.toFixed(4)}` : 'none')
check('wrong note G3 was named, not recorded', messages.some((m) => /heard G3/.test(m)))
check('too-short strike rejected with a reason', messages.some((m) => /Too short/i.test(m)))
check('E4 (octave up) never recorded as E3', !entries.some((e) => e.midi === midiOf('E3') && Math.abs(1200 * Math.log2(e.f[0] / (440 * 2 ** ((e.midi - 69) / 12)))) > 60))
check('C3 (octave down) was refused for C4', messages.some((m) => /heard C3|octave too low/i.test(m)))
for (const e of entries) {
  const nominal = 440 * 2 ** ((e.midi - 69) / 12)
  const cents = 1200 * Math.log2(e.f[0] / nominal)
  check(`${noteName(e.midi)}: measured pitch within 30¢ of nominal`, Math.abs(cents) < 30, `${cents.toFixed(1)}¢`)
  check(`${noteName(e.midi)}: decay curve covers >= 0.8 s with partial ratios`, e.ages[e.ages.length - 1] >= 0.8 && e.r[2]?.length === e.ages.length, `to ${e.ages[e.ages.length - 1]}s`)
}

// ---- persistence round trip ---------------------------------------------------
let st = store.addProfile(store.emptyStore(), 'Test upright')
const id = st.activeId
for (const e of entries) st = store.upsertNote(st, id, e)
st = store.updateProfile(st, id, { roomRms })
check('profile saves', store.saveStore(st) === true)
const back = store.loadStore()
const cal = store.loadActiveCalibration()
check('profile survives a reload', back.profiles.length === 1 && back.profiles[0].name === 'Test upright')
check('engine calibration built from storage', cal && Object.keys(cal.notes).length === 3 && cal.roomRms === roomRms)
check('rmsGate derived from measured room tone', store.gateFromRoomRms(roomRms) >= 0.003 && store.gateFromRoomRms(roomRms) <= 0.01, `${store.gateFromRoomRms(roomRms)}`)

// second profile = a different piano; switching keeps both, recalibrating one doesn't touch the other
st = store.addProfile(st, 'Digital')
check('second piano profile becomes active', store.getActiveProfile(st).name === 'Digital' && st.profiles.length === 2)
st = store.setActive(st, id)
check('switching back restores the first profile\'s notes', Object.keys(store.getActiveProfile(st).notes).length === 3)
st = store.clearProfile(st, id)
check('recalibrating one piano clears only that piano', Object.keys(store.getActiveProfile(st).notes).length === 0 && st.profiles.length === 2)
st = store.deleteProfile(st, id)
check('deleting a piano activates another', st.profiles.length === 1 && st.activeId === st.profiles[0].id)
mem.set(store.STORE_KEY, '{not json')
check('corrupt storage degrades to empty, not a crash', store.loadStore().profiles.length === 0)

// ---- lower-note inputs: presets + piece-driven selection ------------------------
{
  const P = store.SETUP_PRESETS
  check('bass preset covers E0-B1 white keys, all below C2', P.bass.midis[0] === 28 && P.bass.midis.at(-1) === 47 && P.bass.midis.every((m) => m < 48), `${P.bass.midis.length} notes`)
  check('essential preset still C2-C5 white keys', P.essential.midis[0] === 48 && P.essential.midis.at(-1) === 84)
  const lowers = store.octavePairLowers([[57, 69, 76], [60, 64, 67], [45, 69], [52, 64, 76], [50, 57]])
  check('octavePairLowers: A2 (+A3), A1 (+A3 two octaves), E2 (+E3,+E4) and E3 (+E4)', JSON.stringify(lowers) === JSON.stringify([45, 52, 57, 64]), JSON.stringify(lowers))
  check('octavePairLowers: fifths and plain chords are not pairs', store.octavePairLowers([[60, 67], [60, 64, 67]]).length === 0)
}

// ---- a note the mic cannot lock onto: the wizard says so instead of hanging -------
{
  const eng = new PitchEngine(SR, DEFAULT_CONFIG)
  const sess2 = new CalibrationSession({ engine: eng, midis: [midiOf('F0')], room: false })
  const sig2 = new Float32Array(Math.round(7 * SR))
  // a loud, non-pitched thump at 1.0 s with a slow tail: struck, but no F0 in it
  for (let i = Math.round(1.0 * SR); i < sig2.length; i++) {
    const t = (i - 1.0 * SR) / SR
    sig2[i] = 0.12 * Math.exp(-t / 3) * (rnd() * 2 - 1)
  }
  const hp2 = highpassInPlace(sig2, SR, DEFAULT_CONFIG.highpassHz)
  let sawHint = false
  for (let p = 0; p + DEFAULT_CONFIG.frameSize <= hp2.length; p += hop) {
    const t = (p + DEFAULT_CONFIG.frameSize) / SR
    const r = eng.process(hp2.subarray(p, p + DEFAULT_CONFIG.frameSize), t)
    sess2.feed({ t, rms: r.rms, silent: r.silent, heldMidi: r.heldMidi })
    if (/can't pick out F0/.test(sess2.view.message)) sawHint = true
  }
  check('unlockable note: wizard explains and offers to skip', sawHint, sess2.view.message)
  sess2.skip()
  check('unlockable note: skipping moves on and finishes', sess2.finished && sess2.view.skipped.length === 1)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
