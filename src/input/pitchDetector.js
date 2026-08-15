const DEBUG = import.meta.env.DEV

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** Convert MIDI note number to note name (middle C = C3) */
export function midiToNoteNamePitch(midi) {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 2
  return `${name}${octave}`
}

// ---------------------------------------------------------------------------
// Basic Pitch (ML-based, Spotify) — polyphonic note detection
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 22050 // Basic Pitch REQUIRES 22050Hz
const BUFFER_SECONDS = 0.5
const INFERENCE_INTERVAL_MS = 250
const ONSET_THRESHOLD = 0.5 // high = only clear note onsets pass
const FRAME_THRESHOLD = 0.4 // high = reject faint harmonics/noise
const MIN_NOTE_LEN = 5 // reject very brief phantom notes
const VOLUME_GATE = 0.01
const STABILITY_COUNT = 1
const MIN_AMPLITUDE = 0.3 // reject low-confidence note events

let basicPitchInstance = null
let basicPitchLoading = false
let basicPitchReady = false

/**
 * Load the Basic Pitch model once.
 */
export async function loadBasicPitchModel() {
  if (basicPitchReady) return
  if (basicPitchLoading) {
    while (!basicPitchReady) {
      await new Promise((r) => setTimeout(r, 100))
    }
    return
  }
  basicPitchLoading = true
  DEBUG && console.log('[BasicPitch] Loading model...')
  try {
    const { BasicPitch } = await import('@spotify/basic-pitch')
    basicPitchInstance = new BasicPitch(
      './basic-pitch-model/model.json'
    )
    await basicPitchInstance.model
    basicPitchReady = true
    DEBUG && console.log('[BasicPitch] Model loaded successfully')
  } catch (err) {
    console.error('[BasicPitch] Model failed to load:', err)
    basicPitchLoading = false
    throw err
  }
}

/** Check if the Basic Pitch model is loaded */
export function isBasicPitchReady() {
  return basicPitchReady
}

/**
 * Start real-time polyphonic pitch detection using Basic Pitch.
 * Calls onNotes(noteNames[]) with array of detected notes, or onNotes(null) on silence.
 * Returns a stop() function.
 */
