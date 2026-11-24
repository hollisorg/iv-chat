import { useEffect, useRef, useState } from 'react'
import { chosenDeviceId, savedMedia } from '../devices'

// Saying what you want instead of typing it, for the ✨ Draft buttons: the mic records, the recording is
// turned into text on this computer (src/main/speech.js, the same engine as IV Voice), and the text lands
// where the instruction goes. Pressing Draft while recording stops, transcribes and drafts in one go.
// Nothing is sent, and the recording is never saved.
const MAX_SECONDS = 5 * 60

const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export const joinInstruction = (typed, spoken) => {
  const a = String(typed || '').trim()
  const b = String(spoken || '').trim()
  return a && b ? `${a} ${b}` : a || b
}

export function useDictation({ onText, onError }) {
  const [state, setState] = useState('idle') // idle | starting | recording | working
  const [seconds, setSeconds] = useState(0)
  const rec = useRef(null)
  const handlers = useRef({ onText, onError })
  handlers.current = { onText, onError }

  const release = (r) => {
    clearInterval(r?.timer)
    r?.stream?.getTracks().forEach((t) => t.stop())
  }

  const start = async () => {
    if (rec.current) return
    const r = { chunks: [], started: Date.now() }
    rec.current = r
    setState('starting')
    setSeconds(0)
    try {
      const media = await savedMedia()
      const mic = await chosenDeviceId('audioinput', media.mic)
      r.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(mic ? { deviceId: { exact: mic } } : {}) }
      })
      if (rec.current !== r) return release(r)
      r.recorder = new MediaRecorder(r.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 })
      r.recorder.ondataavailable = (e) => e.data.size && r.chunks.push(e.data)
      r.recorder.start(250)
      r.started = Date.now()
      r.timer = setInterval(() => {
        const s = (Date.now() - r.started) / 1000
        setSeconds(s)
        if (s >= MAX_SECONDS) finish(true)
      }, 250)
      setState('recording')
    } catch (err) {
      release(r)
      rec.current = null
      setState('idle')
      handlers.current.onError(
        /Permission|NotAllowed/i.test(String(err))
          ? 'IV Chat needs your microphone. Check Settings > Calls and devices, and Windows Settings, Privacy, Microphone.'
          : `Couldn't start the microphone: ${clean(err)}`
      )
    }
  }

  // Stops and turns the recording into text. With deliver, the text goes to onText; it is always returned.
  async function finish(deliver = true) {
    const r = rec.current
    if (!r?.recorder || r.recorder.state === 'inactive') return ''
    await new Promise((resolve) => {
      r.recorder.onstop = resolve
      r.recorder.stop()
    })
    release(r)
    setState('working')
    try {
      if ((Date.now() - r.started) / 1000 < 0.6) return ''
      const bytes = await new Blob(r.chunks, { type: 'audio/webm' }).arrayBuffer()
      const text = await window.iv.speech.instruction(bytes)
      if (!text) handlers.current.onError("Didn't catch that. Try again a little closer to the microphone.")
      else if (deliver) handlers.current.onText(text)
      return text
    } catch (err) {
      handlers.current.onError(clean(err))
      return ''
    } finally {
      rec.current = null
      setState('idle')
    }
  }

  const cancel = () => {
    const r = rec.current
    rec.current = null
    if (r?.recorder && r.recorder.state !== 'inactive') r.recorder.stop()
    release(r)
    setState('idle')
  }

  useEffect(() => () => cancel(), [])

  return { state, seconds, start, finish, cancel }
}

// The mic next to a Draft button. Click to start talking, click again to stop and see the words.
export function MicButton({ dictation, name = 'what to say', label = '' }) {
  const { state, seconds } = dictation
  const busy = state === 'starting' || state === 'working'
  const live = state === 'recording'
  const click = () => (live ? dictation.finish(true) : state === 'idle' ? dictation.start() : null)
  const title = live ? 'Stop and turn it into text (or press Draft to draft straight away)' : busy ? 'Turning it into text…' : `Say ${name} instead of typing it`
  return (
    <button
      type="button"
      className={`btn btn-quiet mic-say${live ? ' is-live' : ''}${busy ? ' is-busy' : ''}`}
      onClick={click}
      disabled={busy}
      title={title}
      aria-label={title}
      aria-pressed={live}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" />
      </svg>
      {live ? (
        <span className="mono mic-say-time">
          {Math.floor(seconds / 60)}:{String(Math.floor(seconds % 60)).padStart(2, '0')}
        </span>
      ) : state === 'working' ? (
        <span className="mono mic-say-time">…</span>
      ) : (
        label && <span className="mic-say-label">{label}</span>
      )}
    </button>
  )
}
