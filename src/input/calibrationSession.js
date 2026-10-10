/**
 * The mic-setup wizard's brain, as a plain state machine so it can be driven
 * from React (MicSetup.jsx) or, identically, offline from recorded audio
 * (tools/calibrationTest.mjs).
 *
 * Flow: [room tone, 2 s of quiet] -> for each requested note:
 *   release (let the last note stop)  ->  listen (wait for THIS note)  ->
 *   capture (record the strike's partial/decay curve)  ->  ok
 * A wrong note never gets recorded: the wizard says what it heard instead and
 * keeps listening for the right one. A note that is too short / too quiet /
 * an octave off is rejected with a reason and re-armed.
 *
 * Feed it one tick at a time:   session.feed({ t, rms, silent, heldMidi })
 * AFTER `engine.process()` for that tick. It reads the engine's spectrum
 * (through StrikeRecorder) and drives `engine.setExpected / watchAttack`.
 */
import { StrikeRecorder, supportsNote, fundamentalAmp, noteLabel } from './micCalibration.js'

export const noteName = noteLabel

const ROOM_SECONDS = 2.0
const ROOM_MAX_RMS = 0.04       // louder than this isn't "a quiet room"
const RELEASE_QUIET_SECONDS = 0.3
const CAPTURE_TRIM_TICKS = 3    // frames dropped from the tail: damper ramp-down
const MAX_STRIKE_AGE = 0.35     // a held target counts as THIS strike only if fresh
const WRONG_NOTE_SECONDS = 0.15 // persistence before "I heard X" is shown
const OK_FLASH_SECONDS = 0.7
const UNLOCKABLE_SECONDS = 1.6    // struck, but never recognised as the asked note

export class CalibrationSession {
  /**
   * @param {object} o
   * @param {import('./predictiveDetector.js').PitchEngine} o.engine
   * @param {number[]} o.midis       notes to calibrate, in order
   * @param {boolean} [o.room=true]  measure room tone first
   * @param {(entry: object) => void} [o.onEntry]   a note was captured
   * @param {(roomRms: number) => void} [o.onRoom]  room tone measured
   * @param {() => void} [o.onChange]               view changed (re-render)
   */
  constructor({ engine, midis, room = true, onEntry, onRoom, onChange }) {
    this.engine = engine
    this.midis = [...midis]
    this.onEntry = onEntry
    this.onRoom = onRoom
    this.onChange = onChange
    this.index = 0
    this.done = new Map()     // midi -> entry
    this.skipped = new Set()
    this.roomRms = null
    this.phase = room ? 'room' : 'release'
    this.message = room ? 'Stay quiet for a moment — measuring the room…' : ''
    this.tone = 'info'
    this.heard = []
    this._roomT0 = null
    this._roomRms = []
    this._quietSince = null
    this._wrongSince = null
    this._okUntil = 0
    this._listenSince = -Infinity
    this._unlockSince = null
    this._rec = null
    this._pending = []
    this._lostTicks = 0
    if (this.phase !== 'room') this._arm()
  }

  get target() { return this.midis[this.index] ?? null }
  get finished() { return this.phase === 'finished' }
  get progress() { return this.midis.length ? this.done.size / this.midis.length : 1 }

  get view() {
    return {
      phase: this.phase,
      index: this.index,
      total: this.midis.length,
      midi: this.target,
      name: this.target != null ? noteName(this.target) : null,
      message: this.message,
      tone: this.tone,
      heard: this.heard,
      roomRms: this.roomRms,
      done: [...this.done.keys()],
      skipped: [...this.skipped],
      progress: this.progress,
    }
  }

  // ---- controls ---------------------------------------------------------
  skip() {
    if (this.target == null) return
    this.skipped.add(this.target)
    this._next()
  }

  /** Re-record the previous note. */
  back() {
    if (this.index <= 0) return
    this.index--
    const m = this.target
    this.done.delete(m)
    this.skipped.delete(m)
    this._arm()
  }

  /** Throw away the note being captured and listen again. */
  retry() { this._arm() }

  // ---- internals --------------------------------------------------------
  _set(message, tone = 'info') {
    if (message === this.message && tone === this.tone) return
    this.message = message
    this.tone = tone
    this.onChange?.()
  }

  _arm() {
    const m = this.target
    this.heard = []
    this._rec = null
    this._pending = []
    this._lostTicks = 0
    this._quietSince = null
    this._wrongSince = null
    if (m == null) { this._finish(); return }
    this.engine.setExpected([m], { mono: false })
    this.engine.watchAttack(m)
    this.phase = 'release'
    this._set(`Play ${noteName(m)}`, 'info')
    this.onChange?.()
  }

  _next() {
    const m = this.target
    if (m != null) this.engine.unwatchAttack(m)
    this.index++
    this._arm()
  }

  _finish() {
    this.phase = 'finished'
    this.engine.setExpected([], {})
    const got = this.done.size
    this._set(got === this.midis.length ? 'All set — calibration saved.' : `Saved ${got} of ${this.midis.length} notes.`, 'ok')
    this.onChange?.()
  }

