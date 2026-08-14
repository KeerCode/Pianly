# Pianly

A free, open-source piano practice app. Upload any MusicXML or MIDI file and Pianly guides you through each note in real time — using your microphone or MIDI keyboard.

No paywall. No account. Just play.

## Features

- Sheet music rendering with note-by-note guidance
- Chord support — all notes must be held before advancing
- Wrong note hints — after 3 wrong attempts, plays the target note
- Any-octave mode, auto-scroll, progress bar, listen mode, and speed control
- Falling-notes visualizer (Synthesia-style) with Watch and Practice modes
- MIDI keyboard and microphone input
- Built-in library of 400+ classical scores — works offline

## Coming Soon

Building a custom ML model for microphone-only note detection — better accuracy, lower latency, fewer false notes.

## Download

Go to the [Releases](https://github.com/KeerCode/Pianly-1.0.0/releases) page:

| Platform | File |
|---|---|
| **macOS (Apple Silicon)** | `.dmg` (arm64) |
| **macOS (Intel)** | `.dmg` (x64) |
| **Windows** | `.msi` or `.exe` |

> **macOS:** Not notarized — right-click the app, select **Open**, then click **Open** again. One-time only.

## Finding Sheet Music

- [IMSLP](https://imslp.org) — Public domain scores
- [MuseScore](https://musescore.com) — Community scores (export requires subscription)

## Credits

- [OpenScore Lieder](https://github.com/OpenScore/Lieder) — 389 bundled vocal scores (CC0)
- [musetrainer/library](https://github.com/musetrainer/library) — Solo piano scores
- [Verovio](https://www.verovio.org) — Sheet music rendering
- [Web Audio API / basic-pitch](https://github.com/spotify/basic-pitch-ts) — Microphone note detection
- [Tauri](https://tauri.app) — Desktop app framework

## License

MIT
