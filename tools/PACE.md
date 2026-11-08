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

## Sheet Practice

The rule (`src/practice/stepGate.js`, `App.jsx`), for MIDI and the mic alike:

* A step is complete once every one of its notes has been **pressed at least
  once**. Holding is not required and a chord does not have to go down at once.
* The cursor then stays on the step for its **written time** (the time to the
  next step at the current BPM), counted from the moment it was completed, and
  moves on by itself. Letting go early changes nothing. Rests are included.
* Notes of the **next** step played during that wait count as soon as the cursor
  arrives, and that step's own time is counted from when they were played, so a
  player at tempo is never held back or left behind.
* A note in neither this step nor the next is a wrong note: the step's progress
  resets and the hint logic counts it. Holding a key never counts as playing it
  again. Pause freezes the wait; restart and manual navigation cancel it.
* Mic (Basic Pitch): a note counts as pressed when it first appears in the
  detector's output; a note that is still ringing is not pressed again.

| Maple Leaf Rag, player at the written tempo | before (released-keys rule) | now |
|---|---|---|
| steps advanced (simulated, 1026) | 4, 2,563 wrong-note flags | 1026, none |
| real page, real time (first 45 s, 260 steps) | | all 260; cursor reaches each step 25 ms (median) after the player starts it, 73 ms worst |
| a step left before its written time | | never (shortest: exactly the written time) |

Also fixed on the way: two overlapping MIDI connects left the first listener
registered, so every note arrived twice (`listenToDevice` now serialises).

## Visualizer (wait mode)

| | before | now |
|---|---|---|
| song length played at the written tempo (177.3 s piece, six simulated players) | 209-233 s (18-31% slow) with the first stop-the-clock fix | 179-182 s (**1.1-2.8% slow**) |
| an ideal player interrupted | 26-44 times per piece | 0 |

* A note played within `lateGraceSec` (0.12 s) of its landing costs nothing: the
  song keeps flowing, so a few ms of timing noise per note can't add up.
* Later than that, the song stops and the **whole sheet eases back** (~160 ms)
  to the moment the missed notes touched the keys, then waits there until they
  are played. (Earlier versions froze 0.12 s past the landing and pushed only
  the missed bars back up.) Each such stop costs the grace plus the lateness,
  which is the 1-3% above.
* Keys already pressed for notes landing within `earlyWindowSec` (0.3 s) are early
  presses, not stray keys; this has to cover the rewind distance, or keys pressed
  for the next chord would turn into "Let go of" the moment the sheet went back.
* **Speed** changes how fast the bars fall, not their length: the song position
  is kept in score time and advances at `speed` per second; one second of score
  is always 200 px. Changing speed mid-song keeps the position (no jump).
  Measured on the page: 216 / 102 / 396 px/s at 1x / 0.5x / 2x, bar length
  48.5 px at all three. Timing allowances (grace, early window) are in score
  time, so they are a little more forgiving at slow speeds.

## Limits

* The simulated players are models. A real person's timing distribution, MIDI
  keyboard latency and pedalling are not measured here.
* `lateGraceSec` trades responsiveness for pace: bigger = fewer waits, but a
  note can be that much later before the song stops and bars scroll that far
  past (24 px at 0.12 s) first.
* Sheet Practice does not judge rhythm: playing the next note early is accepted
  (each note still gets its written time from when it was played).
* Mic input (Basic Pitch) is not simulated here; these numbers are for MIDI.
