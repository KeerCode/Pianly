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

## Single-note path (YIN-first — `setExpected(midis, { mono: true })`)

The app passes `mono: true` whenever the target is exactly one note (the
"any octave" expansion of a single note included). `process()` then runs
`_monoPitch()` — a YIN-style time-domain pitch estimate (cumulative mean
normalized difference function, derived from an FFT-based autocorrelation in
O(maxLag)) — instead of trusting the comb-scan's expected-note prior.

**Why YIN and not the comb-scan for one note:** YIN never consults the
expected note, so it reports what is actually sounding. The comb-scan's
expected-note threshold is deliberately lenient, and a wrong low note's own
harmonics satisfy it: playing G1 with B3 expected (B3 ≈ G1's 5th harmonic)
reported B3 as held for the full 7s of a real recording — "hold a wrong note
long enough and it becomes right". Likewise a note's octave-below ghost
(C3 read as C3+C2) can't appear, since YIN estimates one fundamental period
rather than a set of comb scores. Measured on real samples: a wrong `G1` /
`F1` / `F0` now stays reported as that note for its whole duration.

**Hybrid, not a replacement.** YIN assumes a monophonic signal; with an
accidental second key it can lose lock on the mix. So it is never allowed to
*drop* the note: on lost confidence it coasts on the last latched note for
`monoFallbackFrames`, then hands over to the comb-scan (which reports the dyad
properly). Known limitation: while YIN *is* confident on one note of a dyad
it reports only that note, and it can alternate between the two as their
relative levels drift — an extra key is flagged as a wrong note, but you don't
get the comb-scan's "expected + extra" pair.

Two corrections that make YIN usable on real piano:

- **Octave-up correction.** A struck string's 2nd harmonic is often louder than
  its fundamental (and it shifts during the decay), so the signal is nearly
  periodic at half the true period and YIN reads it an octave high — a real C3
  read correctly for 1.6s, then as C4 for 2.6s. CMNDF can't tell "C4" from
  "C3 with a weak fundamental", but the spectrum can: real C3 has energy at
  its odd harmonics (1.5x and 2.5x the estimate); a real C4 has none.
  Measured: true notes 0.1–2x the mean bin magnitude there, the mis-read C3
  60–110x. The odd harmonics *and* the lower note's own fundamental (f/2) must all exceed
  `monoOctaveOddMean` x mean, and the odd ones `monoOctaveOddRel` x the
  estimate's own strength — so one unrelated note (a fifth above), or a
  two-note mix with stray energy, can't trigger it, and a genuine C4 is
  reported as C4.
- **Spectral verification of every estimate.** >= 2 of the first 4 harmonics
  must exceed `monoHarmonicMean` x mean, *and* the fundamental or the 3rd must be
  one of them. Two failure modes this kills, both seen live/on real audio:
  a close dyad's phantom "missing fundamental" (C4 + D#4 beat at 49.5 Hz, so
  the mix repeats at that period and YIN confidently reported G#1 for 46 of 48
  readings), and an octave-*below* alias of a real note (A1 for a sounding
  A2, supported only by even harmonics that are really A2's own).
- **Weak tier.** Bass notes with a weak fundamental shallow the dip
  (a correct F0 sits at CMNDF 0.20–0.25 for its whole sustain, just over the
  strict 0.15 gate). The first local minimum under `monoCmndfWeak` is accepted
  only if >= 2 of the first 4 harmonics exceed `monoHarmonicMean` x the
  mean magnitude. Pure noise never got past 0.55 confidence in 400 trials.

Measured onset-to-detection latency (real samples, from the *end* of the
analysis window): 21–46ms for mid/high notes, 121ms F0, 171ms G1 (the lowest
notes need more periods inside the window) — all inside the 250ms budget.

| knob | default | move to | effect |
|------|---------|---------|--------|
| `monoCmndfThreshold` | 0.15 | 0.2–0.25 | more forgiving — if it feels deaf on a quiet/breathy attack |
| `monoCmndfThreshold` | 0.15 | 0.08–0.12 | stricter — if noise or inharmonicity triggers false pitches |
| `monoCmndfWeak` | 0.3 | 0.4 | looser weak-fundamental tier — 0.4 let a spurious D2 through for 0.57s mid-decay on a real F0 recording |
| `monoHarmonicMean` | 10 | 15–20 | stricter spectral verification of weak-tier notes |
| `monoOctaveOddMean` / `monoOctaveOddRel` | 12 / 0.02 | raise | less eager to correct an octave-up read down (if a real high note gets pulled down) |
| `monoSwitchFrames` | 2 | 3–5 | a different pitch must persist this many frames to replace the latched note (a fresh attack switches immediately) — raise if the output still bounces between octaves during decay |
| `monoFallbackFrames` | 3 | 2 | hand a lost-lock frame to the comb-scan sooner. 6 (150 ms) made overlapped legato notes take 275-430 ms to register; 3 is clean on every real sample, 2 starts producing blips on C3 |

`npm run analyze -- file.wav --expected "C3" --mono` drives this path.

The comb-scan fallback only runs if the frame contains tones (>= 3 spectral
peaks above `monoHarmonicMean` x the mean magnitude). Without that gate its
lenient expected-note prior latched the expected note out of pure noise on
4–41% of frames even with a learned profile, i.e. reported a "correct" note
with nothing being played. (Plain comb-scan mode — chords / no `mono` — still
has that leniency when no noise profile has ever been learned, e.g. a room that
never goes quiet enough to bootstrap one.)

---

## "Any octave" targets (`setExpected(midis, { anyOctave: true })`)

"Any octave" mode expands one target note into every octave of its pitch class.
Those octaves are alternatives (play *any one*), not a chord that needs them all
— but the engine can't tell that from the note set (a real A2+A3 chord has the
identical shape), so the caller says so. Without it, marking every A "expected"
exempts every octave from ghost suppression and gives all of them the lenient
expected-note threshold: one played A reported `A-1 + A0 + A2 + A3 + A4` at
once on a real A2 recording.

