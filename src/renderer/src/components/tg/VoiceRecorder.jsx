import { useEffect, useRef, useState } from 'react'
import { clock } from './TgMedia'
import { chosenDeviceId, savedMedia } from '../../devices'

// Recording a voice message, like Telegram Desktop: the mic starts it, then a bar shows the time and the
// live loudness, with Cancel and Send. The recording (WebM Opus) goes to the main process, which rewraps it
// as a Telegram voice note. Nothing is sent until Send is pressed. Escape cancels.
const MIN_SECONDS = 1
const MAX_SECONDS = 15 * 60

export default function VoiceRecorder({ onSend, onCancel, onError }) {
  const [seconds, setSeconds] = useState(0)
  const [levels, setLevels] = useState([])
  const [sending, setSending] = useState(false)
  const rec = useRef(null)

  useEffect(() => {
    let cancelled = false
    const state = { chunks: [], samples: [], started: Date.now() }
    rec.current = state
    ;(async () => {
      try {
        // The microphone chosen in Settings > Calls and devices, or Windows' default.
        const media = await savedMedia()
        const mic = await chosenDeviceId('audioinput', media.mic)
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(mic ? { deviceId: { exact: mic } } : {}) }
        })
        if (cancelled) return stream.getTracks().forEach((t) => t.stop())
        state.stream = stream
        state.recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 })
        state.recorder.ondataavailable = (e) => e.data.size && state.chunks.push(e.data)
        state.recorder.start(250)
        state.started = Date.now()
        // The loudness, sampled for the live bars and the waveform Telegram shows.
        state.ctx = new AudioContext()
        const analyser = state.ctx.createAnalyser()
        analyser.fftSize = 512
        state.ctx.createMediaStreamSource(stream).connect(analyser)
        const data = new Uint8Array(analyser.fftSize)
        state.timer = setInterval(() => {
          analyser.getByteTimeDomainData(data)
          let peak = 0
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128))
          const level = Math.min(1, peak / 90)
          state.samples.push(level)
          setLevels((l) => [...l.slice(-39), level])
          const s = (Date.now() - state.started) / 1000
          setSeconds(s)
          if (s >= MAX_SECONDS) stop(true)
        }, 60)
      } catch (err) {
        onError(
          /Permission|NotAllowed/i.test(String(err))
            ? 'IV Chat needs your microphone to record. Check Settings > Calls and devices, and Windows Settings, Privacy, Microphone.'
            : "Couldn't start recording: " + (err.message || err)
        )
        onCancel()
      }
    })()
    const esc = (e) => e.key === 'Escape' && stop(false)
    window.addEventListener('keydown', esc)
    return () => {
      cancelled = true
      window.removeEventListener('keydown', esc)
      release(state)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const release = (state) => {
    clearInterval(state.timer)
    state.stream?.getTracks().forEach((t) => t.stop())
    state.ctx?.close().catch(() => {})
  }

  // Telegram's waveform: 100 values from 0 to 31.
  const waveform = (samples) => {
    if (!samples.length) return []
    const loudest = Math.max(...samples, 0.05)
    return Array.from({ length: 100 }, (_, i) => {
      const a = Math.floor((i * samples.length) / 100)
      const b = Math.max(a + 1, Math.floor(((i + 1) * samples.length) / 100))
      return Math.round((Math.max(...samples.slice(a, b)) / loudest) * 31)
    })
  }

  async function stop(send) {
    const state = rec.current
    if (!state || state.done) return
    state.done = true
    const recorder = state.recorder
    if (!recorder || recorder.state === 'inactive') {
      release(state)
      return onCancel()
    }
    await new Promise((resolve) => {
      recorder.onstop = resolve
      recorder.stop()
    })
    release(state)
    const length = (Date.now() - state.started) / 1000
    if (!send) return onCancel()
    if (length < MIN_SECONDS) {
      onError('Hold on a little longer: voice messages need at least a second.')
      return onCancel()
    }
    setSending(true)
    try {
      const bytes = await new Blob(state.chunks, { type: 'audio/webm' }).arrayBuffer()
      await onSend(bytes, waveform(state.samples))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="recorder" role="group" aria-label="Recording a voice message">
      <button type="button" className="btn btn-quiet recorder-cancel" onClick={() => stop(false)} disabled={sending} title="Cancel (Esc)">
        Cancel
      </button>
      <span className="recorder-dot" aria-hidden="true" />
      <span className="mono recorder-time">{clock(seconds)}</span>
      <span className="recorder-levels" aria-hidden="true">
        {Array.from({ length: 40 }, (_, i) => {
          const v = levels[i - (40 - levels.length)] ?? 0
          return <span key={i} style={{ height: `${Math.max(8, Math.round(v * 100))}%` }} />
        })}
      </span>
      <button type="button" className="btn btn-primary recorder-send" onClick={() => stop(true)} disabled={sending}>
        {sending ? 'Sending…' : 'Send'}
      </button>
    </div>
  )
}
