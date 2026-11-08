/**
 * Visualizer practice-mode gate: "has the player played what is on the keys
 * right now?" — as a pure state machine so it can be simulated and tested away
 * from the canvas draw loop.
 *
 * Rules (each one answers a real failure of the previous inline logic):
 *
 *  1. A required note needs a FRESH key press. Holding a key down from earlier
 *     must not satisfy a later note of the same pitch (repeated notes, or a
 *     note held past its end). `pressed` collects note-ons since the last time
 *     that pitch was consumed by a confirmed group.
 *
 *  2. Keys the score still has sounding are not "extras". A left-hand half note
 *     held while the right hand moves on must not be reported as a wrong key
 *     (it used to pause the song with "play only this note"). A key counts as
 *     sounding from its landing until its notated end plus `releaseGraceSec`
 *     (people lift a beat late); after that, still holding it IS a stray key.
 *     A key for a note landing within `earlyWindowSec` is early, not stray.
 *
 *  3. The clock does not run away from an unplayed group, and does not stall on
 *     human timing noise. A note played within `lateGraceSec` of its bar
 *     landing costs nothing: the song keeps flowing, so a few ms of jitter per
 *     note cannot accumulate (measured on Maple Leaf Rag: stopping the clock
 *     the instant a bar landed made the song 18-31% slow; ~800 stalls of a few
 *     ms each, none of them ever made up). Past the grace the clock stops at a
 *     fixed point just after the landing and the caller pins the asked-for bars
 *     to the keys, so what the game waits for is exactly what is on the keys
 *     (it used to wait for bars that had scrolled out of sight). A genuinely
 *     late player then shifts the rest of the song by how late they were
 *     beyond the grace (wait mode); they are not left behind.
 */

export const GATE_DEFAULTS = {
  windowTicks: 15,       // entries this close together are one chord
  releaseGraceSec: 0.35, // a finished note may be held this much longer without counting as a stray key
  earlyWindowSec: 0.3,   // a key for a note landing within this long is "early", not a stray key.
                         // Must exceed lateGraceSec + a normal anticipation (~0.15 s): when the
                         // page sends the sheet back to a missed note, keys already pressed for
                         // the following notes would otherwise suddenly look like stray keys.
  waitUiMs: 0,           // extra debounce before showing "Waiting for…" (the grace already delays it)
  lateGraceSec: 0.12,    // how late past its landing a note may be played before the song waits
  simulWindowMs: 250,    // a chord's keys need not be down at the same instant: one pressed
                         // and let go this recently (a short note, or an early one) still counts
}

export class PracticeSession {
  constructor(opts = {}) {
    this.o = { ...GATE_DEFAULTS, ...opts }
    this.held = new Set()      // MIDI keys currently down
    this.pressed = new Map()   // key -> presses not yet used to confirm a note (counted: two quick
                               // presses of one key are two notes, not one)
    this.confirmedTick = -1    // every entry at or before this tick is done
    this.offAt = new Map()     // key -> wall ms it was last let go
    this.blockedSinceMs = null // when the current group first failed to be satisfied
    this.waitingShown = false
    this._nowMs = 0
  }

  reset() {
    this.held.clear()
    this.pressed.clear()
    this.offAt.clear()
    this.confirmedTick = -1
    this.blockedSinceMs = null
    this.waitingShown = false
  }

  /** Forget all key state (device change, mode toggle) without losing progress. */
  clearKeys() { this.held.clear(); this.pressed.clear(); this.offAt.clear() }

  noteOn(midi) {
    this.held.add(midi)
    this.offAt.delete(midi)
    this.pressed.set(midi, Math.min(4, (this.pressed.get(midi) || 0) + 1))
  }
  /** @param {number} midi  @param {number} [atMs]  wall ms (defaults to the last step's clock) */
  noteOff(midi, atMs) {
    if (this.held.delete(midi)) this.offAt.set(midi, atMs ?? this._nowMs)
  }

