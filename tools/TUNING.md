# Tuning the predictive detector

All knobs live in `DEFAULT_CONFIG` in `src/input/predictiveDetector.js`. Override
any subset at runtime:

```js
startPredictiveDetection({ onNotes, expected, config: { tOnScan: 0.38 } })
```

or from the offline harness, without touching source:

```bash
npm run analyze -- recording.wav --expected "C4,E4,G4" --set tOnScan=0.38 --set frameSize=16384
```

Change **one knob at a time**, re-run `npm run analyze` on the same clip, compare
`precision` / `recall`. `npm run test:detector` must still pass afterwards.

---

## The one you must calibrate: `rmsGate`

Silence threshold on time-domain RMS. Everything below it is treated as room
tone (and folded into the noise profile).

1. Record ~3 s of your room with nobody playing.
2. `npm run analyze -- room.wav --csv` — the header prints the file RMS, or add a
   `console.error(rms)` in the loop.
3. Set `rmsGate` to **3–4×** that number.

- Too low → hiss/hum is "sound", detector chases notes in noise.
- Too high → soft notes and sustain tails get cut.
- Range **0.002** (quiet room, condenser mic) … **0.02** (laptop mic, noisy room).

---

## Resolution vs latency: `frameSize` / `fftSize`

| frameSize | window @48k | bin width | resolves down to | use when |
|-----------|-------------|-----------|------------------|----------|
| 4096  | 85 ms  | 11.7 Hz | ~C4 | fast passages, RH-only, latency-critical |
| **8192** | **171 ms** | **5.9 Hz** | **~C3** | default |
| 16384 | 341 ms | 2.9 Hz | ~E2 | bass-heavy material, hold-to-advance practice |

- Below the "resolves down to" note, adjacent semitones share FFT bins; the
  detector collapses the cluster to one pitch (may be ±1–3 semitones off) unless
  that note is in the **expected** set, which pins it exactly.
- `fftSize` larger than `frameSize` zero-pads: finer bin *spacing* (better peak
  location) at the **same latency**, but does **not** improve the ability to
  separate two close pitches. Try `fftSize: 16384` with `frameSize: 8192` for a
  cheap accuracy bump.
- `analysisIntervalMs` (default 25) is how often the live loop runs. 15–40 is
  sane; the window is 170 ms so going lower re-analyses mostly the same samples.
  Raise it if CPU-bound.

App.jsx (sheet practice, advances on hold) tolerates 16384. ReadPractice scores
reaction time in milliseconds — keep it at 8192 or 4096 there.

---

## Monophonic path (opt-in only — `setExpected(midis, { mono: true })`)

When explicitly requested, `process()` skips the spectral harmonic-comb scan
entirely and uses `_monoPitch()` instead — a YIN-style time-domain pitch
estimate (cumulative mean normalized difference function, derived from an
FFT-based autocorrelation in O(maxLag) rather than YIN's usual O(N·maxLag)).
It estimates the *one* true fundamental period directly, so a note's own
upper partials can't get mistaken for a second note the spectral comb-scan
way (a harmonic's own shorter period isn't implied by periodicity at the true
period).

**Not used by default, and not wired into the app.** It assumes the real
signal actually is monophonic — if the player also hits an unexpected extra
note (easy to do by accident when only one note is expected), YIN's
single-pitch estimate can lose lock on the resulting two-note dyad entirely,
and the correctly-played expected note disappears from the output for as
long as the extra note is held. Verified against a real two-note piano
recording: expected `[A2]`, actually played A2+C3 — in mono mode A2 vanished
completely for several seconds despite being continuously played correctly.
The comb-scan's ghost-suppression fixes (far-below-expected-note harmonics,
octave-above ghosts — see below) now handle the single-note harmonic-ghost
case about as well as mono mode did, without that failure mode, so `mono` now
defaults to `false` unconditionally — pass `{ mono: true }` explicitly only
if you have a use case where the signal is *guaranteed* monophonic (no
possibility of an extra note) and want YIN's slightly better bass-note
precision.