export async function startBasicPitchDetection(onNotes) {
  if (!basicPitchReady) {
    await loadBasicPitchModel()
  }
  const { outputToNotesPoly, noteFramesToTime } =
    await import('@spotify/basic-pitch')
  // Request mic with specific constraints for best detection
  DEBUG && console.log('[BasicPitch] Requesting microphone access...')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  })
  DEBUG && console.log('[BasicPitch] Mic stream active:', stream.active)
  const tracks = stream.getAudioTracks()
  DEBUG && console.log('[BasicPitch] Audio tracks:', tracks.map((t) => `${t.label} (${t.readyState})`))
  if (tracks.length === 0 || tracks[0].readyState !== 'live') {
    console.error('[BasicPitch] No live audio track available!')
  }

  // AudioContext MUST be 22050Hz for Basic Pitch
  const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
  DEBUG && console.log('[BasicPitch] AudioContext state:', audioCtx.state, '| sampleRate:', audioCtx.sampleRate)

  // Resume AudioContext if suspended (autoplay policy)
  if (audioCtx.state === 'suspended') {
    DEBUG && console.log('[BasicPitch] AudioContext suspended, resuming...')
    await audioCtx.resume()
    DEBUG && console.log('[BasicPitch] AudioContext state after resume:', audioCtx.state)
  }

  // Check if the browser actually gave us the requested sample rate
  if (audioCtx.sampleRate !== SAMPLE_RATE) {
    console.warn('[BasicPitch] WARNING: Requested', SAMPLE_RATE, 'Hz but got', audioCtx.sampleRate, 'Hz — detection may be inaccurate')
  }

  const source = audioCtx.createMediaStreamSource(stream)

  // Rolling buffer to accumulate audio
  const bufferSize = Math.ceil(SAMPLE_RATE * BUFFER_SECONDS)
  const ringBuffer = new Float32Array(bufferSize)
  let writePos = 0
  let samplesWritten = 0

  const processor = audioCtx.createScriptProcessor(4096, 1, 1)
  source.connect(processor)
  processor.connect(audioCtx.destination)

  let processCallCount = 0
  processor.onaudioprocess = (e) => {
    processCallCount++
    const input = e.inputBuffer.getChannelData(0)

    // Log first few callbacks to confirm audio is flowing
    if (processCallCount <= 3) {
      let peak = 0
      for (let i = 0; i < input.length; i++) {
        const v = input[i] < 0 ? -input[i] : input[i]
        if (v > peak) peak = v
      }
      DEBUG && console.log(`[BasicPitch] onaudioprocess #${processCallCount}: ${input.length} samples, peak: ${peak.toFixed(4)}`)
    }

    for (let i = 0; i < input.length; i++) {
      ringBuffer[writePos] = input[i]
      writePos = (writePos + 1) % bufferSize
    }
    samplesWritten += input.length
  }

  let stopped = false
  let inferring = false
  let lastSig = null
  let sigCount = 0
  let inferenceCount = 0

  const intervalId = setInterval(async () => {
    if (stopped || inferring) return

    // Need at least one full buffer before running inference
    if (samplesWritten < bufferSize) {
      if (inferenceCount === 0 && samplesWritten > 0) {
        DEBUG && console.log(`[BasicPitch] Buffering... ${samplesWritten}/${bufferSize} samples (${(samplesWritten / SAMPLE_RATE).toFixed(2)}s)`)
      }
      return
    }

    inferring = true
    inferenceCount++

    try {
      // Build contiguous buffer from ring buffer (oldest → newest)
      const audioData = new Float32Array(bufferSize)
      const firstChunk = ringBuffer.slice(writePos)
      const secondChunk = ringBuffer.slice(0, writePos)
      audioData.set(firstChunk, 0)
      audioData.set(secondChunk, firstChunk.length)

      // Volume gate
      let peak = 0
      for (let i = 0; i < audioData.length; i++) {
        const abs = audioData[i] < 0 ? -audioData[i] : audioData[i]
        if (abs > peak) peak = abs
      }

      if (peak < VOLUME_GATE) {
        if (DEBUG && (lastSig !== null || inferenceCount <= 3)) {
          console.log(`[BasicPitch] Silence (peak: ${peak.toFixed(4)}, inference #${inferenceCount})`)
        }
        lastSig = null
        sigCount = 0
        onNotes(null)
        inferring = false
        return
      }

      // Log that we're running inference
      if (DEBUG && inferenceCount <= 5) {
        console.log(`[BasicPitch] Running inference #${inferenceCount} (peak: ${peak.toFixed(3)})`)
      }

      // Run inference
      let frames = []
      let onsets = []
      let contours = []

      await basicPitchInstance.evaluateModel(
        audioData,
        (f, o, c) => {
          frames.push(...f)
          onsets.push(...o)
          contours.push(...c)
        },
        () => {},
      )

      if (frames.length === 0) {
        DEBUG && console.log('[BasicPitch] No frames returned from model')
        lastSig = null
        sigCount = 0
        onNotes(null)
        inferring = false
        return
      }

      const rawNotes = outputToNotesPoly(
        frames, onsets,
        ONSET_THRESHOLD,
        FRAME_THRESHOLD,
        MIN_NOTE_LEN,
      )
      const noteEvents = noteFramesToTime(rawNotes)

      if (noteEvents.length === 0) {
        DEBUG && console.log(`[BasicPitch] ${frames.length} frames → 0 notes (peak: ${peak.toFixed(3)})`)
        lastSig = null
        sigCount = 0
        onNotes(null)
        inferring = false
        return
      }

      // Filter out low-confidence notes (harmonics, noise), then deduplicate
      const confident = noteEvents.filter((n) => n.amplitude >= MIN_AMPLITUDE)
      if (confident.length === 0) {
        DEBUG && console.log(`[BasicPitch] ${noteEvents.length} events but none above amplitude ${MIN_AMPLITUDE}`)
        lastSig = null
        sigCount = 0
        onNotes(null)
        inferring = false
        return
      }

      // Sort by amplitude descending — strongest notes first
      confident.sort((a, b) => b.amplitude - a.amplitude)

      // Deduplicate by MIDI pitch
      const seenMidi = new Set()
      const deduped = []
      for (const n of confident) {
        if (!seenMidi.has(n.pitchMidi)) {
          seenMidi.add(n.pitchMidi)
          deduped.push(n)
        }
      }

      // Remove octave ghosts: if two notes share the same letter name and
      // differ by exactly 12 semitones, keep only the stronger one.
      // This kills the common C3+C4 phantom when only C3 was played.
      const filtered = []
      for (const n of deduped) {
        const hasStrongerOctave = deduped.some(
          (other) =>
            other !== n &&
            other.amplitude > n.amplitude &&
            Math.abs(other.pitchMidi - n.pitchMidi) === 12
        )
        if (!hasStrongerOctave) filtered.push(n)
      }

      const uniqueNotes = filtered.map((n) => midiToNoteNamePitch(n.pitchMidi))

      const sig = uniqueNotes.slice().sort().join('+')
      DEBUG && console.log(`[BasicPitch] Detected: ${sig} | ${noteEvents.length} events | peak: ${peak.toFixed(3)}`)

      if (sig === lastSig) {
        sigCount++
      } else {
        lastSig = sig
        sigCount = 1
      }

      if (sigCount >= STABILITY_COUNT) {
        onNotes(uniqueNotes)
      }
    } catch (err) {
      console.error('[BasicPitch] Inference error:', err)
    }

    inferring = false
  }, INFERENCE_INTERVAL_MS)

  // Also log if onaudioprocess never fires
  setTimeout(() => {
    if (processCallCount === 0) {
      console.error('[BasicPitch] WARNING: onaudioprocess has NOT fired after 2s! AudioContext state:', audioCtx.state)
      console.error('[BasicPitch] This usually means mic access is blocked or AudioContext is suspended')
    }
  }, 2000)

  DEBUG && console.log('[BasicPitch] Detection started — interval:', INFERENCE_INTERVAL_MS, 'ms, buffer:', BUFFER_SECONDS, 's')

  return function stop() {
    DEBUG && console.log('[BasicPitch] Stopping detection')
    stopped = true
    clearInterval(intervalId)
    processor.disconnect()
    source.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    audioCtx.close()
  }
}
