/**
 * Sheet Practice, MIDI input: "has the player played the notes of the current
 * step?" — pure, so the real page and tools/paceSim.mjs run the same code.
 *
 * What the previous inline logic got wrong (measured by playing Maple Leaf Rag
 * through it at its written tempo: 4 of 1026 steps advanced, 2,563 wrong-note
 * flags):
 *
 *  - It advanced only once EVERY key had been released. Piano music overlaps
 *    constantly (the next note goes down before the last comes up), so the held
 *    set almost never emptied and the song wedged after a few notes.
 *  - Any key still down that was not in the current step counted as a wrong
 *    note, so a bass note held under the melody was "wrong" all the time.
 *  - A 150 ms cooldown after each advance silently dropped the next note-on
 *    when it arrived inside the window (a sixteenth note at 100 bpm is 150 ms).
 *
 * Here a step completes the moment its notes are down, and the keys held at
 * that moment become "old": they are ignored until they are let go, so they
 * can neither be wrong notes nor satisfy a later step by merely being held. A
 * note of the same pitch coming round again needs a fresh press, exactly as in
 * the Visualizer. A key that was never part of an accepted step is still a
 * wrong note.
 */
export class MidiStepGate {
  /**
   * @param {(played:string, target:string, anyOctave:boolean)=>boolean} match
   * @param {{simulWindowMs?: number}} [opts]
   */
  constructor(match, opts = {}) {
    this.match = match
    this.simulWindowMs = opts.simulWindowMs ?? 250
    this.held = new Set()   // note names currently down
    this.old = new Set()    // held keys that belong to steps already accepted
    this.recent = new Map() // note name -> ms it was let go, for keys pressed for the CURRENT step
    this._now = 0
  }

  clear() { this.held.clear(); this.old.clear(); this.recent.clear() }

  /** @param {string} name  @param {number} [nowMs] */
  noteOn(name, nowMs) {
    if (nowMs != null) this._now = nowMs
    this.held.add(name)
    this.old.delete(name)   // pressed again = a new press, whatever it was before
    this.recent.delete(name)
  }

  noteOff(name, nowMs) {
    if (nowMs != null) this._now = nowMs
    const wasOld = this.old.has(name)
    const wasDown = this.held.delete(name)
    this.old.delete(name)
    // A short note can be gone before the rest of its chord arrives (hands are
    // never exactly together): remember it briefly so the chord still counts.
    if (wasDown && !wasOld) this.recent.set(name, this._now)
  }

  /** Keys that count for the current step: held and not left over from an accepted one. */
  get live() { return [...this.held].filter((h) => !this.old.has(h)) }

  /**
   * @param {string[]} target  note names of the current step
   * @param {boolean} [anyOctave]
   * @param {string[]|null} [next]  the step after this one. Hands are never
   *   perfectly together, so a key of the NEXT step may go down before the
   *   current chord is finished (measured: hands 45 ms apart wedged the song).
   *   Such a key is early, not wrong; it does not count towards this step and
   *   stays live, so it is picked up the moment the song moves on.
   * @param {number} [nowMs]  clock for the just-released-key window
   * @returns {'idle'|'building'|'wrong'|'complete'}
   */
  evaluate(target, anyOctave = false, next = null, nowMs) {
    if (nowMs != null) this._now = nowMs
    const live = this.live
    if (live.length === 0 || !target || target.length === 0) return 'idle'
    const isTarget = (h) => target.some((tn) => this.match(h, tn, anyOctave))
    const isNext = (h) => !!next && next.some((tn) => this.match(h, tn, anyOctave))
    const recent = [...this.recent].filter(([, t]) => this._now - t <= this.simulWindowMs).map(([h]) => h)
    const all = target.every((tn) => live.some((h) => this.match(h, tn, anyOctave))
      || recent.some((h) => this.match(h, tn, anyOctave)))
    const noExtras = live.every((h) => isTarget(h) || isNext(h))
    if (all && noExtras) {
      // Accepted: the keys that played this step are old until let go. A key
      // that only belongs to the next step stays live.
      for (const h of this.held) if (isTarget(h)) this.old.add(h)
      this.recent.clear()
      return 'complete'
    }
    if (noExtras) return 'building'
    return 'wrong'
  }
}