| knob | default | move to | effect |
|------|---------|---------|--------|
| `monoCmndfThreshold` | 0.15 | 0.2–0.25 | more forgiving — if it feels deaf on a quiet/breathy attack |
| `monoCmndfThreshold` | 0.15 | 0.08–0.12 | stricter — if noise or inharmonicity (very low/high notes, unpitched percussion in the mic) triggers false pitches |
| `monoFramesOff` | 3 | 5–6 | held note stops dropping out mid-sustain |

`npm run analyze` doesn't currently drive this path (it always calls the
comb-scan tunables) — to test it, call `engine.setExpected([midi], { mono:
true })` before `engine.process(frame)` in a small script.

---

## Missed notes / detector feels deaf

| knob | default | move to | effect |
|------|---------|---------|--------|
| `tOnExpected` | 0.10 | 0.06–0.08 | expected note registers on less evidence |
| `snrOnExpected` | 2.2 | 1.8–2.0 | tolerate a noisier room |
| `framesOnExpected` | 1 | keep at 1 | already instant |
| `minLowHarmonics` | 2 | 1 | accept notes with a weak/absent fundamental (helps A0–C2, and near-pure tones); costs some spurious-bass rejection |
| `harmonicRolloff` | 0.7 | 0.5 | weight upper harmonics more → better weak-fundamental bass |
| `maxHarmonics` | 10 | 12–16 | more evidence per note (mainly low/mid) |
| `framesOff` | 5 | 6–8 | held notes stop dropping out mid-sustain |
| `tOffRatio` | 0.5 | 0.3–0.4 | notes "stick" through dips (legato, pedal) |

## False notes / phantom extras

