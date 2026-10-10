/**
 * Predictive, score-informed note detector.
 *
 * Replaces the Basic Pitch ML model for *live* practice input. The idea is the
 * one Simply Piano uses: we already know which notes the score expects next, so
 * instead of blindly transcribing arbitrary polyphony we run a cheap FFT and ask
 * a much easier question — "is expected note X sounding right now?" — with the
 * expected notes given a strong prior.
 *
 * Pipeline per frame:
 *   1. FFT of a Hann-windowed slice of mic audio (own radix-2 FFT).
 *   2. Adaptive spectral subtraction against a learned background-noise profile.
 *   3. For every candidate MIDI pitch, score a harmonic comb template
 *      (energy at f0, 2f0, 3f0 … ) against the magnitude spectrum.
 *   4. Apply the score prior: expected pitches clear a low threshold, every
 *      other pitch must clear a much higher one (keeps wrong-note detection but
 *      kills false positives).
 *   5. Suppress octave / fifth harmonic + sub-harmonic ghosts on non-expected
 *      pitches.
 *   6. Hysteresis + onset (spectral flux) gate -> a stable "held notes" set.
 *
 * The DSP core lives in `PitchEngine`, which is pure (feed it frames, it returns
 * held notes) so it can be driven offline from recorded audio in tests.
 * `startPredictiveDetection` is just the live mic plumbing around it.
 *
 * Basic Pitch stays installed (src/input/pitchDetector.js) but is no longer used
 * for live input.
 */

import { curveAt, loadActiveCalibration, gateFromRoomRms, midiToHz } from './micCalibration.js'

const DEBUG = import.meta.env?.DEV ?? false

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** MIDI note number -> note name, using the app convention (middle C = C3). */
export function midiToNoteNamePitch(midi) {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 2
  return `${name}${octave}`
}

// ---------------------------------------------------------------------------
// Tunables. Every value here is safe to change at runtime by passing a partial
// `config` to `startPredictiveDetection` / `new PitchEngine`. See TUNING.md for
// what each one does and which direction to move it.
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  // --- analysis window ---
  frameSize: 8192,        // samples per FFT window. Bigger = finer pitch
                          // resolution (needed for the bass) but more latency.
  fftSize: 8192,          // >= frameSize. Set larger than frameSize to zero-pad
                          // (finer bin spacing, same latency).
  analysisIntervalMs: 25, // how often the live loop runs process().

  // --- pitch range ---
  minMidi: 21,            // A0
  maxMidi: 108,           // C8

  // --- harmonic comb template ---
  maxHarmonics: 10,       // harmonics summed per candidate pitch.
  harmonicRolloff: 0.7,   // harmonic k weighted by 1 / k^rolloff. Higher =>
                          // trust the fundamental more, fewer octave ghosts,
                          // weaker bass.
  minLowHarmonics: 2,     // require this many of the first 3 harmonics to carry
                          // real energy. Rejects a low note "detected" only
                          // because one high harmonic lines up with a lone
                          // partial. Lower to 1 to loosen (helps very weak bass).
  lowHarmonicFrac: 0.12,  // a harmonic counts as present if it exceeds this
                          // fraction of the comb's strongest harmonic.
  minScanMidi: 33,        // NON-expected candidates below this can't latch (55 Hz,
                          // the piano's bottom ~1.5 octaves). At this frame size a
                          // semitone down there is <2 bins wide and real recordings
                          // carry rumble, so the comb-scan reported phantom D0/F#0/
                          // C0/A-1 on quiet real notes (20-88% of frames on PP/Mp
                          // samples). Expected notes are exempt, so a target in the
                          // bottom octaves still detects; lower it to 21 to also
                          // flag WRONG notes down there.
  expectedGhostSpanSemitones: 22, // a non-expected candidate this many
                          // semitones (or more) below an EXPECTED note, with
                          // a weak own fundamental, is suppressed outright —
                          // almost certainly that note's own 5th+ harmonic
                          // coincidentally lining up with a bass candidate's
                          // comb, not a real second note. ~22 gives margin
                          // below the true 5th-harmonic offset (~28 semitones)
                          // for low-frequency bin smearing.

  // --- gating ---
  rmsGate: 0.005,         // time-domain RMS below this = silence. CALIBRATE to
                          // the mic/room (≈ 3–4x measured room-tone RMS).
  tOnExpected: 0.10,      // expected note fires at this fraction of the frame's
                          // strongest salience.
  tOnScan: 0.30,          // non-expected (wrong) note must clear this fraction.
  snrOnExpected: 2.2,     // absolute salience / noise-floor gate for expected.
  snrOnScan: 4.0,         // ... and for non-expected.
  tOffRatio: 0.5,         // release threshold = tOffRatio * on-threshold.
  framesOnExpected: 1,    // consecutive frames above threshold before latching.
  framesOnScan: 5,        // a real new wrong note still latches ~instantly —
                          // onset detection overrides this to 1 regardless.
                          // This only debounces a *non-onset* (no fresh
                          // attack) candidate slowly drifting over threshold
                          // mid-sustain, e.g. noise wandering with the room's
                          // ambient level — verified eliminating spurious
                          // transitions entirely on a noisy real-recording
                          // stress test (18 -> 0).
  framesOff: 5,           // consecutive frames below threshold before release.
  maxPolyphony: 8,        // cap on simultaneously reported notes.
  onsetSensitivity: 2.5,  // spectral-flux std multiplier for onset detection.

  // --- monophonic path (exactly one expected note) ---
  // Replaces the spectral harmonic-comb scan with a time-domain YIN pitch
  // estimate (see _monoPitch). A real note's own upper partials (octave,
  // fifth) can independently clear the comb-scan's non-expected threshold and
  // get reported as separate phantom notes; YIN instead estimates the one
  // true fundamental period directly, so a harmonic can't masquerade as a
  // second note the same way.
  monoCmndfThreshold: 0.15, // YIN's cumulative-mean-normalized-difference
                             // threshold — LOWER means stricter (0 = perfectly
                             // periodic). Standard YIN range is 0.1-0.2.
                             // Raise toward 0.2 if it feels deaf; lower toward
                             // 0.1 if it's fooled by noise/inharmonicity.
  monoCmndfWeak: 0.3,     // looser CMNDF gate for a spectrally-verified weak dip
                          // (weak-fundamental bass); see _monoPitch.
  monoHarmonicMean: 10,   // every YIN estimate is spectrally verified: >=2 of its
                          // first 4 harmonics must exceed this multiple of the
                          // frame's mean magnitude (rejects a dyad's phantom
                          // "missing fundamental").
  monoOctaveOddMean: 12,  // octave-up correction: the octave-below's odd
  monoOctaveOddRel: 0.02, // harmonics must both exceed this multiple of the
                          // mean magnitude AND this fraction of the estimate's
                          // own strength before the estimate is dropped 12.
  monoFramesOn: 1,        // consecutive confident frames before latching.
  monoSwitchFrames: 2,    // frames a *different* pitch must persist before it
                          // replaces the latched note (a fresh attack switches
                          // immediately) — stops decay-time octave flicker.
  monoFallbackFrames: 3,  // consecutive frames of YIN having no confident pitch
                          // before handing over to the comb-scan (dyads, chords,
                          // noise). Until then the last note is held (coasts).

  // --- background-noise removal (adaptive spectral subtraction) ---
  // The floor is tracked continuously, every frame — not just during detected
  // silence. A room whose ambient level sits above `rmsGate` never registers
  // as silent, so a silence-gated learner never engages there at all (zero
  // noise suppression, indefinitely). Asymmetric rates make this safe to run
  // constantly: falling fast toward a newly-observed *lower* magnitude finds
  // the true floor quickly (gaps between harmonics, quiet passages, a note's
  // own decay); rising only very slowly toward a *higher* one means a
  // sustained note's own energy can't get mistaken for "noise" and start
  // eating itself, the way a fast-adapting floor would.
  noiseFloorFallRate: 0.15,
  noiseFloorRiseRate: 0.01,
  noiseFloorRiseRmsMax: 0.01, // rise only applies to frames this quiet or
                              // quieter (a bit above rmsGate) — a loud
                              // sustained note must never itself look like a
                              // rising noise floor, only an actually-quiet
                              // passage should let the estimate climb.
  noiseAdaptRate: 0.1,    // EMA rate for explicit priming via learnNoise() —
                          // symmetric, since a dedicated noise-only recording
                          // has no "don't eat the signal" risk to guard against.
  noiseOversub: 1.5,      // subtract this multiple of the noise profile.
  noiseFloorFrac: 0.02,   // never push a bin below this fraction of its raw
                          // magnitude (prevents "musical noise").
  noiseGateRatio: 3.0,    // a note's comb energy must beat the noise profile's
                          // energy on that same comb by this factor.
  highpassHz: 30,         // rumble/HVAC/handling-noise high-pass (below A0).

  // --- calibrated octave-pair resolution (needs a mic calibration profile) ---
  // Only active for targets holding a note X and X+12 (or X+24) when X was
  // calibrated: U = X+12k is judged present iff its energy exceeds what X's
  // own partial n=2^k would give ALONE, per the user's recorded decay curve.
  // See PitchEngine._applyCalibration and tools/TUNING.md.
  calibK: 1.6,            // early window: present iff observed partial ratio
                          // > calibK * the calibrated alone-ratio at the
                          // note's age. Absorbs the ~2x loud-vs-soft swing a
                          // single strike can't capture. Raise if a lone lower
                          // note still lights the upper one; lower if real
                          // octaves are missed.
  calibEarlySec: 0.3,     // the curve is only decisive this early in the note;
                          // later, alone and pair ratios converge (measured,
                          // across dynamics: a softer note's alone-ratio sits
                          // 4x above a loud calibration's curve by ~1 s) so
                          // the verdict is HELD instead of re-judged, and only
                          // a decisive new strike (below) changes it. This is
                          // what stops "hold a lone note long enough and the
                          // pair appears".
  calibJumpRatio: 1.6,    // ...and a fresh strike of the upper note onto an
                          // already-ringing lower one is recognised by the
                          // ratio jumping by this factor above the lowest of
                          // the last few frames.
  calibStrikeWindowSec: 0.25, // a late ratio jump only counts within this long
                          // of a detected attack (beat modulation of a ringing
                          // note can fake a jump but never an onset).
  calibOffK: 1.25,        // early window only: once latched, release when the
                          // ratio falls under calibOffK * the alone-ratio.
  calibMinRatio: 0.12,    // never accept below this ratio at any age: the
                          // calibrated curve gets tiny late in a decay and
                          // would otherwise let measurement noise through.
  calibFramesOn: 2,       // consecutive frames of "present" before latching
  calibFramesOff: 2,      // ... and of "absent" before releasing.
  calibFundMean: 4,       // the lower note's own fundamental must exceed this
                          // multiple of the frame mean magnitude to be judged.
  calibPartialMean: 3,    // the upper note's partial must exceed this multiple.
  calibRestrikeRatio: 1.35, // a calibrated note's fundamental amplitude jumping
                          // by this factor frame-to-frame marks a (re)strike...
  calibRestrikeOnsetSec: 0.075, // ...and only if a flux/energy onset fired this
                          // close to it (beats alone never fire one).
  calibRestrikeGapSec: 0.25, // ...at most once per this long (the window fill
                          // ramps over several frames; not several strikes).
}

