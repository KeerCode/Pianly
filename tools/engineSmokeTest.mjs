// Smoke test for PitchEngine — synthesizes piano-like tones (+ noise) and checks
// the engine reports the right notes.
import { PitchEngine, DEFAULT_CONFIG }
  from '../src/input/predictiveDetector.js'

const SR = 48000
const N = DEFAULT_CONFIG.frameSize
const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12)

function tone(buf, midis, { harmonics = 6, gain = 0.5 } = {}) {
  for (const m of midis) {
    const f0 = midiToFreq(m)
    for (let k = 1; k <= harmonics; k++) {
      const a = gain / k
      const ph = Math.random() * Math.PI * 2
      for (let i = 0; i < buf.length; i++) buf[i] += a * Math.sin((2 * Math.PI * k * f0 * i) / SR + ph)
    }
  }
  return buf
}
const noise = (buf, amp) => { for (let i = 0; i < buf.length; i++) buf[i] += (Math.random() * 2 - 1) * amp; return buf }
const frame = () => new Float32Array(N)

// Feed the same stimulus a few times so hysteresis (framesOnScan) latches.
function detect(engine, makeFrame, reps = 6) {
  let r
  for (let i = 0; i < reps; i++) r = engine.process(makeFrame())
  return r
}

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}   ${detail ?? ''}`) }
}

// 1. Single notes across the range (no prior). Below C3 the 8192/48k window
//    can't resolve a single semitone, so allow a small cluster tolerance.
for (const m of [28, 40, 52, 60, 69, 76, 88, 100]) {
  const e = new PitchEngine(SR)
  const r = detect(e, () => tone(frame(), [m]))
  const tol = m < 48 ? 3 : m < 60 ? 2 : 0
  const hit = r.heldMidi.length >= 1 && r.heldMidi.some((x) => Math.abs(x - m) <= tol)
  check(`single midi ${m} (±${tol})`, hit && r.heldMidi.length <= 3, `got [${r.heldMidi}]`)
}

// 1b. With the score prior, even low notes resolve exactly.
for (const m of [28, 40, 52]) {
  const e = new PitchEngine(SR)
  e.setExpected([m])
  const r = detect(e, () => tone(frame(), [m]))
  check(`single midi ${m} (prior) -> exact`, r.heldMidi.includes(m), `got [${r.heldMidi}]`)
}

// 2. C major triad -> exactly {60,64,67}
{
  const e = new PitchEngine(SR)
  const r = detect(e, () => tone(frame(), [60, 64, 67]))
  check('C major triad', JSON.stringify(r.heldMidi) === JSON.stringify([60, 64, 67]), `got [${r.heldMidi}]`)
}

// 3. Octave ghost: C4 alone, with C4 as the expected prior -> C4 only, no C5
{
  const e = new PitchEngine(SR)
  e.setExpected([60])
  const r = detect(e, () => tone(frame(), [60]))
  check('C4 (prior) -> no C5 ghost', r.heldMidi.includes(60) && !r.heldMidi.includes(72), `got [${r.heldMidi}]`)
}

// 4. Wrong note: score expects C4, player hits E4 -> E4 detected
{
  const e = new PitchEngine(SR)
  e.setExpected([60])
  const r = detect(e, () => tone(frame(), [64]))
  check('expected C4, played E4 -> E4', r.heldMidi.includes(64), `got [${r.heldMidi}]`)
}

// 5. Background-noise rejection: broadband noise only, after learning it -> silence
{
  const e = new PitchEngine(SR)
  for (let i = 0; i < 20; i++) e.learnNoise(noise(frame(), 0.02))
  const r = detect(e, () => noise(frame(), 0.02))
  check('learned noise -> no phantom notes', r.heldMidi.length === 0, `got [${r.heldMidi}]`)
}

// 6. Note buried in noise it has learned: A4 + noise, noise profile primed -> A4 found
{
  const e = new PitchEngine(SR)
  for (let i = 0; i < 20; i++) e.learnNoise(noise(frame(), 0.015))
  const r = detect(e, () => noise(tone(frame(), [69], { gain: 0.4 }), 0.015))
  check('A4 under learned noise -> A4', r.heldMidi.includes(69), `got [${r.heldMidi}]`)
}

// 7. Noise WITHOUT a learned profile still should not fabricate a chord
{
  const e = new PitchEngine(SR)
  const r = detect(e, () => noise(frame(), 0.02))
  check('unlearned noise -> <=1 phantom', r.heldMidi.length <= 1, `got [${r.heldMidi}]`)
}

// 8. Silence -> silent:true, empty
{
  const e = new PitchEngine(SR)
  const r = e.process(frame())
  check('true silence -> silent', r.silent && r.heldMidi.length === 0, JSON.stringify(r))
}

// 9. Monophonic path: a single note with unusually strong upper harmonics
//    (a real piano tone, unlike the 1/k falloff the `tone()` helper defaults
//    to) must not report its own overtones as extra notes when it's the one
//    expected note — this is the exact failure mode the harmonic-comb scan
//    was prone to.
function brightTone(midis, gains = [1, 0.9, 0.75, 0.5, 0.3, 0.15]) {
  const buf = new Float32Array(N)
  for (const m of midis) {
    const f0 = midiToFreq(m)
    gains.forEach((a, i) => {
      const k = i + 1
      for (let n = 0; n < buf.length; n++) buf[n] += a * Math.sin((2 * Math.PI * k * f0 * n) / SR)
    })
  }
  return buf
}
for (const m of [48, 60, 72]) {
  const e = new PitchEngine(SR)
  e.setExpected([m])
  const r = detect(e, () => brightTone([m]))
  check(`bright single midi ${m} (mono, prior) -> exact, no overtone extras`,
    JSON.stringify(r.heldMidi) === JSON.stringify([m]), `got [${r.heldMidi}]`)
}

// 10. Same bright single note, but under a learned background-noise profile —
//     combines both reported symptoms (noise sensitivity + overtone ghosts).
{
  const e = new PitchEngine(SR)
  e.setExpected([60])
  for (let i = 0; i < 20; i++) e.learnNoise(noise(frame(), 0.015))
  const r = detect(e, () => noise(brightTone([60]), 0.015))
  check('bright C4 under learned noise (mono, prior) -> exact', r.heldMidi.includes(60) && r.heldMidi.length === 1, `got [${r.heldMidi}]`)
}

// 11. "Any octave" mode expands one note name into every octave of the same
//     pitch class before calling setExpected. Whether that's monophonic can't
//     be inferred from the MIDI set (see test 12) — the caller must say so
//     explicitly via the `mono` option.
{
  const e = new PitchEngine(SR)
  const allOctavesOfC = []
  for (let m = 21; m <= 108; m++) if (m % 12 === 0) allOctavesOfC.push(m) // C1..C8, app convention
  e.setExpected(allOctavesOfC, { mono: true })
  check('any-octave expansion, mono:true -> monophonic', e.monoActive === true, `expected ${allOctavesOfC.length} midis`)
  const r = detect(e, () => brightTone([72])) // played in a different octave than any single listed hint would matter
  check('any-octave expansion -> exact, no overtone extras', JSON.stringify(r.heldMidi) === JSON.stringify([72]), `got [${r.heldMidi}]`)
}

// 12. A genuine two-note chord a compound octave apart (A2+A3) has the exact
//     same "every note is the same pitch class" shape as test 11's any-octave
//     expansion, but is NOT monophonic — both notes are required, not
//     alternatives. Without an explicit `mono` opt this must default to
//     polyphonic (unambiguous only when there's exactly one expected MIDI)
//     and report both notes, not collapse to whichever YIN finds first.
{
  const e = new PitchEngine(SR)
  e.setExpected([57, 69]) // A2, A3
  check('A2+A3 chord, no mono opt -> stays polyphonic', e.monoActive === false, `monoActive=${e.monoActive}`)
  const r = detect(e, () => tone(frame(), [57, 69]))
  check('A2+A3 chord -> both notes detected', JSON.stringify(r.heldMidi) === JSON.stringify([57, 69]), `got [${r.heldMidi}]`)
}

// 13. Far-below-expected ghost: a bass candidate's Nth harmonic (N=5..10) can
//     coincidentally land on an expected note's real fundamental — e.g. B3
//     (493.88 Hz) sits within one FFT bin of G1's (98.0 Hz) 5th harmonic
//     (490 Hz) — and score just from that one bin even though nothing is
//     actually sounding at G1 itself. Played tone here is pure B3 (only its
//     own harmonics, no G1 content at all); G1 must not appear.
{
  const e = new PitchEngine(SR)
  e.setExpected([71, 74]) // B3 + D4, forces the polyphonic comb-scan path
  const r = detect(e, () => tone(frame(), [71], { harmonics: 8 }))
  check('B3 harmonics -> no far-below-expected G1 ghost', !r.heldMidi.includes(43), `got [${r.heldMidi}]`)
}

// 14. Octave-above ghost with a dominant 2nd harmonic — the exact ratio found
//     analyzing a real recorded piano note (fund[C4] ≈ 3x fund[C3], not
//     weaker as the old check assumed). A2+C3 expected and played; C4 (an
//     octave above C3) must not appear as an extra note even though its
//     "own fundamental" bin (really C3's 2nd harmonic) is the strongest
//     single partial in the whole signal.
{
  const e = new PitchEngine(SR)
  e.setExpected([57, 60]) // A2, C3
  const r = detect(e, () => {
    const buf = frame()
    const add = (m, gains) => {
      const f0 = midiToFreq(m)
      gains.forEach((a, i) => {
        const k = i + 1
        for (let n = 0; n < buf.length; n++) buf[n] += a * Math.sin((2 * Math.PI * k * f0 * n) / SR)
      })
    }
    add(60, [1, 3, 0.5, 0.3, 0.2, 0.1]) // C3, dominant 2nd harmonic (real-recording ratio)
    add(57, [1, 0.7, 0.5, 0.3])         // A2, ordinary profile
    return buf
  })
  check('A2+C3, dominant C3 2nd harmonic -> no octave-above C4 ghost',
    !r.heldMidi.includes(72), `got [${r.heldMidi}]`)
}

// 15. A genuinely expected octave-doubled chord (C3+C4 both required, not
//     just one note with a strong 2nd harmonic) must still detect both —
//     the fix for test 14 only suppresses non-expected candidates, so a
//     deliberate doubling in the score is unaffected.
{
  const e = new PitchEngine(SR)
  e.setExpected([60, 72]) // C3 + C4
  const r = detect(e, () => tone(frame(), [60, 72]))
  check('C3+C4 both expected -> both detected', JSON.stringify(r.heldMidi) === JSON.stringify([60, 72]), `got [${r.heldMidi}]`)
}

// 16. Expected a single note (A2), but an extra unexpected note (C3) is also
//     genuinely played — must NOT default to the monophonic path, which
//     assumes the signal is monophonic and can lose lock on a real two-note
//     dyad entirely, silently dropping the correctly-played expected note
//     from the output for as long as the extra note is held (reproduced
//     against a real two-note piano recording: A2 vanished for several
//     seconds despite being continuously and correctly played). Pins
//     setExpected's default (mono: false unless explicitly requested).
{
  const e = new PitchEngine(SR)
  e.setExpected([57]) // A2 only
  check('single expected note defaults to polyphonic (mono: false)', e.monoActive === false, `monoActive=${e.monoActive}`)
  const r = detect(e, () => tone(frame(), [57, 60]), 30) // A2 (expected) + C3 (extra), held a while
  check('expected A2 + unexpected extra C3 -> A2 still held, not dropped', r.heldMidi.includes(57), `got [${r.heldMidi}]`)
}

// 17. Continuous background noise (never learned via a silent frame, and
//     above rmsGate the whole time) must not erode a long-held chord over
//     time. The noise floor's per-bin rise is gated on frame RMS
//     specifically to prevent this — verified directly: with that gate
//     removed, a sustained chord fully disappeared within ~5s of noisy
//     playback as the floor crept up into the notes' own harmonic bins.
{
  const e = new PitchEngine(SR)
  e.setExpected([57, 60]) // A2, C3
  let r
  for (let i = 0; i < 240; i++) { // 240 * 25ms hop-equivalent reps ~= 6s of sustained noisy playback
    r = e.process(noise(tone(frame(), [57, 60]), 0.012)) // noise amp well above default rmsGate
  }
  check('sustained chord under continuous unlearned noise -> not eroded away',
    JSON.stringify(r.heldMidi) === JSON.stringify([57, 60]), `got [${r.heldMidi}]`)
}

// ---- YIN-first single-note path (setExpected(..., { mono: true })) ----------
// Helper: sum of harmonics with explicit per-harmonic gains, fresh buffer.
function shaped(midis, gains) {
  const buf = new Float32Array(N)
  for (const m of midis) {
    const f0 = midiToFreq(m)
    gains.forEach((a, i) => {
      for (let n = 0; n < buf.length; n++) buf[n] += a * Math.sin((2 * Math.PI * (i + 1) * f0 * n) / SR)
    })
  }
  return buf
}

// 18. A wrong note held for a long time must stay wrong. The comb-scan's
//     expected-note prior is very lenient, so a low note's 5th harmonic
//     (G1 -> B3, ≈28 semitones up) eventually gets accepted as "the right
//     note" — reproduced on a real G1 recording (B3 reported held for the
//     full 7s). YIN never consults the prior: it reports what is sounding.
{
  const e = new PitchEngine(SR)
  e.setExpected([71], { mono: true }) // B3 expected...
  let r
  for (let i = 0; i < 80; i++) r = e.process(shaped([43], [1, 0.8, 0.6, 0.5, 0.4, 0.3])) // ...G1 actually played
  check('wrong low note held long -> still G1, never "accepted" as expected B3',
    JSON.stringify(r.heldMidi) === JSON.stringify([43]), `got [${r.heldMidi}]`)
}

// 19. Octave-up error: a struck string whose fundamental is weaker than its
//     2nd harmonic is nearly periodic at half the true period, so plain YIN
//     reads it an octave high (real C3 read correctly for 1.6s, then as C4).
//     The spectrum disambiguates: real C3 has energy at 3f/5f, a real C4 has
//     none.
{
  const e = new PitchEngine(SR)
  e.setExpected([60], { mono: true })
  let r
  for (let i = 0; i < 12; i++) r = e.process(shaped([60], [0.2, 1, 0.6, 0.5, 0.3, 0.2]))
  check('C3 with weak fundamental -> C3, not octave-up C4', JSON.stringify(r.heldMidi) === JSON.stringify([60]), `got [${r.heldMidi}]`)
}

// 20. ...and the correction must not over-fire: a genuine C4 played while C3
//     is expected is a wrong note and must be reported as C4, not "fixed"
//     down to the expected C3.
{
  const e = new PitchEngine(SR)
  e.setExpected([60], { mono: true })
  let r
  for (let i = 0; i < 12; i++) r = e.process(shaped([72], [1, 0.5, 0.3, 0.2]))
  check('real C4 while C3 expected -> C4 (no over-correction)', JSON.stringify(r.heldMidi) === JSON.stringify([72]), `got [${r.heldMidi}]`)
}

// 21. Weak-fundamental bass note (real F0 sits at CMNDF 0.20-0.25, just over
//     the strict 0.15 gate): the spectrally-verified weak tier must latch it.
{
  const e = new PitchEngine(SR)
  e.setExpected([29], { mono: true })
  let r
  for (let i = 0; i < 12; i++) r = e.process(shaped([29], [0.12, 1, 0.9, 0.3, 0.2]))
  check('weak-fundamental bass note latches', JSON.stringify(r.heldMidi) === JSON.stringify([29]), `got [${r.heldMidi}]`)
}

// 22. Dyad (accidental extra key): YIN can lose lock on the mix. It must not
//     drop the note — it coasts, then falls back to the comb-scan.
{
  const e = new PitchEngine(SR)
  e.setExpected([57], { mono: true })
  let r
  for (let i = 0; i < 40; i++) r = e.process(shaped([57, 60], [1, 0.7, 0.5, 0.3]))
  check('mono: expected A2 + extra C3 -> A2 still reported', r.heldMidi.includes(57), `got [${r.heldMidi}]`)
}

// 22b. A close dyad's "missing fundamental": C4 + D#4 are ~49.5 Hz apart, so
//      the mix repeats at that long period and unverified YIN confidently
//      reports a phantom pitch (G#1, seen live — reported for 46 of 48
//      readings while neither note was G#1). A pitch with no energy at any of
//      its own low harmonics must be rejected, and the two real notes shown.
{
  const e = new PitchEngine(SR)
  e.setExpected([75], { mono: true }) // D#4 expected
  let r
  for (let i = 0; i < 40; i++) r = e.process(shaped([75, 72], [1, 0.8, 0.5, 0.3, 0.15]))
  check('mono: close dyad -> no phantom missing-fundamental note',
    r.heldMidi.every((m) => m === 75 || m === 72) && r.heldMidi.includes(75), `got [${r.heldMidi}]`)
}

// 22c. "Any octave" mode marks every octave of the played pitch class as
//      expected, which exempts all of them from ghost suppression and gives
//      all of them the lenient expected-note threshold — so ONE played A
//      reported A-1, A0, A2, A3, A4 together (seen on a real A2 recording).
//      With `anyOctave: true` the octaves are alternatives: report one.
{
  const allA = []
  for (let m = 21; m <= 108; m++) if (m % 12 === 9) allA.push(m)
  const e = new PitchEngine(SR)
  e.setExpected(allA, { anyOctave: true })
  let r
  for (let i = 0; i < 30; i++) r = e.process(shaped([57], [0.5, 1, 0.6, 0.4, 0.3, 0.2]))
  check('any-octave: one played A -> exactly one A reported',
    r.heldMidi.length === 1 && r.heldMidi[0] % 12 === 9, `got [${r.heldMidi}]`)
  check('any-octave: correct octave (weak-fundamental A2 not read as A3)',
    r.heldMidi[0] === 57, `got [${r.heldMidi}]`)

  // Same expected set WITHOUT the flag is a genuine multi-octave chord and
  // must keep reporting every octave that's actually played.
  const e2 = new PitchEngine(SR)
  e2.setExpected([57, 69])
  let r2
  for (let i = 0; i < 30; i++) r2 = e2.process(tone(frame(), [57, 69]))
  check('without anyOctave, A2+A3 chord still reports both octaves',
    JSON.stringify(r2.heldMidi) === JSON.stringify([57, 69]), `got [${r2.heldMidi}]`)
}

// 23. Noise must never latch a pitch. (a) YIN itself is never confident on
//     broadband noise, weak tier included (400/400 frames in offline
//     measurement). (b) With a learned noise profile, the whole mono path
//     — fallback included — reports nothing. (Without any learned profile,
//     the comb-scan fallback's lenient expected-note prior accepts the
//     expected note on pure noise — identical to plain comb-scan behavior,
//     and only reachable when the room never goes quiet enough to learn one.)
{
  const e = new PitchEngine(SR)
  let confident = 0
  for (let i = 0; i < 100; i++) {
    e._spectrum(noise(frame(), 0.02))
    if (e._monoPitch(noise(frame(), 0.02)).confident) confident++
  }
  check('YIN never confident on broadband noise', confident === 0, `confident on ${confident}/100 frames`)

  const e2 = new PitchEngine(SR)
  e2.setExpected([60], { mono: true })
  for (let i = 0; i < 20; i++) e2.learnNoise(noise(frame(), 0.02))
  let latched = 0
  for (let i = 0; i < 100; i++) if (e2.process(noise(frame(), 0.02)).heldMidi.length) latched++
  check('mono + learned noise profile: noise never latches a pitch', latched === 0, `latched on ${latched}/100 frames`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