| knob | default | move to | effect |
|------|---------|---------|--------|
| `tOnScan` | 0.30 | 0.35–0.45 | non-expected pitch needs much more energy — kills harmonic/phantom extras that block chord advance |
| `snrOnScan` | 4.0 | 5–8 | reject notes that are barely above the frame floor |
| `framesOnScan` | 5 | 6–8 | ignore single-frame transients. A *real* new wrong note still latches ~instantly regardless — a fresh attack triggers onset detection, which overrides this to 1 frame. This only debounces a candidate with no fresh attack slowly drifting over threshold mid-sustain (e.g. noise wandering with the room's ambient level) — raising it from the old default of 2 eliminated persistent flicker on a noisy real-recording stress test entirely (verified via `analyzeAudio.mjs --csv`) |
| `minLowHarmonics` | 2 | 3 | stricter "is this a real tone" test (needs a fuller harmonic series) |
| `noiseGateRatio` | 3.0 | 4–6 | (only with a learned noise profile) a note must beat the noise's own comb energy by this factor |
| `maxPolyphony` | 8 | 5 | hard cap when you know the material is ≤5 voices |

## Octave errors (detects the note an octave off)

The engine suppresses octave / twelfth / two-octave ghosts whenever the
*other*, real pitch is confirmed. For a note *above* a real note specifically
(m-12/-19/-24), this suppression does **not** additionally require the
ghost's own fundamental to look weak — verified on a real recorded C3: its
2nd harmonic (exactly C4's fundamental frequency) measured 2.9-3.6x
*stronger* than its own true fundamental, so "own fundamental is weak" is not
a valid discriminator here. Every harmonic of the note an octave above is
also an exact harmonic of the note below, so no amplitude pattern can tell
"one note with a loud 2nd harmonic" from "two notes an octave apart" — this
is a permanent ambiguity, not something `harmonicRolloff` fixes (tested
directly against real audio: raising it 0.7 → 1.3 made no difference to this
failure mode). A deliberately octave-doubled target still detects fine, since
it's then in `expected` and this suppression only touches non-expected
candidates.

`harmonicRolloff` (0.7, try 1.0–1.3) still helps the *original* octave-ghost
shape this section used to describe — a low candidate's own comb trusting
upper harmonics too much — just not the above-a-real-note case.

## Onset / timing feels laggy or jittery

| knob | default | move to | effect |
|------|---------|---------|--------|
| `onsetSensitivity` | 2.5 | 2.0 | flag attacks on smaller spectral-flux spikes (snappier, more false onsets) |
| `onsetSensitivity` | 2.5 | 3.0–3.5 | only strong attacks count (steadier, slower) |
| `analysisIntervalMs` | 25 | 15 | more frequent updates |
| `frameSize` | 8192 | 4096 | halves the integration window → lower latency, worse bass |

---

## Background-noise removal

Always on:

- **High-pass at `highpassHz` (30 Hz)** — kills rumble, HVAC, mic handling
  thumps. Below A0 (27.5 Hz), so it never touches a real note. Raise to 40–50 if
  you have strong low-frequency hum; lower toward 25 only if you actually play
  the bottom octave.
- **Continuous adaptive spectral subtraction** — the noise floor is tracked
  every frame, not just ones classified as silence, via an asymmetric
  per-bin minimum-follower (`_updateNoiseFloor`): falls fast toward a newly
  observed *lower* magnitude (`noiseFloorFallRate`), rises only very slowly
  toward a higher one (`noiseFloorRiseRate`), and that rise is further gated
  off entirely whenever the frame itself isn't quiet
  (`noiseFloorRiseRmsMax`). This replaced a silence-gated learner (only ever
  updated when `rms < rmsGate`) that silently did nothing at all whenever the
  room's ambient level sat above `rmsGate` — a real, easy-to-hit
  miscalibration, not an edge case; `rmsGate` still needs the same per-room
  calibration below, but the profile no longer depends on true silence ever
  occurring to start working.

  The rise side is deliberately cautious: verified that *any* nonzero rise
  rate, given long enough, drags the floor up into a sustained note's own
  harmonic bins and the note gets subtracted away entirely (a held chord
  fully disappeared within ~5s at `noiseFloorRiseRate: 0.01` with rise
  ungated). Gating rise on frame RMS fixes this — a loud sustained note can
  never itself look like "the noise floor rising", only an actually-quiet
  passage lets the estimate climb to catch up with a louder room. Live
  frames get `mag -= noiseOversub * noise`, floored at `noiseFloorFrac * mag`,
  same as before.

| knob | default | move to | effect |
|------|---------|---------|--------|
| `noiseOversub` | 1.5 | 2.0–2.5 | subtract more aggressively (steady hum, fan) — too high thins real notes |
| `noiseFloorFrac` | 0.02 | 0.05 | leave more residual — fewer "musical noise" artifacts, less clean |
| `noiseFloorFallRate` | 0.15 | 0.05–0.1 | floor settles onto a new lower level more slowly (fewer false "quiet" moments mistaken for the true floor) |
| `noiseFloorRiseRate` | 0.01 | lower, not higher | if you suspect floor creep — see the sustained-note-erosion note above before raising this |
| `noiseFloorRiseRmsMax` | 0.01 | raise a little | if the floor won't catch up fast enough after real ambient noise increases (rare) |
| `noiseGateRatio` | 3.0 | 4–6 | stricter reject of notes that are just structured noise |
| `noiseAdaptRate` | 0.1 | 0.03 | only affects explicit priming via `learnNoise()` / `--noise room.wav` — symmetric EMA, unrelated to the continuous tracker above |

Prime the profile from a dedicated recording instead of waiting for silent
frames:

```bash
npm run analyze -- play.wav --noise room.wav --expected "C4,E4,G4"
```

The browser's own `noiseSuppression` stays **off** on purpose — it's tuned for
speech and mangles musical pitch. This pipeline replaces it.

---

## Workflow

```bash
# baseline
npm run analyze -- take1.wav --truth take1.json

# try a change
npm run analyze -- take1.wav --truth take1.json --set tOnScan=0.4

# per-frame trace for a tricky spot
npm run analyze -- take1.wav --csv > frames.csv

# regression gate — must stay green
npm run test:detector
```

`--truth` accepts `[60,64,67]` (these pitches should appear) or
`[{ "midi": 60, "onset": 1.5 }, ...]` (with timing, ±0.3 s tolerance). Pitch
numbers are the app convention: middle C = C3 = MIDI 60.