  /**
   * One frame of practice logic.
   *
   * @param {object} a
   * @param {{tick:number, duration:number, durationSec?:number, notes:string[]}[]} a.timeline  sorted by tick
   * @param {number} a.nowSec            current song position
   * @param {(e:object)=>number} a.startSec  landing time of an entry, same scale as nowSec
   * @param {(e:object)=>number} a.endSec    notated end time of an entry
   * @param {(name:string)=>number|null} a.noteMidi
   * @param {number} a.nowMs             wall clock, for the stall debounce only
   * @returns {{
   *   required: Set<number>,         notes asked for right now (empty = nothing due)
   *   groupTick: number|null,
   *   landSec: number|null,          when the bars of this group touch the keys
   *   holdAt: number|null,           where the clock stops if the group is still unplayed
   *   overdue: boolean,              the grace is used up: stop the clock at holdAt
   *   state: 'idle'|'satisfied'|'building'|'blocked',
   *   confirmed: boolean,            this frame confirmed the group
   *   missing: number[], extras: number[],
   *   showWaiting: boolean,          stalled long enough to tell the user
   * }}
   */
  step({ timeline, nowSec, startSec, endSec, noteMidi, nowMs }) {
    const { windowTicks, releaseGraceSec, earlyWindowSec, waitUiMs, lateGraceSec, simulWindowMs } = this.o
    this._nowMs = nowMs
    const required = new Set()
    const out = {
      required, groupTick: null, landSec: null, holdAt: null, overdue: false, state: 'idle', confirmed: false,
      missing: [], extras: [], showWaiting: false,
    }
    if (!timeline || timeline.length === 0) return this._idle(out)

    // First unconfirmed entry whose landing has been reached (timeline is sorted
    // by tick, so the first match is the earliest).
    let first = null
    for (let i = 0; i < timeline.length; i++) {
      const e = timeline[i]
      if (e.tick <= this.confirmedTick) continue
      if (startSec(e) <= nowSec) first = e
      break
    }
    if (first === null) return this._idle(out)

    out.groupTick = first.tick
    out.landSec = startSec(first)
    out.holdAt = out.landSec + lateGraceSec
    for (let i = 0; i < timeline.length; i++) {
      const e = timeline[i]
      if (e.tick < first.tick - 5) continue
      if (e.tick > first.tick + windowTicks) break
      // No landing test here: entries inside the chord window are one chord by
      // definition (they land <10 ms apart) and confirming the group marks them
      // all done, so they have to be asked for together.
      for (const n of e.notes) {
        const m = noteMidi(n)
        if (m != null) required.add(m)
      }
    }
    if (required.size === 0) return this._idle(out)

    // Keys the score itself accounts for: still sounding (landed, not yet past
    // end + grace) or about to land (a slightly early press is not a stray key).
    const sounding = new Set()
    for (let i = 0; i < timeline.length; i++) {
      const e = timeline[i]
      if (startSec(e) > nowSec + earlyWindowSec) break
      if (endSec(e) + releaseGraceSec < nowSec) continue
      for (const n of e.notes) {
        const m = noteMidi(n)
        if (m != null) sounding.add(m)
      }
    }

    const missing = []
    // Played = pressed since last used AND either still down or only just let go
    // (a short or early note can be gone before its chord partner arrives).
    const fresh = (m) => (this.pressed.get(m) || 0) > 0
      && (this.held.has(m) || (this.offAt.has(m) && nowMs - this.offAt.get(m) <= simulWindowMs))
    for (const m of required) if (!fresh(m)) missing.push(m)
    const extras = []
    for (const m of this.held) if (!required.has(m) && !sounding.has(m)) extras.push(m)
    out.missing = missing
    out.extras = extras

    if (missing.length === 0 && extras.length === 0) {
      // Confirm: consume exactly the presses that satisfied this group, so a key
      // that is merely still held cannot satisfy the next one.
      this.confirmedTick = first.tick + windowTicks
      for (const m of required) {
        const c = this.pressed.get(m) || 0
        if (c <= 1) this.pressed.delete(m)
        else this.pressed.set(m, c - 1)
      }
      this.blockedSinceMs = null
      this.waitingShown = false
      out.state = 'satisfied'
      out.confirmed = true
      return out
    }

    out.state = extras.length === 0 && [...required].some(fresh) ? 'building' : 'blocked'
    // Within the grace the song just keeps flowing — nothing to wait for yet.
    out.overdue = nowSec >= out.holdAt
    if (!out.overdue) {
      this.blockedSinceMs = null
      this.waitingShown = false
      return out
    }
    if (this.blockedSinceMs === null) this.blockedSinceMs = nowMs
    out.showWaiting = nowMs - this.blockedSinceMs >= waitUiMs
    this.waitingShown = out.showWaiting
    return out
  }

  _idle(out) {
    this.blockedSinceMs = null
    this.waitingShown = false
    return out
  }
}