// ---------------------------------------------------------------------------
// Minimal iterative radix-2 FFT (in-place, complex).
// ---------------------------------------------------------------------------

export function makeBitReversal(n) {
  const rev = new Uint32Array(n)
  let bits = 0
  while (1 << bits < n) bits++
  for (let i = 0; i < n; i++) {
    let x = i
    let r = 0
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1)
      x >>= 1
    }
    rev[i] = r
  }
  return rev
}

export function makeTwiddles(n) {
  const cos = new Float32Array(n / 2)
  const sin = new Float32Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    const a = (-2 * Math.PI * i) / n
    cos[i] = Math.cos(a)
    sin[i] = Math.sin(a)
  }
  return { cos, sin }
}

export function fftInPlace(re, im, rev, tw) {
  const n = re.length
  for (let i = 0; i < n; i++) {
    const j = rev[i]
    if (j > i) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const step = n / size
    for (let i = 0; i < n; i += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const cos = tw.cos[t]
        const sin = tw.sin[t]
        const a = i + k
        const b = a + half
        const xr = re[b] * cos - im[b] * sin
        const xi = re[b] * sin + im[b] * cos
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
      }
    }
  }
}

/**
 * RBJ biquad high-pass, applied in place to a whole signal. Used offline; the
 * live path uses a BiquadFilterNode with the same cutoff.
 */
export function highpassInPlace(signal, sampleRate, cutoffHz) {
  if (!cutoffHz || cutoffHz <= 0) return signal
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate
  const cosw0 = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2) // Q = 1/sqrt(2)
  const b0 = (1 + cosw0) / 2
  const b1 = -(1 + cosw0)
  const b2 = (1 + cosw0) / 2
  const a0 = 1 + alpha
  const a1 = -2 * cosw0
  const a2 = 1 - alpha
  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0, na1 = a1 / a0, na2 = a2 / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < signal.length; i++) {
    const x0 = signal[i]
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2
    x2 = x1; x1 = x0
    y2 = y1; y1 = y0
    signal[i] = y0
  }
  return signal
}

// ---------------------------------------------------------------------------
// PitchEngine — the pure DSP core.
// ---------------------------------------------------------------------------

export class PitchEngine {
  constructor(sampleRate, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config }
    if (cfg.fftSize < cfg.frameSize) cfg.fftSize = cfg.frameSize
    this.cfg = cfg
    this.sr = sampleRate
    this.frame = cfg.frameSize
    this.fftN = cfg.fftSize
    this.bins = this.fftN / 2
    this.binHz = sampleRate / this.fftN