With the flag, the comb-scan keeps **one octave per pitch class**: the highest
comb salience among the spectrally-supported octaves (`_pitchSupported`), then
the odd-harmonic octave-down check in case salience landed an octave high on a
weak-fundamental note. The pick is sticky while it stays active and within half
the best salience, so a bass note whose fundamental has faded (F0) doesn't flap
between octaves. (A first version picked the *lowest* supported octave; that was
wrong — late in a decay the frame's mean magnitude is small and low-frequency
rumble makes 27.5/55 Hz "supported", so it flickered to the bottom of the
range.) The single-note case goes through YIN, which never had this problem.

Octave is irrelevant to matching in this mode, so an octave flip is cosmetic;
reporting two octaves at once was the actual bug.

**Known limitation — fifth-related chord targets.** If a target chord contains a
perfect fifth (E2 + B3), playing just the root also lights up the upper note:
B3 is exactly E2's 3rd harmonic (3 x 82.4 = 247 Hz, ~2 cents off, far under one
5.9 Hz bin). Nothing in the spectrum separates "E2 with a strong 3rd harmonic"
from "E2 + B3", so this can't be fixed by a threshold — confirmed live: single
E2 against an E2+B3 target reported both as held. Same family as the octave
ambiguity (`Octave errors` above), just at a 3:1 ratio.

---

## Advancing on detection (App.jsx, mic only)

MIDI advances on note-off. A mic can't see a key release — the note rings and
decays for seconds — and waiting for "nothing detected" made every advance
pause. So for mic input the app advances **the moment the target is matched**,
and treats whatever was sounding as the *old note* until it clears:

- the old note is tracked by **exact pitch** (pitch class only in "Any octave"
  mode) and ignored against the next target, together with its octave/harmonic
  *shadows* (12, 24 and 18-20 / 27-41 semitones away — the same offsets the
  detector's ghost rules use) unless the current target wants that pitch. A
  first version used pitch class and stalled on every octave-different repeat
  (C4 -> C3, E3 -> E4: the new note looked like "C4 still ringing"); tracking
  exact pitch alone let the previous chord's ghosts (E1/F1/A1 under a ringing
  E2/A3) be judged as wrong notes;
- a ringing note is only forgotten after it has been absent from the detector
  for `STALE_GRACE_MS` (600), not after one report without it — the detector
  often momentarily lists only the newest note, and forgetting it then made the
  old note look new (and wrong) when it flickered back;
- evaluation resumes when the old note stops, when a *new correct-looking note*
  appears, on a fresh attack of anything new, or when a wanted stale pitch is
  re-struck — where "re-struck" means *any attack since the old-sound snapshot*
  (`RESTRIKE_MARGIN_MS` skips the tail of the note just matched), not one that
  coincides with the note's first report, because a still-ringing newer note can
  keep the monophonic estimate busy until the attack is over. Capped at
  `MIC_RINGOVER_MS` (1500);
- the detector's `onset` to the app is `fluxOnset || attack`, where `attack` is
  a >1.25x frame-RMS rise within one 25 ms hop (and > 2x rmsGate). Measured on
  real recordings: 1.4x-3.4x after every re-strike (forte, soft, half-volume, a
  different note), never > 1.25x during a normal decay. Spectral flux was
  unreliable in dense playing (its baseline is high);
- the 150 ms advance cooldown is skipped for mic: the detector only notifies on
  *changes*, so a fast next note detected inside the window was dropped.

Measured (real piano recordings played into the real app through a fake mic; the whole
Fur Elise easy demo, 81 target steps, each note released 320 ms after it starts so
notes overlap like legato playing): completes with **0 stuck notes**, median 173 ms
from note start to cursor move, p90 273 ms, 79% of steps within 250 ms. Earlier
synthetic checks: correct note held -> cursor moves in
~90-100 ms with no wrong-note hint while it keeps ringing; wrong low note held
5 s -> never advances, hint shown; then the correct note -> advances in 47-90 ms.
Offline on **real recordings** with the previous note still ringing and released
150-300 ms after the new one starts: new note reported in <= 71 ms. Still slow:
a synthetic *pure-tone* adjacent-semitone legato run (E4 <-> Eb4) took up to
~350 ms — two exactly-periodic tones 16 Hz apart beat, which is the worst case
for YIN.

**Harness warning:** the mic path uses a `ScriptProcessorNode`, which runs on the
main thread. Polling the page heavily while it runs (e.g. reading `innerText`
every 8 ms) starves it and drops audio — that produced 'stuck' notes on
different steps every run that vanished completely when the harness read only
cheap state. The same applies to the real app: main-thread work (React
rerenders) can glitch the mic. Moving capture to an `AudioWorklet` would remove
the dependency.

Instant advance made one older bug urgent: an expected note that is a harmonic
of a real *unexpected* lower note (G1 against an Eb4 target — 6th harmonic)
latches in 1 frame while the real note needs `framesOnScan` frames, so the
target read as "played" for the first ~9 frames of every wrong attack. See
`_explainedByLower`: an expected note is dropped when a spectrally-supported,
non-expected pitch sits at a harmonic offset below it. A genuine chord has both
notes expected, so it never fires for one (which is also why a fifth-related
target like E2+B3 stays ambiguous).

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
