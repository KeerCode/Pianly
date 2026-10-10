/**
 * "Takes": the last N seconds of what the mic heard, plus what the engine was
 * told to expect and what it reported, so a miss or a false advance can be
 * replayed offline through the exact same engine (tools/replayTake.mjs) and
 * tuned against the user's real piano, mic and room.
 *
 * Pure (no DOM, no Node-only APIs): `startPredictiveDetection` feeds it from the
 * live loop and the tests feed it synthetic audio. Nothing is retained beyond
 * the ring and is only ever written out when the user presses "Save take".
 *
 * Audio is the signal the engine saw (already through the browser's 30 Hz
 * high-pass), so replay must not filter it again — `meta.highpassApplied`.
 */

export const TAKE_VERSION = 1
export const DEFAULT_TAKE_SECONDS = 30

export class TakeRecorder {
  /** @param {number} sampleRate @param {number} [seconds] */
  constructor(sampleRate, seconds = DEFAULT_TAKE_SECONDS) {
    this.sampleRate = sampleRate
    this.capacity = Math.max(1, Math.round(sampleRate * seconds))
    this.ring = new Float32Array(this.capacity)
    this.total = 0          // samples ever written (monotonic)
    this.expected = []      // { t (s, audio clock), midis, mono, anyOctave }
    this.detections = []    // { t, held: midi[], onset, rms }
  }

  /** Current audio clock, seconds. */
  now() { return this.total / this.sampleRate }

  pushAudio(chunk) {
    const n = chunk.length
    const cap = this.capacity
    if (n >= cap) {
      // Only the newest `cap` samples survive; each still has to land at
      // (absolute index % cap) so snapshot() can read the ring in order.
      const tail = chunk.subarray(n - cap)
      const at = (this.total + n - cap) % cap
      this.ring.set(tail.subarray(0, cap - at), at)
      if (at > 0) this.ring.set(tail.subarray(cap - at), 0)
      this.total += n
      return
    }
    let w = this.total % cap
    const first = Math.min(n, cap - w)
    this.ring.set(chunk.subarray(0, first), w)
    if (first < n) this.ring.set(chunk.subarray(first), 0)
    this.total += n
  }

  logExpected(midis, opts = {}) {
    this.expected.push({ t: this.now(), midis: [...midis], mono: !!opts.mono, anyOctave: !!opts.anyOctave })
    this._prune()
  }

  logTick({ held, onset, rms }) {
    this.detections.push({ t: this.now(), held: [...held], onset: !!onset, rms: Math.round(rms * 1e5) / 1e5 })
    this._prune()
  }

  _windowStart() { return Math.max(0, this.total - this.capacity) / this.sampleRate }

  _prune() {
    const t0 = this._windowStart() - 1 // small slack so snapshot can carry state
    while (this.detections.length && this.detections[0].t < t0) this.detections.shift()
    // keep ONE expected event older than the window: it is the state at window start
    while (this.expected.length > 1 && this.expected[1].t <= t0) this.expected.shift()
  }

  /**
   * Chronological copy of everything still in the window.
   * @param {object} [meta]  free-form (config diff, calibration, page context…)
   */
  snapshot(meta = {}) {
    const have = Math.min(this.total, this.capacity)
    const audio = new Float32Array(have)
    const start = this.total - have
    const w = start % this.capacity
    const first = Math.min(have, this.capacity - w)
    audio.set(this.ring.subarray(w, w + first), 0)
    if (first < have) audio.set(this.ring.subarray(0, have - first), first)

    const t0 = start / this.sampleRate
    const exp = this.expected
      .map((e) => ({ ...e, t: Math.max(0, e.t - t0) }))
      .filter((e, i, a) => !(i < a.length - 1 && e.t === 0 && a[i + 1].t === 0)) // collapse stacked state-at-start
    return {
      version: TAKE_VERSION,
      sampleRate: this.sampleRate,
      duration: have / this.sampleRate,
      audio,
      expected: exp,
      detections: this.detections.filter((d) => d.t >= t0).map((d) => ({ ...d, t: d.t - t0 })),
      meta: { highpassApplied: true, ...meta },
    }
  }
}

// ---------------------------------------------------------------------------
// Serialisation: one self-contained JSON file (audio as 16-bit PCM base64).
// ---------------------------------------------------------------------------

function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(b64) {
  if (typeof Buffer !== 'undefined') { const b = Buffer.from(b64, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength) }
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function encodeTake(take) {
  const pcm = new Int16Array(take.audio.length)
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, take.audio[i]))
    pcm[i] = Math.round(v * 32767)
  }
  const { audio: _audio, ...rest } = take
  return JSON.stringify({ ...rest, audioFormat: 'pcm16le-base64', audioB64: toBase64(new Uint8Array(pcm.buffer)) })
}

export function decodeTake(text) {
  const o = typeof text === 'string' ? JSON.parse(text) : text
  if (!o || o.version !== TAKE_VERSION || !o.audioB64) throw new Error('Not a Pianly take file (or an unsupported version).')
  const bytes = fromBase64(o.audioB64)
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1)
  const audio = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / 32767
  const { audioB64: _b, audioFormat: _f, ...rest } = o
  return { ...rest, audio }
}

/** Fields of `cfg` that differ from `defaults` — what a take needs to replay faithfully. */
export function configDiff(cfg, defaults) {
  const out = {}
  for (const k of Object.keys(cfg)) if (cfg[k] !== defaults[k]) out[k] = cfg[k]
  return out
}

export function takeFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `pianly-take-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.json`
}