    this.rev = makeBitReversal(this.fftN)
    this.tw = makeTwiddles(this.fftN)
    this.hann = new Float32Array(this.frame)
    for (let i = 0; i < this.frame; i++) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.frame - 1))
    }

    this.re = new Float32Array(this.fftN)
    this.im = new Float32Array(this.fftN)
    this.mag = new Float32Array(this.bins)
    this.prevMag = new Float32Array(this.bins)
    this.noiseMag = new Float32Array(this.bins)
    this.hasNoise = false

    this.raw = new Float64Array(cfg.maxMidi + 1)
    this.sal = new Float64Array(cfg.maxMidi + 1)
    this.fund = new Float64Array(cfg.maxMidi + 1)
    this.noiseComb = new Float64Array(cfg.maxMidi + 1)
    this.lowSup = new Uint8Array(cfg.maxMidi + 1)

    // Candidate pitch tables (fundamental + harmonic bin indices), built once.
    // `nmsR` is the non-maximum-suppression radius in semitones: below ~C3 the
    // FFT bin spacing can't resolve adjacent semitones, so a low note lights up
    // a cluster of neighbours — collapse each cluster to its peak.
    this.cand = []
    for (let midi = cfg.minMidi; midi <= cfg.maxMidi; midi++) {
      const f0 = 440 * Math.pow(2, (midi - 69) / 12)
      const hmax = Math.min(cfg.maxHarmonics, Math.floor((sampleRate / 2 - 50) / f0))
      const hb = []
      const hw = []
      let wsum = 0
      for (let k = 1; k <= hmax; k++) {
        const b = Math.round((k * f0) / this.binHz)
        if (b < 2 || b >= this.bins - 1) break
        const w = 1 / Math.pow(k, cfg.harmonicRolloff)
        hb.push(b)
        hw.push(w)
        wsum += w
      }
      const semitoneHz = f0 * (Math.pow(2, 1 / 12) - 1)
      const nmsR = semitoneHz >= 2 * this.binHz ? 1 : semitoneHz >= this.binHz ? 2 : 3
      const tauSamples = Math.round(sampleRate / f0)
      this.cand.push({ midi, f0, fundBin: Math.round(f0 / this.binHz), hb, hw, wsum, nmsR, tauSamples })
    }

    this.expected = new Set()
    this.monoActive = false  // single-note target -> YIN-first path
    this.anyOctave = false   // `expected` is pitch-class alternatives, not a chord
    this.expectedPcs = new Set()
    this.groupPick = new Map() // any-octave: pitch class -> last reported octave
    this.state = new Map()   // midi -> { on, onCount, offCount }
    this.monoState = { midi: null, onCount: 0, unconfident: 0, candMidi: null, candCount: 0, combLive: false } // single-note YIN path
    this.fluxMean = 0
    this.fluxVar = 1
    this.prevFluxNorm = 0

    // Mic calibration (see setCalibration / _applyCalibration).
    this.calib = null            // { notes: { [midi]: entry } } | null
    this.clock = 0               // seconds; process()'s tSec, or a frame counter
    this.autoClock = 0
    this.lastRawMagMean = 0
    this.lastOnsetAt = -Infinity // clock of the last spectral-flux / energy attack
    this.prevRms = 0
    this.watch = new Set()       // midis whose attack age is tracked
    this.attackState = new Map() // midi -> { last, at }
    this.calibState = new Map()  // upper midi -> { on, count }
  }

  /**
   * Install (or clear, with null) a mic calibration — see micCalibration.js.
   * Without one the engine behaves exactly as before.
   */
  setCalibration(cal) {
    this.calib = cal && cal.notes && Object.keys(cal.notes).length ? cal : null
    this.calibState.clear()
    this.attackState.clear()
  }

  /** Track attack age for `midi` even without a calibration entry (setup wizard). */
  watchAttack(midi) { this.watch.add(midi) }
  unwatchAttack(midi) { this.watch.delete(midi); this.attackState.delete(midi) }

  /** Seconds since `midi`'s last detected strike, or null if none seen. */
  attackAge(midi) {
    const a = this.attackState.get(midi)
    return a && a.at != null ? this.clock - a.at : null
  }

  /**
   * @param {number[]} midis
   * @param {{mono?: boolean, anyOctave?: boolean}} [opts]  `anyOctave`: `midis`
   *   is a note expanded across every octave, i.e. per pitch class the octaves
   *   are alternatives (play ANY one), not a chord that needs them all. The
   *   comb-scan then reports at most one octave per pitch class. Can't be
   *   inferred: a real A2+A3 chord has the identical shape.
   *
   *   `mono`: Whether `midis` represents one musical
   *   note (routes to the monophonic YIN path in `process()`) as opposed to a
   *   chord that happens to satisfy this set. This can't be inferred from the
   *   MIDI numbers themselves — e.g. "any octave" mode expands one target
   *   note into every octave of its pitch class before calling this, which
   *   *is* still one note (mono: true), but a genuine two-note chord a
   *   compound octave apart (e.g. A2+A3) has the exact same all-one-pitch-
   *   -class shape and is *not* (mono: false) — so the caller must say which.
   *
   *   Defaults to **false** (never auto-engages) — not merely "unambiguous
   *   cases only". The mono path assumes the actual signal is monophonic;
   *   if the real player also plays an unexpected extra note (easy to do by
   *   accident when only one note is expected), YIN's single-pitch estimate
   *   can lose lock on a genuine two-note dyad entirely, and the correctly-
   *   played expected note itself disappears from the output for as long as
   *   the extra note is held — verified against a real two-note recording.
   *   The comb-scan's ghost-suppression fixes (see far-below-expected-note
   *   and octave-above-ghost handling) now cover single-note harmonic-ghost
   *   cases about as well as the mono path did, without that failure mode,
   *   so there's no longer a good reason to opt into mono by default.
   */
  setExpected(midis, opts = {}) {
    this.expected.clear()
    if (midis) {
      for (const m of midis) {
        const r = Math.round(m)
        if (Number.isFinite(r) && r >= this.cfg.minMidi && r <= this.cfg.maxMidi) {
          this.expected.add(r)
        }
      }
    }
    this.monoActive = !!opts.mono
    this.anyOctave = !!opts.anyOctave
    this.expectedPcs = new Set([...this.expected].map((m) => m % 12))
  }

  reset() {
    this.attackState.clear()
    this.calibState.clear()
    this.state.clear()
    this.monoState = { midi: null, onCount: 0, unconfident: 0, candMidi: null, candCount: 0, combLive: false }
    this.prevMag.fill(0)
    this.fluxMean = 0
    this.fluxVar = 1
    this.prevFluxNorm = 0
  }

  _st(midi) {
    let s = this.state.get(midi)
    if (!s) { s = { on: false, onCount: 0, offCount: 0 }; this.state.set(midi, s) }
    return s
  }

  /** Windowed FFT of `frame` -> this.mag (raw magnitude, pre noise-subtraction). */
  _spectrum(frame) {
    const { re, im, hann, frame: N, fftN } = this
    for (let i = 0; i < N; i++) { re[i] = frame[i] * hann[i]; im[i] = 0 }
    for (let i = N; i < fftN; i++) { re[i] = 0; im[i] = 0 }
    fftInPlace(re, im, this.rev, this.tw)
    for (let i = 0; i < this.bins; i++) this.mag[i] = Math.hypot(re[i], im[i])
  }

  /**
   * Unwindowed FFT of `frame` into this.re/this.im. Used only for the
   * autocorrelation-based mono pitch estimate below — windowing (as
   * `_spectrum` does, for good spectral-leakage behavior) would bias short
   * lags, since a smooth window's own envelope autocorrelates strongly at
   * short lags independent of any pitch, swamping the real signal there.
   */
  _rawFFT(frame) {
    const { re, im, frame: N, fftN } = this
    for (let i = 0; i < N; i++) { re[i] = frame[i]; im[i] = 0 }
    for (let i = N; i < fftN; i++) { re[i] = 0; im[i] = 0 }
    fftInPlace(re, im, this.rev, this.tw)
  }

  /**
   * Circular autocorrelation of whatever is currently in this.re/this.im
   * (X[k]), via Wiener–Khinchin: autocorr(x) = IFFT(|FFT(x)|^2). |X|^2 is real
   * and even, so its IFFT is real, and — because the FFT of a real+even
   * sequence is itself real+even — it equals a second forward FFT of the
   * power spectrum, scaled by 1/N. Overwrites re/im with the (unnormalized)
   * autocorrelation r(tau) at each index. Returns r(0) (total energy) for
   * normalizing r(tau)/r(0).
   */
  _autocorrFromSpectrum() {
    const { re, im, fftN, bins } = this
    // Direct bins 0..bins (DC through Nyquist inclusive), then mirror the rest
    // — a real signal's spectrum is Hermitian, so |X[fftN-k]| === |X[k]|.
    for (let k = 0; k <= bins; k++) re[k] = re[k] * re[k] + im[k] * im[k]
    for (let k = 1; k < bins; k++) re[fftN - k] = re[k]
    im.fill(0)
    fftInPlace(re, im, this.rev, this.tw)
    // this.re[tau] now holds the (unnormalized) autocorrelation at each lag.
  }

  /**
   * Best single-pitch estimate for a monophonic (one-expected-note) frame,
   * via YIN's cumulative mean normalized difference function (CMNDF).
   *
   * Raw normalized autocorrelation r(tau)/r(0) is *not* usable directly: for
   * any band-limited signal (periodic or not) it decays smoothly from 1 at
   * short lags just because nearby samples of a smooth waveform resemble each
   * other — that decay has nothing to do with the fundamental period, and
   * swamps genuine periodicity peaks. YIN's fix is to work with the
   * *difference* function d(tau) = sum (x[i]-x[i+tau])^2, then normalize each
   * d(tau) by the running mean of d(1..tau): that ratio only dips sharply at a
   * lag where the signal actually repeats, because the smooth short-lag trend
   * cancels out of the ratio.
   *
   * d(tau) expands to E(tau) + E(0) - 2*ACF(tau), and — approximating the two
   * windowed energy terms as both ≈ ACF(0) (valid since tau << frame length,
   * so the energy lost/gained at the edges is a small fraction of the total)
   * — reduces to d(tau) ≈ 2*(ACF(0) - ACF(tau)). That lets the whole CMNDF
   * curve be derived from the one FFT-based autocorrelation in O(maxLag),
   * instead of YIN's usual O(N·maxLag) direct computation.
   */
  _monoPitch(frame, rawMagMean) {
    this._rawFFT(frame)
    this._autocorrFromSpectrum()
    const { re, cand, cfg } = this
    const r0 = re[0]
    const maxLag = Math.min(cand[0].tauSamples, this.fftN - 1)

    let cumD = 0
    let globalBestTau = 1
    let globalBestCmndf = Infinity
    const cmndf = this._cmndfScratch ?? (this._cmndfScratch = new Float64Array(cand[0].tauSamples + 1))
    for (let tau = 1; tau <= maxLag; tau++) {
      const d = Math.max(0, 2 * (r0 - re[tau]))
      cumD += d
      const v = (d * tau) / (cumD + 1e-12)
      cmndf[tau] = v
      if (v < globalBestCmndf) { globalBestCmndf = v; globalBestTau = tau }
    }

    // Standard YIN dip search: the first lag whose CMNDF drops below the
    // absolute threshold, refined forward to that dip's local minimum (so a
    // lag right at the crossing point, before the dip has fully bottomed out,
    // doesn't win over the true period a few samples further on).
    let foundTau = -1
    for (let tau = 2; tau <= maxLag; tau++) {
      if (cmndf[tau] < cfg.monoCmndfThreshold) {
        let t = tau
        while (t + 1 <= maxLag && cmndf[t + 1] < cmndf[t]) t++
        foundTau = t
        break
      }
    }

    // Weak tier: piano bass notes often have a weak fundamental, which
    // shallows the dip (measured: a correctly-estimated F0 sits at CMNDF
    // 0.20-0.25, just over the strict gate, for its whole sustain). Take the
    // first local minimum under the looser threshold — first, not global, so
    // a period-multiple (octave-below) dip can't win — but only if the
    // spectrum independently confirms a real pitched tone there (below, same
    // check every estimate gets).
    let weak = false
    if (foundTau < 0) {
      for (let tau = 2; tau < maxLag; tau++) {
        if (cmndf[tau] < cfg.monoCmndfWeak && cmndf[tau] <= cmndf[tau - 1] && cmndf[tau] <= cmndf[tau + 1]) {
          foundTau = tau
          weak = true
          break
        }
      }
    }

    const bestTau = foundTau > 0 ? foundTau : globalBestTau
    const bestCmndf = foundTau > 0 ? cmndf[bestTau] : globalBestCmndf
    const freq = this.sr / bestTau
    let bestMidi = cand[0].midi
    let bestDiff = Infinity
    for (const c of cand) {
      const diff = Math.abs(Math.log2(freq / c.f0))
      if (diff < bestDiff) { bestDiff = diff; bestMidi = c.midi }
    }

    // Spectral checks below use the frame's mean raw bin magnitude as the
    // noise-level yardstick (pre-subtraction, so its scale is stable).
    let mean = rawMagMean
    if (mean === undefined) {
      mean = 0
      for (let i = 0; i < this.bins; i++) mean += this.mag[i]
      mean /= this.bins
    }
    // Weak-fundamental notes make YIN read an octave high — see _octaveDown.
    const rawMidi = bestMidi
    bestMidi = this._octaveDown(bestMidi, mean)
    const octaveFixed = (rawMidi - bestMidi) / 12

    // Reject phantom / octave-below-alias pitches — see _pitchSupported.
    let confident = foundTau > 0
    if (confident) confident = this._pitchSupported(bestMidi, mean)
    return { midi: bestMidi, confidence: 1 - Math.min(1, bestCmndf), confident, weak, octaveFixed }
  }

  /**
   * Octave-up correction: walk `midi` down (one octave) if the
   * spectrum says the note an octave below is the real fundamental.
   *
   * When the fundamental is weaker than the 2nd harmonic (routine for a
   * struck piano string, and it changes during the decay: a real C3 read
   * correctly for 1.6s, then as C4 for 2.6s more), the signal is nearly
   * periodic at half the true period and YIN takes the shorter lag — and a
   * salience-based pick can land an octave high for the same reason. CMNDF or
   * comb score alone can't tell "C4" from "C3 with a weak fundamental" — but
   * the spectrum can: a real C3 has energy at its ODD harmonics (3f, 5f — 1.5x
   * and 2.5x the estimate), which a real C4 has none of. Measured: true notes
   * sit at 0.1-2x mean magnitude there; the mis-read C3 at 60-110x. The odd
   * harmonics AND the lower note's own fundamental (f/2) must all be present
   * (a two-note mix with stray energy at 1.5f/2.5f got pulled down an octave
   * otherwise — A2+C3 read as A1 on a real recording), so a single unrelated
   * note (e.g. a fifth above) can't trigger it.
   */
  _octaveDown(midi, mean) {
    const cfg = this.cfg
    // One octave only: a weak fundamental is the common case; needing the
    // fundamental AND 2nd harmonic both weak is rare, and allowing a second
    // step let a quiet real A4 slide down to A2 on sympathetic-resonance energy.
    for (let n = 0; n < 1 && midi - 12 >= cfg.minMidi; n++) {
      const f = 440 * Math.pow(2, (midi - 69) / 12)
      const at = (hz) => this._magAt(Math.round(hz / this.binHz))
      const odd = Math.min(at(0.5 * f), at(1.5 * f), at(2.5 * f))
      const own = Math.max(at(f), at(2 * f))
      if (odd > cfg.monoOctaveOddMean * mean && odd > cfg.monoOctaveOddRel * own) midi -= 12
      else break
    }
    return midi
  }

  /**
   * Does the spectrum actually back `midi` as a pitched note? >= 2 of its
   * first four harmonics must stand above monoHarmonicMean x the mean bin
   * magnitude, and one of them must be the fundamental or the 3rd.
   *
   * The "not only even harmonics" half is what rejects octave-BELOW aliases:
   * an alias (A1 for a sounding A2) gets all its support from even harmonics
   * — its 2nd and 4th are exactly the real note's 1st and 2nd — while its own
   * fundamental and 3rd harmonic are empty. Weak-fundamental bass still has
   * its 3rd, so it passes. Also rejects a close dyad's phantom "missing
   * fundamental" (C4 + D#4 read as G#1 live) — no energy at its own harmonics.
   */
  _pitchSupported(midi, mean) {
    const f = 440 * Math.pow(2, (midi - 69) / 12)
    let present = 0
    let h1 = false
    let h3 = false
    for (let k = 1; k <= 4; k++) {
      if (this._magAt(Math.round((k * f) / this.binHz)) > this.cfg.monoHarmonicMean * mean) {
        present++
        if (k === 1) h1 = true
        else if (k === 3) h3 = true
      }
    }
    return present >= 2 && (h1 || h3)
  }

  /**
   * Is non-expected candidate `m` probably just an upper harmonic of an
   * EXPECTED note? True when it sits 24-42 semitones (roughly the 4th-11th
   * harmonic) above one AND has no support of its own beyond that one
   * partial (see _pitchSupported). The upward mirror of the far-below-expected
   * rule: A2's 5th harmonic is C#5-ish, and a real recording of a single A2
   * reported C#5/C#6 as an extra note on 6-18% of frames. Only fires for
   * candidates that would otherwise latch, so it costs nothing per frame.
   */
  _isHarmonicOnly(m, mean) {
    let near = false
    for (const e of this.expected) {
      const d = m - e
      if (d > 24 && d <= 42) { near = true; break }
    }
    return near && !this._pitchSupported(m, mean)
  }

  /**
   * Is EXPECTED note `e` probably just an upper harmonic of a real lower note
   * that is NOT expected? True when some non-expected pitch `w` sits at (about)
   * a harmonic offset below `e` (2nd..10th: 12, 19, 24, 28, 31, 34, 36, 38, 40
   * semitones, +-1 for low-frequency bin smearing), is above the sub-bass
   * floor, is spectrally supported as a real pitched note (_pitchSupported),
   * and has a fundamental that isn't negligible next to `e`'s.
   *
   * The expected-note threshold is deliberately lenient, and it latches in one
   * frame while a non-expected note needs framesOnScan of hysteresis — so a
   * wrong low note played against a target that happens to be its harmonic
   * (G1 vs an Eb4 target: 32 semitones up, its 6th harmonic) had the target
   * reported as "played" for the first ~100 ms of every attack. With advance-
   * on-detection that was an instant false match. If a real, unexpected lower
   * note is sounding, the player made a mistake either way (that note is an
   * extra), so dropping `e` costs nothing and closes the hole. Whether the
   * lower note is expected is the whole point: a genuine chord (E2 + B3) has
   * both expected, so this never fires for it.
   */
  _explainedByLower(e, mean) {
    const cfg = this.cfg
    for (let k = 2; k <= 10; k++) {
      const off = Math.round(12 * Math.log2(k))
      for (let d = -1; d <= 1; d++) {
        const w = e - off + d
        if (w < cfg.minScanMidi || w >= e || this.expected.has(w)) continue
        // A pitch within 2 semitones of an expected note is that note's own
        // spectral leakage / low-frequency smear, not an independent lower note
        // (the +-1 slack above is what would otherwise let D#2 — leakage of an
        // expected E2 — "explain" and veto its own chord partner B3).
        let leak = false
        for (const x of this.expected) if (Math.abs(w - x) <= 2) { leak = true; break }
        if (leak) continue
        if (this.fund[w] >= 0.2 * this.fund[e] && this._pitchSupported(w, mean)) return true
      }
    }
    return false
  }

  /**
   * Number of distinct spectral peaks (capped at `cap`) standing well above
   * the noise level. A note has several harmonics; a dyad has more; broadband
   * noise essentially never has any (Rayleigh-distributed bin magnitudes top
   * out around 4-5x the mean, far under monoHarmonicMean x).
   */
  _tonalPeaks(rawMagMean, cap) {
    const thr = this.cfg.monoHarmonicMean * rawMagMean
    const m = this.mag
    let n = 0
    for (let i = 2; i < this.bins - 2 && n < cap; i++) {
      if (m[i] > thr && m[i] >= m[i - 1] && m[i] >= m[i + 1]) { n++; i += 2 }
    }
    return n
  }

  /**
   * YIN-first decision for a single expected note, with the comb-scan as a
   * fallback. YIN never consults the expected-note prior, so it reports what
   * is actually being played: a wrong low note held for a long time stays a
   * wrong note, instead of the (very lenient) expected-note threshold
   * eventually accepting one of that note's own harmonics as "the right
   * note" — and a note's own octave-below ghost (C3 read as C3+C2) can't
   * appear, since YIN estimates one fundamental period, not a set of comb
   * scores.
   *
   * YIN alone assumes a monophonic signal; if a second note is also sounding
   * (an accidental extra key) it can lose lock on the mix. So it doesn't
   * get to drop the note: on lost confidence it first *coasts* on the last
   * latched note, and only after `monoFallbackFrames` of sustained
   * unconfidence does it hand the frame to the comb-scan, which reports the
   * dyad properly. Pitch changes while latched need `monoSwitchFrames` of
   * agreement unless a fresh attack (onset) backs them, so period-doubling
   * flicker during a decay can't bounce the output between octaves.
   */
  _processMono(frame, rms, onset, rawMagMean) {
    const cfg = this.cfg
    const est = this._monoPitch(frame, rawMagMean)
    const ms = this.monoState

    if (est.confident) {
      ms.unconfident = 0
      if (ms.combLive) {
        // Leaving fallback: drop stale comb-scan hysteresis so a later
        // fallback starts cold instead of replaying old held notes.
        for (const s of this.state.values()) { s.on = false; s.onCount = 0; s.offCount = 0 }
        ms.combLive = false
      }
      if (est.midi === ms.midi) {
        ms.onCount++
        ms.candMidi = null
      } else if (ms.midi == null || onset) {
        ms.midi = est.midi
        ms.onCount = 1
        ms.candMidi = null
      } else {
        ms.candCount = ms.candMidi === est.midi ? ms.candCount + 1 : 1
        ms.candMidi = est.midi
        if (ms.candCount >= cfg.monoSwitchFrames) {
          ms.midi = est.midi
          ms.onCount = cfg.monoFramesOn
          ms.candMidi = null
        }
      }
    } else {
      ms.unconfident++
      if (ms.unconfident >= cfg.monoFallbackFrames) {
        ms.midi = null
        ms.onCount = 0
        ms.candMidi = null
        // Only hand over if the frame actually contains tones. The comb-scan's
        // expected-note prior is lenient enough to latch the expected note out
        // of pure noise (measured: 4-41% of noise frames, even with a learned
        // profile), so without this gate the fallback would report a
        // "correct" note in a room with nothing being played.
        if (this._tonalPeaks(rawMagMean, 3) < 3) {
          if (ms.combLive) {
            for (const s of this.state.values()) { s.on = false; s.onCount = 0; s.offCount = 0 }
            ms.combLive = false
          }
          return {
            silent: false, rms, onset, heldMidi: [], held: [],
            hasNoise: this.hasNoise, debugActive: [],
          }
        }
        ms.combLive = true
        return this._combScan(rms, onset, rawMagMean)
      }
    }

    const framesOn = onset ? 1 : cfg.monoFramesOn
    const heldMidi = ms.midi != null && ms.onCount >= framesOn ? [ms.midi] : []
    const r = Math.round(est.confidence * 100) / 100
    const debugActive = heldMidi.map((m) => ({
      midi: m, name: midiToNoteNamePitch(m), rel: r, snr: r, expected: this.expected.has(m),
    }))
    return {
      silent: false, rms, onset, heldMidi, held: heldMidi.map(midiToNoteNamePitch),
      hasNoise: this.hasNoise, debugActive,
    }
  }

  /** Feed a frame known to be background noise; updates the noise profile. */
  learnNoise(frame) {
    this._spectrum(frame)
    const r = this.cfg.noiseAdaptRate
    for (let i = 0; i < this.bins; i++) {
      this.noiseMag[i] = this.hasNoise ? (1 - r) * this.noiseMag[i] + r * this.mag[i] : this.mag[i]
    }
    this.hasNoise = true
  }

  /**
   * Continuous per-bin noise-floor tracking, run every frame regardless of
   * whether this one is silent — an asymmetric minimum-follower (see
   * noiseFloorFallRate/RiseRate above). Must run on RAW magnitude, before
   * spectral subtraction overwrites this.mag.
   *
   * Before any profile exists at all, only a genuinely silent frame (or an
   * explicit learnNoise() call) may bootstrap it — never an arbitrary
   * non-silent frame, whose "magnitude" is just whatever signal happens to be
   * playing. Bootstrapping from real signal would copy the tone itself as
   * the "noise profile" and then subtract nearly the entire note away on
   * every subsequent frame.
   */
  _updateNoiseFloor(rms, isSilent) {
    const { mag, noiseMag, bins, cfg } = this
    if (!this.hasNoise) {
      if (!isSilent) return
      noiseMag.set(mag)
      this.hasNoise = true
      return
    }
    const fall = cfg.noiseFloorFallRate
    // A held note keeps the frame loud for as long as it's sustained — any
    // nonzero rise rate, given enough time, eventually drags the floor up
    // into the note's own harmonic bins and the note gets subtracted away
    // (verified: even 0.0005 fully erodes a sustained chord within ~10s).
    // Gate rise on the frame being quiet-ish overall, so a loud sustained
    // note can never itself be mistaken for a rising noise floor — only an
    // actually-quiet passage lets the estimate climb to catch up with a
    // louder room.
    const rise = rms <= cfg.noiseFloorRiseRmsMax ? cfg.noiseFloorRiseRate : 0
    for (let i = 0; i < bins; i++) {
      const m = mag[i]
      const n = noiseMag[i]
      noiseMag[i] = m < n ? n + (m - n) * fall : n + (m - n) * rise
    }
  }

  /** Amplitude near `hz` (max of +-1 bin, on the noise-subtracted spectrum). */
  _ampAtHz(hz) {
    const b = Math.round(hz / this.binHz)
    if (b < 2 || b >= this.bins - 1) return 0
    return this._magAt(b)
  }

  /**
   * Strike clock for every calibrated / watched note. A note's fundamental
   * amplitude jumping by `calibRestrikeRatio` frame-to-frame (and clearing the
   * noise) is an attack; consecutive rising frames within `calibRestrikeGapSec`
   * are the same strike, not new ones. Live detection and the setup wizard use
   * this one definition of "age", so a recorded curve is read at the same ages
   * it was captured at.
   */
  _trackAttacks(rawMagMean) {
    if (!this.calib && this.watch.size === 0) return
    const cfg = this.cfg
    const seen = this.calib ? Object.keys(this.calib.notes) : []
    const check = (m, f1) => {
      const a = this._ampAtHz(f1)
      const st = this.attackState.get(m) || { last: 0, at: null }
      // A real strike moves the whole frame's energy/flux; beating between a
      // ringing note's unison strings changes one bin's amplitude by as much
      // but never fires an onset, so require both.
      const rising = a > cfg.calibRestrikeRatio * st.last && a > cfg.calibFundMean * rawMagMean
        && this.clock - this.lastOnsetAt <= cfg.calibRestrikeOnsetSec
      if (rising && (st.at == null || this.clock - st.at > cfg.calibRestrikeGapSec)) st.at = this.clock
      st.last = a
      this.attackState.set(m, st)
    }
    for (const k of seen) {
      const e = this.calib.notes[k]
      check(+k, e.f?.[0] ?? midiToHz(+k))
    }
    for (const m of this.watch) if (!this.calib?.notes[m]) check(m, midiToHz(m))
  }

  /**
   * Calibrated octave-pair resolution. For an EXPECTED upper note U = X + 12k
   * whose lower partner X is also expected, currently held, and calibrated,
   * decide "is U really being played?" from the one number a generic model
   * can't know — how strong X's own partial n = 2^k is when X sounds ALONE
   * (the user's recorded curve, read at X's age) — instead of from comb
   * salience, which can't tell X's harmonic from a second note.
   *
   * It overrides both failures of the generic path: a lone X lighting up U
   * (false accept), and a real U hidden under X's harmonic (missed top note).
   * Anything not covered (no calibration, X not calibrated/held, any-octave
   * mode) falls through to the comb-scan result untouched.
   */
  _applyCalibration(active, rawMagMean, sal, maxSal) {
    if (!this.calib || this.anyOctave) return
    const cfg = this.cfg
    const notes = this.calib.notes
    const present = new Set(active.map((a) => a.midi))
    const drop = new Set()
    const add = []
    const targets = [...this.expected].sort((a, b) => a - b)
    for (const U of targets) {
      const st = this.calibState.get(U)
      let verdict = null // true/false, or null = not decidable here
      let rho = null
      for (let k = 1; k <= 2 && verdict === null; k++) {
        const X = U - 12 * k
        if (!this.expected.has(X) || !notes[X]) continue
        // X must itself be (still) judged present: earlier iterations may have
        // dropped it (chain A1 -> A2 -> A3).
        if (!present.has(X)) continue
        const e = notes[X]
        const n = 2 ** k
        const age = this.attackAge(X)
        const curve = e.r?.[n]
        if (age == null || !curve || e.f?.[0] == null || e.f?.[n - 1] == null) continue
        const a1 = this._ampAtHz(e.f[0])
        if (a1 < cfg.calibFundMean * rawMagMean) continue
        const an = this._ampAtHz(e.f[n - 1])
        rho = an / a1
        const loud = an > cfg.calibPartialMean * rawMagMean
        const ref = st?.hist?.length ? Math.min(...st.hist) : rho
        if (age <= cfg.calibEarlySec) {
          const c = curveAt(e.ages, curve, age)
          const thr = Math.max((st?.on ? cfg.calibOffK : cfg.calibK) * c, cfg.calibMinRatio)
          verdict = loud && rho > thr
        } else if (st?.on) {
          verdict = true // hold: see calibEarlySec
        } else {
          // Beats between a note's unison strings modulate its amplitude by
          // enough to fake a ratio jump, so a jump only counts right after a
          // real strike (flux/energy attack) somewhere in the window.
          const struck = this.clock - this.lastOnsetAt <= cfg.calibStrikeWindowSec
          verdict = loud && struck && rho > cfg.calibJumpRatio * ref
        }
      }
      if (verdict === null) { this.calibState.delete(U); continue }
      const cs = st || { on: false, count: 0, hist: [] }
      if (verdict === cs.on) cs.count = 0
      else if (++cs.count >= (verdict ? cfg.calibFramesOn : cfg.calibFramesOff)) { cs.on = verdict; cs.count = 0 }
      if (rho != null) { cs.hist.push(rho); if (cs.hist.length > 4) cs.hist.shift() }
      this.calibState.set(U, cs)
      if (cs.on && !present.has(U)) {
        add.push({ midi: U, rel: Math.min(1, sal[U] / maxSal) || 0.5, snr: 0, isExp: true, calibrated: true })
        present.add(U)
      } else if (!cs.on && present.has(U)) {
        drop.add(U)
        present.delete(U)
      }
    }
    if (drop.size === 0 && add.length === 0) return
    for (let i = active.length - 1; i >= 0; i--) if (drop.has(active[i].midi)) active.splice(i, 1)
    for (const a of add) active.push(a)
  }

  _magAt(b) {
    const m = this.mag
    let v = m[b]
    if (m[b - 1] > v) v = m[b - 1]
    if (m[b + 1] > v) v = m[b + 1]
    return v
  }

  /**
   * Process one analysis frame.
   * @param {Float32Array} frame  length === cfg.frameSize
   * @returns {{silent:boolean, rms:number, onset:boolean, heldMidi:number[], held:string[]}}
   */
  process(frame, tSec) {
    const cfg = this.cfg
    this.clock = tSec != null ? tSec : (this.autoClock += cfg.analysisIntervalMs / 1000)
    let rms = 0
    for (let i = 0; i < this.frame; i++) rms += frame[i] * frame[i]
    rms = Math.sqrt(rms / this.frame)

    this._spectrum(frame)

    // Mean bin magnitude BEFORE noise subtraction — the SNR gate references this
    // so its scale doesn't collapse once subtraction zeroes most of the frame.
    let rawMagMean = 0
    for (let i = 0; i < this.bins; i++) rawMagMean += this.mag[i]
    rawMagMean /= this.bins
    this.lastRawMagMean = rawMagMean

    // Silence: release everything. Noise-floor tracking below still runs
    // (it's not gated on this) — a genuinely quiet frame just lets it fall
    // fastest, same mechanism as any other quiet moment.
    if (rms < cfg.rmsGate) {
      this._updateNoiseFloor(rms, true)
      for (const s of this.state.values()) { s.on = false; s.onCount = 0; s.offCount = 0 }
      this.monoState = { midi: null, onCount: 0, unconfident: 0, candMidi: null, candCount: 0, combLive: false }
      this.groupPick.clear()
      this.attackState.clear()
      this.calibState.clear()
      this.prevRms = rms
      this.prevMag.set(this.mag)
      return { silent: true, rms, onset: false, heldMidi: [], held: [], hasNoise: this.hasNoise, debugActive: [] }
    }

    // Continuous adaptive noise-floor tracking — every frame, not just
    // detected silence (see noiseFloorFallRate/RiseRate comment above).
    this._updateNoiseFloor(rms, false)

    // Adaptive spectral subtraction against the learned noise profile.
    if (this.hasNoise) {
      const os = cfg.noiseOversub
      const fl = cfg.noiseFloorFrac
      for (let i = 0; i < this.bins; i++) {
        const sub = this.mag[i] - os * this.noiseMag[i]
        const floor = fl * this.mag[i]
        this.mag[i] = sub > floor ? sub : floor
      }
    }

    // Spectral flux -> onset.
    let flux = 0
    let magSum = 0
    for (let i = 0; i < this.bins; i++) {
      const d = this.mag[i] - this.prevMag[i]
      if (d > 0) flux += d
      magSum += this.mag[i]
      this.prevMag[i] = this.mag[i]
    }
    const fluxNorm = flux / (magSum + 1e-9)
    const sd = Math.sqrt(this.fluxVar) + 1e-9
    const onset = fluxNorm > this.fluxMean + cfg.onsetSensitivity * sd && fluxNorm > this.prevFluxNorm
    this.fluxMean += 0.05 * (fluxNorm - this.fluxMean)
    this.fluxVar += 0.05 * ((fluxNorm - this.fluxMean) * (fluxNorm - this.fluxMean) - this.fluxVar)
    this.prevFluxNorm = fluxNorm
    // A strike of any key, by spectral flux OR a frame-energy rise (flux alone
    // misses real attacks in dense playing; same rule the live loop reports).
    if (onset || (rms > this.prevRms * 1.25 && rms > cfg.rmsGate * 2)) this.lastOnsetAt = this.clock
    this.prevRms = rms
    this._trackAttacks(rawMagMean)

    // Exactly one expected note -> YIN-first path (see monoCmndfThreshold
    // comment above), with the spectral comb-scan as its fallback.
    if (this.monoActive) return this._processMono(frame, rms, onset, rawMagMean)
    return this._combScan(rms, onset, rawMagMean)
  }

  /**
   * Spectral harmonic-comb scan over every candidate pitch, with the
   * expected-note prior, ghost suppression, and hysteresis. Handles chords /
   * free play, and is the monophonic path's fallback when YIN loses lock.
   */
  _combScan(rms, onset, rawMagMean) {
    const cfg = this.cfg
    // Reference level for the absolute SNR gate.
    const noiseFloor = rawMagMean * 0.5 + 1e-9

    // Harmonic-comb salience for every candidate pitch. Also score what the
    // learned noise profile alone would contribute to each comb, so a candidate
    // that is really just structured background noise can be rejected.
    const { raw, sal, fund, noiseComb, lowSup } = this
    const nLow = Math.min(3, cfg.minLowHarmonics + 1)
    for (const c of this.cand) {
      let s = 0
      let ns = 0
      let peakLow = 1e-12
      let peakAll = 1e-12
      for (let k = 0; k < c.hb.length; k++) {
        const hm = this._magAt(c.hb[k])
        s += c.hw[k] * hm
        if (hm > peakAll) peakAll = hm
        if (k < nLow && hm > peakLow) peakLow = hm
        if (this.hasNoise) ns += c.hw[k] * this.noiseMag[c.hb[k]]
      }
      const fm = c.fundBin >= 2 ? this._magAt(c.fundBin) : 0
      // How many of the first few harmonics actually carry energy — a real tone
      // has several; a spurious alignment via one high harmonic has one. A
      // harmonic must clear both a fraction of the comb's own peak AND an
      // absolute floor above the frame's mean bin level (so a comb sitting in
      // noise doesn't "pass" by all-equal near-zero bins). A dominant, real
      // fundamental (e.g. an almost-pure tone) counts as full support on its own.
      const hFloor = Math.max(cfg.lowHarmonicFrac * peakLow, 2 * rawMagMean)
      let sup = 0
      const lim = Math.min(nLow, c.hb.length)
      for (let k = 0; k < lim; k++) {
        if (this._magAt(c.hb[k]) > hFloor) sup++
      }
      if (fm >= 0.4 * peakAll && fm > 2 * rawMagMean) sup = Math.max(sup, cfg.minLowHarmonics)
      lowSup[c.midi] = sup
      raw[c.midi] = s
      sal[c.midi] = s
      noiseComb[c.midi] = ns
      fund[c.midi] = fm
    }

    // Ghost suppression for non-expected pitches.
    //  - "above" ghost: m sits an octave/twelfth/2-octaves above a strong
    //    lower note (m-12/-19/-24) — suppressed unconditionally (given the
    //    other checks below) whenever that lower note is real. NOT gated on
    //    "m's own fundamental is weak": that assumption is false for real
    //    piano audio. Every harmonic of the note an octave above is *also*
    //    an exact harmonic of the note below (2:1 ratio), and a struck
    //    string's 2nd harmonic is very often *louder* than its own
    //    fundamental — so m's "own fundamental" bin (really the lower note's
    //    2nd harmonic) being strong proves nothing about whether m is a real
    //    second note. There is no spectral amplitude pattern that can tell
    //    the two cases apart; this is a genuine, permanent ambiguity, not a
    //    threshold to tune. Tradeoff: this can't flag an accidental extra
    //    note that happens to be an octave above a correct one — accepted,
    //    since a deliberate octave-doubled target still detects fine (m is
    //    then in `expected`, so this whole block doesn't apply to it).
    //  - "below" ghost: m's comb aliases a strong higher note that sits on m's
    //    harmonics (m+12 / +19 / +24) and m has no real fundamental of its own.
    //    Only fire when the *other* note has a genuine fundamental, so a phantom
    //    bass note (whose comb happens to alias several real notes) can't
    //    suppress a real note an octave above it. Unlike the "above" case,
    //    m's own fundamental *is* a valid test here: a notionally lower
    //    fundamental frequency doesn't receive energy just because a note an
    //    octave above it is sounding (none of that note's harmonics land
    //    there), so a real simultaneous low note should still show genuine
    //    low-frequency energy of its own.
    //  - far-below-expected ghost: a bass candidate's comb packs up to
    //    maxHarmonics partials into the same range a treble note occupies with
    //    just its first few — the 5th, 6th, ... harmonic (≈28, 31, 34, 36, 38,
    //    40 semitones above the bass candidate) can land on an EXPECTED note's
    //    real energy by coincidence and score just from that one bin, well
    //    past the +12/+19/+24 cases above. Scoped to *expected* notes
    //    specifically (not just any strong candidate) — a real, unscored bass
    //    note this far below what the score currently expects is rare enough,
    //    and this false positive common enough, to suppress on span alone.
    const g = (m) => (m >= 0 && m <= cfg.maxMidi ? raw[m] : 0)
    const gf = (m) => (m >= 0 && m <= cfg.maxMidi ? fund[m] : 0)
    const realFund = 2 * rawMagMean
    let maxSal = 1e-9
    for (const c of this.cand) {
      const m = c.midi
      if (!this.expected.has(m)) {
        const fx = fund[m]
        if (gf(m + 12) > realFund && g(m + 12) > 0.6 * raw[m] && fx < 0.5 * gf(m + 12)) sal[m] *= 0.15
        else if (gf(m + 24) > realFund && g(m + 24) > 0.6 * raw[m] && fx < 0.5 * gf(m + 24)) sal[m] *= 0.15
        else if (gf(m + 19) > realFund && g(m + 19) > 0.7 * raw[m] && fx < 0.4 * gf(m + 19)) sal[m] *= 0.25
        else if (gf(m - 12) > realFund && g(m - 12) > 0.6 * raw[m]) sal[m] *= 0.15
        else if (gf(m - 24) > realFund && g(m - 24) > 0.6 * raw[m]) sal[m] *= 0.15
        else if (gf(m - 19) > realFund && g(m - 19) > 0.7 * raw[m]) sal[m] *= 0.25
        else {
          for (const e of this.expected) {
            if (e - m >= cfg.expectedGhostSpanSemitones && fx < 0.5 * gf(e)) { sal[m] *= 0.15; break }
          }
        }
      }
      if (sal[m] > maxSal) maxSal = sal[m]
    }

    // Decision with prior + hysteresis.
    const active = []
    for (const c of this.cand) {
      const m = c.midi
      const st = this._st(m)
      const isExp = this.expected.has(m)
      const rel = sal[m] / maxSal
      const snr = sal[m] / (noiseFloor * (c.wsum || 1))

      // Non-maximum suppression: skip a candidate that a near-neighbour beats.
      // Low notes can't be resolved to a single semitone, so a cluster collapses
      // to its strongest member. Expected notes are exempt — the prior wants
      // them through even if an unresolvable neighbour ties.
      let localMax = true
      if (!isExp) {
        for (let j = 1; j <= c.nmsR; j++) {
          if (sal[m - j] > sal[m] || sal[m + j] >= sal[m]) { localMax = false; break }
        }
      }

      // Structured-noise gate: the comb must beat the noise profile's own comb.
      const aboveNoise = !this.hasNoise || raw[m] > cfg.noiseGateRatio * noiseComb[m]

      // Harmonic-support gate: enough of the low harmonics must be real.
      const nReq = Math.min(cfg.minLowHarmonics, c.hb.length)
      const supported = this.lowSup[m] >= nReq

      let tOn = isExp ? cfg.tOnExpected : cfg.tOnScan
      let snrOn = isExp ? cfg.snrOnExpected : cfg.snrOnScan
      let framesOn = isExp ? cfg.framesOnExpected : cfg.framesOnScan
      if (onset) { tOn *= 0.7; snrOn *= 0.8; framesOn = 1 }
      const tOff = tOn * cfg.tOffRatio
      // Below minScanMidi only an expected note may latch: see the knob.
      const canOn = rel >= tOn && snr >= snrOn && localMax && aboveNoise && supported
        && (isExp || (m >= cfg.minScanMidi && !this._isHarmonicOnly(m, rawMagMean)))

      if (!st.on) {
        if (canOn) {
          st.onCount++
          if (st.onCount >= framesOn) { st.on = true; st.offCount = 0 }
        } else {
          st.onCount = 0
        }
      } else if (rel < tOff || snr < snrOn * cfg.tOffRatio) {
        st.offCount++
        if (st.offCount >= cfg.framesOff) { st.on = false; st.onCount = 0 }
      } else {
        st.offCount = 0
      }
      if (st.on) active.push({ midi: c.midi, rel, snr, isExp })
    }

    // Drop expected notes that are really a real unexpected lower note's
    // harmonic (see _explainedByLower). Not in any-octave mode: there every
    // octave is expected, so the lower "note" is an alternative, not an extra.
    if (!this.anyOctave) {
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].isExp && this._explainedByLower(active[i].midi, rawMagMean)) active.splice(i, 1)
      }
    }

    // Calibrated octave pairs (no-op without a mic calibration).
    this._applyCalibration(active, rawMagMean, sal, maxSal)

    // "Any octave" targets: every octave of a pitch class is expected, which
    // exempts all of them from ghost suppression and gives all of them the
    // lenient expected-note threshold — so one played A reported A-1, A0, A2,
    // A3 and A4 together (seen on a real A2 recording). They're alternatives,
    // so keep one octave per pitch class: the lowest with real spectral
    // support (a genuine A2 has energy at its fundamental/3rd; its octave-up
    // aliases and sub-octave ghosts don't, or are higher than it).
    if (this.anyOctave && active.length > 1) {
      const groups = new Map()
      const keep = []
      for (const a of active) {
        const pc = a.midi % 12
        if (!this.expectedPcs.has(pc)) { keep.push(a); continue }
        if (!groups.has(pc)) groups.set(pc, [])
        groups.get(pc).push(a)
      }
      for (const list of groups.values()) {
        // Highest comb salience among the spectrally-supported octaves (raw
        // "lowest supported" was wrong: late in a decay the frame's mean
        // magnitude is small and low-frequency rumble makes 27.5/55 Hz
        // "supported"), then the odd-harmonic check in case salience landed an
        // octave high on a weak-fundamental note.
        const audible = list.filter((a) => a.midi >= cfg.minScanMidi)
        const cands = audible.length ? audible : list
        const supported = cands.filter((a) => this._pitchSupported(a.midi, rawMagMean))
        const pool = supported.length ? supported : cands
        let best = pool.reduce((b, a) => (a.rel > b.rel ? a : b))
        // Sticky: octave is irrelevant to matching in this mode, and on a
        // bass note whose fundamental has faded (F0's sits at 7-19x mean,
        // then lower) salience and the odd-harmonic check can both go either
        // way frame to frame. Keep last frame's octave while it's still
        // active and reasonably close, so the display doesn't flap.
        const pc = best.midi % 12
        const prev = this.groupPick.get(pc)
        const held = prev != null && pool.find((a) => a.midi === prev)
        if (held && held.rel >= 0.5 * best.rel) best = held
        else best = { ...best, midi: this._octaveDown(best.midi, rawMagMean) }
        this.groupPick.set(pc, best.midi)
        keep.push(best)
      }
      active.length = 0
      active.push(...keep)
    }

    active.sort((a, b) => b.rel - a.rel)
    const heldMidi = active.slice(0, cfg.maxPolyphony).map((a) => a.midi).sort((a, b) => a - b)
    // Debug breakdown of every currently-held candidate — why it fired, not just
    // that it fired. `active` still carries every held candidate even if
    // maxPolyphony truncated `heldMidi`.
    const debugActive = active.map((a) => ({
      midi: a.midi,
      name: midiToNoteNamePitch(a.midi),
      rel: Math.round(a.rel * 100) / 100,
      snr: Math.round(a.snr * 10) / 10,
      expected: a.isExp,
    }))
    return {
      silent: false, rms, onset, heldMidi, held: heldMidi.map(midiToNoteNamePitch),
      hasNoise: this.hasNoise, debugActive,
    }
  }
}