  /** One engine tick. Returns the (possibly updated) view. */
  feed({ t, rms, silent, heldMidi }) {
    this._now = t
    if (this.phase === 'finished') return this.view

    if (this.phase === 'room') {
      if (this._roomT0 == null) this._roomT0 = t
      this._roomRms.push(rms)
      if (t - this._roomT0 >= ROOM_SECONDS) {
        const s = [...this._roomRms].sort((a, b) => a - b)
        const med = s[s.length >> 1]
        if (med > ROOM_MAX_RMS) {
          this._roomT0 = null
          this._roomRms = []
          this._set('It is too loud in here — quiet the room and I will measure again.', 'warn')
        } else {
          this.roomRms = med
          this.onRoom?.(med)
          this._arm()
        }
      }
      return this.view
    }

    const m = this.target
    if (m == null) { this._finish(); return this.view }
    const held = heldMidi || []
    const has = held.includes(m)

    if (this.phase === 'ok') {
      if (t >= this._okUntil) this._next()
      return this.view
    }

    if (this.phase === 'release') {
      // Let whatever was ringing stop before arming, so its tail can't be
      // mistaken for (or mixed into) this note.
      const quiet = silent || held.length === 0
      if (quiet) {
        if (this._quietSince == null) this._quietSince = t
        if (t - this._quietSince >= RELEASE_QUIET_SECONDS) {
          this.phase = 'listen'
          this._listenSince = t
          this._unlockSince = null
          this._quietSince = null
          this._set(`Play ${noteName(m)}`, 'info')
        }
      } else {
        this._quietSince = null
        if (this.index > 0 || this.done.size > 0) this._set('Let the key go…', 'info')
      }
      return this.view
    }

    if (this.phase === 'listen') {
      // `has` alone isn't proof (the expected-note prior is lenient): demand
      // real spectral evidence of THIS pitch, else it's just some other key.
      const real = has && supportsNote(this.engine, m)
      // Name the real wrong note. The engine also reports sub-bass phantoms (a
      // note's own 5th/6th partial lining up with a low candidate), sometimes
      // scored HIGHER than the key actually pressed, so: keep only candidates
      // with genuine spectral evidence, take the one with the strongest
      // fundamental, then step down any octave chain (its own 2nd partial can
      // outweigh the fundamental) to the real lowest note.
      let others = real ? [] : held.filter((x) => x !== m && supportsNote(this.engine, x))
      if (others.length > 1) {
        let best = others.reduce((b, x) => (fundamentalAmp(this.engine, x) > fundamentalAmp(this.engine, b) ? x : b))
        while (others.includes(best - 12)) best -= 12
        others = [best]
      }
      this.heard = real ? held : others
      const age = this.engine.attackAge(m)
      if (real && age != null && age <= MAX_STRIKE_AGE) {
        this.phase = 'capture'
        this._rec = new StrikeRecorder(m, { binHz: this.engine.binHz, bins: this.engine.bins })
        this._pending = []
        this._lostTicks = 0
        this._wrongSince = null
        this._set(`Got ${noteName(m)} — keep holding…`, 'ok')
      } else if (others.length > 0 || (has && !real && !silent && held.some((x) => x !== m))) {
        if (this._wrongSince == null) this._wrongSince = t
        if (t - this._wrongSince >= WRONG_NOTE_SECONDS) {
          this._set(
            others.length ? `I heard ${others.map(noteName).join(' + ')} — play ${noteName(m)}` : `That is not ${noteName(m)} — play ${noteName(m)}`,
            'warn',
          )
        }
      } else {
        this._wrongSince = null
        if (this.tone === 'warn') this._set(`Play ${noteName(m)}`, 'info')
      }
      // Something was struck, yet this note was never recognised: very low keys
      // can have a fundamental the mic simply can't pick out. Say so rather than
      // sit on "Play F0" forever.
      if (this.phase === 'listen') {
        const struck = this.engine.lastOnsetAt > this._listenSince && !silent
        if (struck && this._unlockSince == null) this._unlockSince = t
        if (!struck && silent) this._unlockSince = null
        if (this._unlockSince != null && t - this._unlockSince >= UNLOCKABLE_SECONDS && this.tone !== 'warn') {
          this._set(`I can't pick out ${noteName(m)} on this mic — it may be too low or faint. Skip it; it will use the standard detector.`, 'warn')
        }
      }
      return this.view
    }

    if (this.phase === 'capture') {
      this.heard = held
      const age = this.engine.attackAge(m)
      if (has) {
        this._lostTicks = 0
        const fr = this._rec.capture(this.engine, age, rms)
        if (fr) this._pending.push(fr)
        // Commit all but the newest few: the tail is released-key ramp-down.
        while (this._pending.length > CAPTURE_TRIM_TICKS) this._rec.push(this._pending.shift())
        if (this._rec.ready) this._complete()
      } else {
        this._lostTicks++
        if (this._lostTicks >= 2 || silent) this._complete()
      }
      return this.view
    }

    return this.view
  }

  _complete() {
    const m = this.target
    const res = this._rec.finish()
    this._rec = null
    this._pending = []
    if (res.entry) {
      this.done.set(m, res.entry)
      this.onEntry?.(res.entry)
      this.phase = 'ok'
      this._okUntil = (this._now ?? 0) + OK_FLASH_SECONDS
      this._set(`${noteName(m)} ✓`, 'ok')
    } else {
      this.phase = 'release'
      this._quietSince = null
      this._set(`${res.error} Play ${noteName(m)} again.`, 'warn')
    }
    this.onChange?.()
  }
}
