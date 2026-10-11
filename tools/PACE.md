# Practice pace: does it keep up with a person playing at the written tempo?

`tools/paceSim.mjs` plays a piece the way a person does (tempo wobble, per-note
jitter, hands a few ms apart, notes lifted a little before their written end, the
odd hesitation) and feeds the events to each practice mode's real logic.

```bash
npm run test:pace       # synthetic ragtime patterns + demo-score excerpts (no samples, no DOM)
npm run test:practice   # the Visualizer gate: old logic vs new on the demo scores
```

The full-piece numbers below come from running the simulator in the browser
against the real parsers, and then driving the real pages in real time with
injected MIDI (Tauri's event bridge stubbed). Maple Leaf Rag: 177.3 s, 1,026
steps in Sheet Practice, 1,372 in the Visualizer.

## Sheet Practice (MIDI)

| | before | after |
|---|---|---|
| steps advanced (player at the written tempo) | **4 of 1026**, 2,563 wrong-note flags | **1026 of 1026**, 0 flags |
| lag behind the key press (median / worst) | 27 s / never | 13 ms / 59 ms |
| a very sloppy player (hands 45 ms apart, 30 ms jitter, 4% hesitations) | wedged | 1026 of 1026, 34 ms median |
| real page, real time | | finished in 177.7 s, never more than one step behind, no hints |

What was wrong (`src/practice/midiStepGate.js`, `App.jsx`):

* A step only completed once **every key was released**. Piano music overlaps, so
  the held set almost never emptied and the song wedged after a few notes.
* Any key still down that was not in the current step was a **wrong note**, so a
  held bass note was wrong all the time.
* A 150 ms cooldown after each advance **dropped** the next note-on when it
  arrived inside it (a sixteenth at 100 bpm is exactly 150 ms).
* After a step containing a tied note, `doAdvance` **skipped the next step**. It
  assumed tie continuations were separate steps, but the OSMD parser drops them,
  so the skipped step was a real chord (the player was asked for notes later
  than the cursor showed).
* A short note released before the rest of its chord arrived was never seen.

Now a step completes the moment its notes are down; keys held at that moment are
"old" until let go (not wrong, and cannot satisfy a later step by being held); a
key of the *next* step pressed slightly early is early, not wrong; a key released
within 250 ms still counts toward a chord; letting go of a stray key re-checks.

## Visualizer (wait mode)

| | before | after |
|---|---|---|
| song length played at the written tempo (177.3 s piece) | 209-233 s (18-31% slow) with the first version of the stop-the-clock fix | 178-180 s (**0.5-1.5% slow**) |
| an ideal player interrupted | 26-44 times per piece | 0 |
| real page, real time | | 179.9 s for a 178.1 s song (1.0%), 11 clock stops, longest 272 ms |

The clock must not stop on human timing noise. Stopping it the instant a bar
landed made every note played a few ms late hold the song, and a note played
early never bought the time back (~800 stalls of a few ms, all cumulative). Now a
note within `lateGraceSec` (0.12 s) of its landing costs nothing; past that the
clock stops 0.12 s after the landing and the asked-for bars are pinned to the
keys. See `src/practice/practiceGate.js`.

## Limits

* The simulated players are models. A real person's timing distribution, MIDI
  keyboard latency and pedalling are not measured here.
* `lateGraceSec` trades responsiveness for pace: bigger = fewer waits, but a
  note can be that much later before the song stops and bars scroll that far
  past (24 px at 0.12 s) first.
* Sheet Practice has no clock, so a wrong key is still judged strictly: a key
  that was never part of an accepted step flags wrong until it is let go.
* Mic input is unchanged by this work (it already advanced on detection).