// ---------------------------------------------------------------------------
// Live mic detection.
// ---------------------------------------------------------------------------

/**
 * Start predictive detection from the microphone.
 *
 * @param {object}   opts
 * @param {(names: string[]|null, info?: {onset: boolean}) => void} opts.onNotes
 *        current held-note names, or null on silence / all released. `info.onset`
 *        is true when this call coincides with a fresh attack (spectral-flux
 *        onset), which is how a caller can tell a re-struck note from the same
 *        note still ringing.
 * @param {number[]} [opts.expected]  standard MIDI numbers the score expects now.
 * @param {boolean}  [opts.anyOctave]  `expected` is one note expanded across every
 *   octave (alternatives, not a chord) — see `PitchEngine.setExpected`.
 * @param {boolean}  [opts.mono]      whether `expected` is one musical note
 *   (see `PitchEngine.setExpected` for why this can't be inferred from the
 *   MIDI numbers alone). Defaults to true only when `expected` has exactly
 *   one value.
 * @param {object}   [opts.config]    partial DEFAULT_CONFIG override.
 * @param {object|null} [opts.calibration]  engine calibration (see
 *   micCalibration.toEngineCalibration). Omitted -> the active saved profile is
 *   loaded from storage; pass null to run uncalibrated (the setup wizard does).
 * @param {(f: {engine: PitchEngine, t: number, rms: number, silent: boolean,
 *   heldMidi: number[], held: string[], onset: boolean,
 *   active: {midi:number,name:string,rel:number,snr:number,expected:boolean}[]}) => void} [opts.onFrame]
 *   fires every analysis tick after process(); the setup wizard records strikes
 *   from it.
 * @param {boolean}  [opts.debug]
 * @param {(info: {rms:number, hasNoise:boolean, onset:boolean,
 *   active:{midi:number,name:string,rel:number,snr:number,expected:boolean}[]}) => void}
 *   [opts.onDebug]  fires every analysis tick with the raw per-candidate scores
 *   behind the final decision — use this to see what the engine is actually
 *   seeing (e.g. a single played note "held" alongside its harmonics still
 *   clearing the wrong-note threshold, or `hasNoise` never flipping true
 *   because rmsGate is miscalibrated for the room).
 * @returns {Promise<{ stop: () => void, setExpected: (midis: number[], opts?: {mono?: boolean}) => void }>}
 */
