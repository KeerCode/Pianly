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

## Monophonic path (exactly one expected note)

When exactly one *musical note* is expected, `process()` skips the spectral
harmonic-comb scan entirely and uses `_monoPitch()` instead — a YIN-style
time-domain pitch estimate (cumulative mean normalized difference function,
derived from an FFT-based autocorrelation in O(maxLag) rather than YIN's
usual O(N·maxLag)). This is what actually fixes "single note → several notes
shown": a real note's own upper partials (octave, fifth) can independently
clear the comb-scan's non-expected threshold and get reported as separate
phantom notes, since the comb scan scores every candidate pitch's harmonic
series independently. Time-domain periodicity instead estimates the *one*
true fundamental period directly — a harmonic's own (shorter) period isn't
implied by periodicity at the true period, so it doesn't fool this method the
same way. Chords (2+ notes) still use the comb scan (YIN has no polyphony
story).

**"One note" is not the same as "one MIDI number in `expected`"** — whether to
take this path is a `setExpected(midis, { mono })` option, not something
inferred from `midis` itself, because it's genuinely ambiguous from the set
alone: "any octave" mode expands a single target note into every octave of
its pitch class (still one note — `mono: true`), but a real two-note chord a
compound octave apart, e.g. A2+A3, has the *exact same* all-one-pitch-class
shape and needs both notes detected (`mono: false`). Get this wrong in either
direction and you get this section's failure mode back, or "two notes
expected, only one ever shown" (the chord collapsing onto whichever one YIN's
single-pitch estimate finds). Omitting `opts.mono` defaults to
`expected.size === 1`, which is only safe when the caller isn't doing any
octave-expansion of a single note — pass it explicitly whenever you do.

| knob | default | move to | effect |
|------|---------|---------|--------|
| `monoCmndfThreshold` | 0.15 | 0.2–0.25 | more forgiving — if it feels deaf on a quiet/breathy attack |
| `monoCmndfThreshold` | 0.15 | 0.08–0.12 | stricter — if noise or inharmonicity (very low/high notes, unpitched percussion in the mic) triggers false pitches |
| `monoFramesOff` | 3 | 5–6 | held note stops dropping out mid-sustain |

`npm run analyze` doesn't currently drive this path (it always calls the
comb-scan tunables) — to test it, call `engine.setExpected([midi])` before
`engine.process(frame)` in a small script, or exercise it in-app with a single
target note.

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
| `framesOff` | 3 | 5–6 | held notes stop dropping out mid-sustain |
| `tOffRatio` | 0.5 | 0.3–0.4 | notes "stick" through dips (legato, pedal) |

## False notes / phantom extras

| knob | default | move to | effect |
|------|---------|---------|--------|
| `tOnScan` | 0.30 | 0.35–0.45 | non-expected pitch needs much more energy — kills harmonic/phantom extras that block chord advance |
| `snrOnScan` | 4.0 | 5–8 | reject notes that are barely above the frame floor |
| `framesOnScan` | 2 | 3 | ignore single-frame transients |
| `minLowHarmonics` | 2 | 3 | stricter "is this a real tone" test (needs a fuller harmonic series) |
| `noiseGateRatio` | 3.0 | 4–6 | (only with a learned noise profile) a note must beat the noise's own comb energy by this factor |
| `maxPolyphony` | 8 | 5 | hard cap when you know the material is ≤5 voices |

## Octave errors (detects the note an octave off)

| knob | default | move to | effect |
|------|---------|---------|--------|
| `harmonicRolloff` | 0.7 | 1.0–1.3 | trust the fundamental far more than upper harmonics (where octave ghosts live) |
| `tOnScan` | 0.30 | 0.40 | ghost has to be really strong to register |

The engine already suppresses octave / twelfth / two-octave ghosts, but only
when the *other* pitch has a real fundamental. If octaves are still leaking,
raising `harmonicRolloff` is the biggest lever.

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
- **Adaptive spectral subtraction** — every frame classified as silence
  (`rms < rmsGate`) is averaged into a per-bin noise profile
  (`noiseAdaptRate`, EMA). Live frames get `mag -= noiseOversub * noise`, floored
  at `noiseFloorFrac * mag`.

| knob | default | move to | effect |
|------|---------|---------|--------|
| `noiseOversub` | 1.5 | 2.0–2.5 | subtract more aggressively (steady hum, fan) — too high thins real notes |
| `noiseFloorFrac` | 0.02 | 0.05 | leave more residual — fewer "musical noise" artifacts, less clean |
| `noiseAdaptRate` | 0.1 | 0.03 | noise profile changes more slowly (stable room) |
| `noiseGateRatio` | 3.0 | 4–6 | stricter reject of notes that are just structured noise |

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
