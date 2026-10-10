/**
 * Take capture: ring buffer + event log + file format + offline replay.
 * Synthetic audio only (no samples needed).   npm run test:take
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PitchEngine, DEFAULT_CONFIG } from '../src/input/predictiveDetector.js'
import { TakeRecorder, encodeTake, decodeTake, configDiff, takeFileName } from '../src/input/takeRecorder.js'
import { StrikeRecorder } from '../src/input/micCalibration.js'

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  — ' + extra : ''}`) }

// ---- ring buffer ---------------------------------------------------------------
{
  const r = new TakeRecorder(1000, 2) // 2000-sample ring
  const ramp = (a, b) => Float32Array.from({ length: b - a }, (_, i) => (a + i) / 10000)
  r.pushAudio(ramp(0, 700)); r.pushAudio(ramp(700, 1500))
  let s = r.snapshot()
  check('under capacity: all audio kept, in order', s.audio.length === 1500 && s.audio[0] === 0 && Math.abs(s.audio[1499] - 0.1499) < 1e-6)
  r.pushAudio(ramp(1500, 3300)) // wraps the ring
  s = r.snapshot()
  check('wrapped ring: exactly capacity samples', s.audio.length === 2000, `${s.audio.length}`)
  check('wrapped ring: chronological (oldest = sample 1300, newest = 3299)',
    Math.abs(s.audio[0] - 0.13) < 1e-6 && Math.abs(s.audio[1999] - 0.3299) < 1e-6 && s.audio.every((v, i) => i === 0 || v > s.audio[i - 1]))
  r.pushAudio(ramp(3300, 9000)) // one chunk bigger than the ring
  s = r.snapshot()
  check('chunk larger than the ring keeps the newest samples', s.audio.length === 2000 && Math.abs(s.audio[1999] - 0.8999) < 1e-6 && Math.abs(s.audio[0] - 0.7000) < 1e-6)
  check('duration/clock consistent', Math.abs(s.duration - 2) < 1e-9 && Math.abs(r.now() - 9) < 1e-9)
}

// ---- event log windowing --------------------------------------------------------
{
  const r = new TakeRecorder(1000, 5)
  r.pushAudio(new Float32Array(1000)); r.logExpected([60], { mono: true })       // t=1
  r.pushAudio(new Float32Array(2000)); r.logExpected([62, 66], {})               // t=3
  r.pushAudio(new Float32Array(9000)); r.logExpected([64], { anyOctave: true })  // t=12 (window now 7..12)
  for (let i = 0; i < 5; i++) { r.pushAudio(new Float32Array(100)); r.logTick({ held: [64], onset: i === 0, rms: 0.0123456789 }) }
  const s = r.snapshot({ context: { page: 'test' } })
  check('state at window start carried over, newer events kept',
    s.expected.length === 2 && s.expected[0].t === 0 && JSON.stringify(s.expected[0].midis) === '[62,66]' && s.expected[1].anyOctave === true, JSON.stringify(s.expected))
  check('event times are relative to the window', Math.abs(s.expected[1].t - (12 - 7.5)) < 1e-6 || s.expected[1].t > 4, `${s.expected[1].t}`)
  check('detections logged with rounded rms', s.detections.length === 5 && s.detections[0].onset === true && s.detections[0].rms === 0.01235)
  check('meta carries context and highpass flag', s.meta.context.page === 'test' && s.meta.highpassApplied === true)
}

// ---- file format -----------------------------------------------------------------
{
  const audio = Float32Array.from({ length: 5000 }, (_, i) => 0.8 * Math.sin(i / 7))
  const take = { version: 1, sampleRate: 48000, duration: 5000 / 48000, audio, expected: [{ t: 0, midis: [60], mono: false, anyOctave: false }], detections: [], meta: { calibration: null } }
  const back = decodeTake(encodeTake(take))
  let err = 0; for (let i = 0; i < audio.length; i++) err = Math.max(err, Math.abs(back.audio[i] - audio[i]))
  check('audio survives the file format within 16-bit precision', back.audio.length === audio.length && err < 1 / 32000, `max err ${err.toExponential(1)}`)
  check('metadata survives the file format', back.sampleRate === 48000 && back.expected[0].midis[0] === 60)
  let threw = false; try { decodeTake('{"version":99}') } catch { threw = true }
  check('rejects a file that is not a take', threw)
  check('config diff lists only non-defaults', JSON.stringify(configDiff({ ...DEFAULT_CONFIG, calibK: 1.1, rmsGate: 0.007 }, DEFAULT_CONFIG)) === '{"rmsGate":0.007,"calibK":1.1}' || (() => { const d = configDiff({ ...DEFAULT_CONFIG, calibK: 1.1, rmsGate: 0.007 }, DEFAULT_CONFIG); return Object.keys(d).length === 2 && d.calibK === 1.1 && d.rmsGate === 0.007 })())
  check('file name is sortable and filesystem-safe', /^pianly-take-\d{8}-\d{6}\.json$/.test(takeFileName(new Date(2026, 9, 11, 8, 5, 3))), takeFileName(new Date(2026, 9, 11, 8, 5, 3)))
}

// ---- end to end: record a "practice session", save, replay with the tool ---------
{
  const SR = 48000, N = DEFAULT_CONFIG.frameSize, HOP = 1200
  const f = (m) => 440 * 2 ** ((m - 69) / 12)
  const sig = new Float32Array(SR * 9)
  const note = (m, t0, hold) => {
    const i0 = Math.round(t0 * SR), i1 = Math.min(sig.length, Math.round((t0 + hold) * SR))
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / SR, env = Math.min(1, t / 0.01) * Math.exp(-t / 1.4) * Math.min(1, (i1 - i) / 2400)
      for (let k = 1; k <= 5; k++) sig[i] += (0.1 / k) * env * Math.sin(2 * Math.PI * k * f(m) * t)
    }
  }
  // steps: C4 | E4+G4 | A2 alone while the target is the A2+A3 pair
  note(60, 1.0, 1.2); note(64, 3.0, 1.2); note(67, 3.0, 1.2); note(57, 6.0, 1.6)
  const STEPS = [[0.5, [60]], [2.5, [64, 67]], [5.5, [57, 69]]]

  // A calibration profile for A2, recorded from a lone strike the way the wizard does.
  const cal = (() => {
    const save = sig.slice(); sig.fill(0); note(57, 0.3, 2.0)
    const e = new PitchEngine(SR, DEFAULT_CONFIG); e.setExpected([57], { mono: false }); e.watchAttack(57)
    const sr = new StrikeRecorder(57, { binHz: e.binHz, bins: e.bins }); const w = new Float32Array(N)
    for (let end = N; end <= sig.length; end += HOP) { w.set(sig.subarray(end - N, end)); const r = e.process(w, end / SR); sr.add(e, e.attackAge(57), r.rms) }
    sig.set(save)
    return sr.finish().entry
  })()
  check('synthetic A2 calibration recorded for the take', !!cal)
  const calObj = { id: 'p1', name: 'Test piano', roomRms: null, notes: { 57: cal } }

  const eng = new PitchEngine(SR, DEFAULT_CONFIG)
  eng.setCalibration(calObj)
  const rec = new TakeRecorder(SR, 30)
  let si = 0
  const fr = new Float32Array(N)
  let written = 0
  for (let end = N; end <= sig.length; end += HOP) {
    rec.pushAudio(sig.subarray(written, end)); written = end
    const t = end / SR
    while (si < STEPS.length && STEPS[si][0] <= t) { eng.setExpected(STEPS[si][1], { mono: STEPS[si][1].length === 1 }); rec.logExpected(STEPS[si][1], { mono: STEPS[si][1].length === 1 }); si++ }
    fr.set(sig.subarray(end - N, end))
    const r = eng.process(fr, t)
    rec.logTick({ held: r.heldMidi, onset: r.onset, rms: r.rms })
  }
  const take = rec.snapshot({ config: {}, calibration: calObj, context: { page: 'test' } })
  const dir = mkdtempSync(join(tmpdir(), 'pianly-take-'))
  const path = join(dir, takeFileName())
  writeFileSync(path, encodeTake(take))
  check('a saved 9 s take is a reasonable size', readFileSync(path).length < 1.2e6, `${(readFileSync(path).length / 1e6).toFixed(2)} MB`)

  const tool = fileURLToPath(new URL('./replayTake.mjs', import.meta.url))
  const out = execFileSync('node', [tool, path, '--wav', join(dir, 't.wav')], { encoding: 'utf8' })
  console.log(out.split('\n').map((l) => '       ' + l).join('\n'))
  check('replay lists the three steps and the calibration it carried', /3 steps/.test(out) && /calibration: Test piano \(1 notes\)/.test(out))
  check('with its calibration: C4 and E4+G4 complete, the lone A2 does NOT complete the pair', /replay completed 2, live completed 2/.test(out), out.split('\n').find((l) => /steps/.test(l)))
  const bare = execFileSync('node', [tool, path, '--no-calibration'], { encoding: 'utf8' })
  check('--no-calibration replays the same audio without the profile (lone A2 falsely completes)', /replay completed 3, live completed 2/.test(bare), bare.split('\n').find((l) => /steps/.test(l)))
  check('replay writes a listenable wav', readFileSync(join(dir, 't.wav')).length === 44 + take.audio.length * 2)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
