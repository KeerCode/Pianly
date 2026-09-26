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
  monoFramesOn: 1,        // consecutive frames above threshold before latching.
  monoFramesOff: 3,       // consecutive frames below threshold before release.

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
    this.monoActive = false  // true when `expected` is a single pitch class (any octave)
    this.state = new Map()   // midi -> { on, onCount, offCount }
    this.monoState = { midi: null, onCount: 0, offCount: 0 } // single-note (autocorrelation) path
    this.fluxMean = 0
    this.fluxVar = 1
    this.prevFluxNorm = 0
  }

  /**
   * @param {number[]} midis
   * @param {{mono?: boolean}} [opts]  Whether `midis` represents one musical
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
  }

  reset() {
    this.state.clear()
    this.monoState = { midi: null, onCount: 0, offCount: 0 }
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
  _monoPitch(frame) {
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

    const bestTau = foundTau > 0 ? foundTau : globalBestTau
    const bestCmndf = foundTau > 0 ? cmndf[bestTau] : globalBestCmndf
    const freq = this.sr / bestTau
    let bestMidi = cand[0].midi
    let bestDiff = Infinity
    for (const c of cand) {
      const diff = Math.abs(Math.log2(freq / c.f0))
      if (diff < bestDiff) { bestDiff = diff; bestMidi = c.midi }
    }
    return { midi: bestMidi, confidence: 1 - Math.min(1, bestCmndf), confident: foundTau > 0 }
  }

  /** Decision + hysteresis for the monophonic path. See `_monoPitch`. */
  _processMono(frame, rms, onset) {
    const cfg = this.cfg
    const est = this._monoPitch(frame)
    const ms = this.monoState

    if (est.confident) {
      ms.onCount = ms.midi === est.midi ? ms.onCount + 1 : 1
      ms.midi = est.midi
      ms.offCount = 0
    } else {
      ms.offCount++
      if (ms.offCount >= cfg.monoFramesOff) { ms.midi = null; ms.onCount = 0 }
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
  process(frame) {
    const cfg = this.cfg
    let rms = 0
    for (let i = 0; i < this.frame; i++) rms += frame[i] * frame[i]
    rms = Math.sqrt(rms / this.frame)

    this._spectrum(frame)

    // Mean bin magnitude BEFORE noise subtraction — the SNR gate references this
    // so its scale doesn't collapse once subtraction zeroes most of the frame.
    let rawMagMean = 0
    for (let i = 0; i < this.bins; i++) rawMagMean += this.mag[i]
    rawMagMean /= this.bins

    // Silence: release everything. Noise-floor tracking below still runs
    // (it's not gated on this) — a genuinely quiet frame just lets it fall
    // fastest, same mechanism as any other quiet moment.
    if (rms < cfg.rmsGate) {
      this._updateNoiseFloor(rms, true)
      for (const s of this.state.values()) { s.on = false; s.onCount = 0; s.offCount = 0 }
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

    // Exactly one expected note -> monophonic YIN path instead of the
    // spectral harmonic-comb scan (see monoCmndfThreshold comment above).
    if (this.monoActive) {
      return this._processMono(frame, rms, onset)
    }

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
      const canOn = rel >= tOn && snr >= snrOn && localMax && aboveNoise && supported

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
 * @param {(names: string[]|null) => void} opts.onNotes  current held-note names,
 *        or null on silence / all released.
 * @param {number[]} [opts.expected]  standard MIDI numbers the score expects now.
 * @param {boolean}  [opts.mono]      whether `expected` is one musical note
 *   (see `PitchEngine.setExpected` for why this can't be inferred from the
 *   MIDI numbers alone). Defaults to true only when `expected` has exactly
 *   one value.
 * @param {object}   [opts.config]    partial DEFAULT_CONFIG override.
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
export async function startPredictiveDetection({ onNotes, expected = [], mono, config = {}, debug = DEBUG, onDebug = null }) {
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

  const engine = new PitchEngine(SR, config)
  engine.setExpected(expected, { mono })
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

  const tick = () => {
    if (stopped || samplesIn < FRAME) return
    for (let i = 0; i < FRAME; i++) scratch[i] = ring[(writePos + i) % FRAME]
    const { silent, rms, heldMidi, held, onset, hasNoise, debugActive } = engine.process(scratch)

    if (hasNoise !== lastHasNoise) {
      lastHasNoise = hasNoise
      log(hasNoise ? 'noise profile learned — subtraction active' : 'noise profile lost (reset)')
    }
    onDebug?.({ rms, hasNoise, onset, active: debugActive ?? [] })

    if (silent || held.length === 0) {
      if (lastSig !== null) { lastSig = null; onNotes(null) }
      return
    }
    const sig = heldMidi.join('+')
    if (sig !== lastSig || onset) {
      lastSig = sig
      log('held:', held.join(' '), onset ? '(onset)' : '', '| candidates:',
        debugActive.map((a) => `${a.name}${a.expected ? '*' : ''}(rel=${a.rel},snr=${a.snr})`).join(' '))
      onNotes(held)
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
  }
}

/** API parity with the old loader — the predictive detector needs no model. */
export async function loadPredictiveDetector() {}
export function isPredictiveReady() { return true }