export async function startPredictiveDetection({ onNotes, expected = [], mono, anyOctave, config = {}, debug = DEBUG, onDebug = null, calibration, onFrame = null }) {
  const log = (...a) => debug && console.log('[Predictive]', ...a)

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false, // we do our own — browser NR mangles pitch
      autoGainControl: false,
    },
  })
  log('mic stream active:', stream.active)

  const audioCtx = new AudioContext()
  if (audioCtx.state === 'suspended') await audioCtx.resume()
  const SR = audioCtx.sampleRate
  log('sampleRate:', SR)

  // Calibration profile (saved once from the setup wizard): the octave-pair
  // check, plus an rmsGate sized to the room tone measured at setup.
  let cal = null
  if (calibration === undefined) {
    try { cal = loadActiveCalibration() } catch { cal = null }
  } else {
    cal = calibration
  }
  const cfgIn = { ...config }
  const gate = cal ? gateFromRoomRms(cal.roomRms) : null
  if (gate != null && cfgIn.rmsGate == null) cfgIn.rmsGate = gate

  const engine = new PitchEngine(SR, cfgIn)
  engine.setExpected(expected, { mono, anyOctave })
  if (cal) engine.setCalibration(cal)
  log('calibration:', cal ? `${cal.name} (${Object.keys(cal.notes).length} notes${gate != null ? `, rmsGate ${gate}` : ''})` : 'none')
  const FRAME = engine.frame

  const source = audioCtx.createMediaStreamSource(stream)

  // Rumble / handling-noise high-pass before anything else.
  const hp = audioCtx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = engine.cfg.highpassHz
  hp.Q.value = Math.SQRT1_2
  source.connect(hp)

  const processor = audioCtx.createScriptProcessor(2048, 1, 1)
  hp.connect(processor)
  const sink = audioCtx.createGain()
  sink.gain.value = 0
  processor.connect(sink)
  sink.connect(audioCtx.destination)

  const ring = new Float32Array(FRAME)
  let writePos = 0
  let samplesIn = 0
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0)
    for (let i = 0; i < input.length; i++) {
      ring[writePos] = input[i]
      writePos = (writePos + 1) % FRAME
    }
    samplesIn += input.length
  }

  const scratch = new Float32Array(FRAME)
  let lastSig = null
  let stopped = false
  let lastHasNoise = false
  let lastRms = 0

  const tick = () => {
    if (stopped || samplesIn < FRAME) return
    for (let i = 0; i < FRAME; i++) scratch[i] = ring[(writePos + i) % FRAME]
    const tNow = performance.now() / 1000
    const { silent, rms, heldMidi, held, onset: fluxOnset, hasNoise, debugActive } = engine.process(scratch, tNow)
    // Energy-based attack: a struck note makes the analysis window's RMS jump
    // (measured on real recordings: 1.4x-3.4x within one 25 ms hop for every
    // re-strike — forte, soft, half-volume, or a different note — and never
    // >1.25x during a normal decay), which flags a repeated pitch that is still
    // ringing from the previous note. Spectral-flux onset was unreliable there:
    // during dense playing the flux baseline is high, so real attacks fell
    // under it. Reported as `onset` to the caller only; the engine's own
    // thresholds keep using the flux onset.
    const attack = rms > lastRms * 1.25 && rms > engine.cfg.rmsGate * 2
    lastRms = rms
    const onset = fluxOnset || attack

    if (hasNoise !== lastHasNoise) {
      lastHasNoise = hasNoise
      log(hasNoise ? 'noise profile learned — subtraction active' : 'noise profile lost (reset)')
    }
    onDebug?.({ rms, hasNoise, onset, active: debugActive ?? [], calibration: cal ? `${cal.name} (${Object.keys(cal.notes).length})` : null })
    onFrame?.({ engine, t: tNow, rms, silent, heldMidi, held, onset, active: debugActive ?? [] })

    if (silent || held.length === 0) {
      if (lastSig !== null) { lastSig = null; onNotes(null) }
      return
    }
    const sig = heldMidi.join('+')
    if (sig !== lastSig || onset) {
      lastSig = sig
      log('held:', held.join(' '), onset ? '(onset)' : '', '| candidates:',
        debugActive.map((a) => `${a.name}${a.expected ? '*' : ''}(rel=${a.rel},snr=${a.snr})`).join(' '))
      onNotes(held, { onset })
    }
  }

  const intervalId = setInterval(tick, engine.cfg.analysisIntervalMs)
  log('detection started — frame', FRAME, 'fft', engine.fftN, 'interval', engine.cfg.analysisIntervalMs, 'ms')

  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(intervalId)
      processor.disconnect()
      hp.disconnect()
      source.disconnect()
      sink.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      audioCtx.close()
      log('stopped')
    },
    setExpected: (m, opts) => engine.setExpected(m, opts),
    engine,
  }
}

/** API parity with the old loader — the predictive detector needs no model. */
export async function loadPredictiveDetector() {}
export function isPredictiveReady() { return true }
