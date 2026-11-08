/**
 * Sheet Practice: when is a step played, and what to do with notes played early.
 * Pure, so the page and tools/paceSim.mjs run the same code. Used for MIDI and
 * for the mic (whose detections arrive as note-ons when a note first appears).
 *
 * The rule:
 *  - A step is complete once every one of its notes has been PRESSED at least
 *    once. Holding is not required (a quick tap counts) and a chord does not
 *    have to be pressed all at once.
 *  - A note that is in neither this step nor the next is a wrong note: the step's
 *    progress resets and its notes have to be played again.
 *  - A note of the NEXT step pressed before this one is complete, or while the
 *    page waits out this step's written time, is remembered as played early and
 *    counts as soon as the cursor gets there.
 *  - Holding a key never counts as playing it again; only presses do.
 *
 * The page decides timing: after `press` reports 'complete' it waits for the
 * step's written time (see App.jsx startStepWait), feeding presses in through
 * `pressDuringWait`, then calls `advance` and moves the cursor.
 */
export class StepGate {
  /** @param {(played:string, target:string, anyOctave:boolean)=>boolean} match */
  constructor(match) {
    this.match = match
    this.reset()
  }

  /** Forget everything (practice start/stop, manual navigation). */
  reset() {
    this.cur = new Set()       // target notes of the current step already played
    this.early = new Set()     // target notes of the next step already played
    this.curDoneAt = null      // when `cur` was completed by early presses
    this.earlyDoneAt = null    // when `early` covered the whole next step
  }

  /**
   * A key press while the current step is still being played.
   * @param {string} name                    note played
   * @param {string[]} target                current step's notes
   * @param {string[]|null|undefined} next   next step's notes
   * @param {boolean} anyOctave
   * @param {number} now                     ms clock
   * @returns {'complete'|'building'|'early'|'wrong'}
   */
  press(name, target, next, anyOctave, now) {
    const hit = target.filter((tn) => this.match(name, tn, anyOctave))
    if (hit.length) {
      for (const tn of hit) this.cur.add(tn)
      return target.every((tn) => this.cur.has(tn)) ? 'complete' : 'building'
    }
    if (this._early(name, next, anyOctave, now)) return 'early'
    // A wrong note: this step has to be played again.
    this.cur.clear()
    return 'wrong'
  }

  /**
   * A key press while the page is waiting out a completed step's time: only
   * notes of the next step matter (they count when the cursor arrives).
   * @returns {'early'|'ignored'}
   */
  pressDuringWait(name, next, anyOctave, now) {
    return this._early(name, next, anyOctave, now) ? 'early' : 'ignored'
  }

  /** The cursor moved to the next step: notes played early for it now count. */
  advance() {
    this.cur = this.early
    this.curDoneAt = this.earlyDoneAt
    this.early = new Set()
    this.earlyDoneAt = null
  }

  /**
   * Is the current step already complete (from notes played early)?
   * @returns {{complete: boolean, at: number|null}}  `at` = when it was completed
   */
  check(target) {
    const complete = target.length > 0 && target.every((tn) => this.cur.has(tn))
    return { complete, at: complete ? this.curDoneAt ?? null : null }
  }

  _early(name, next, anyOctave, now) {
    if (!next || next.length === 0) return false
    const hit = next.filter((tn) => this.match(name, tn, anyOctave))
    if (!hit.length) return false
    for (const tn of hit) this.early.add(tn)
    if (this.earlyDoneAt === null && next.every((tn) => this.early.has(tn))) this.earlyDoneAt = now
    return true
  }
}
