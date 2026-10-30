import { useCallback, useEffect, useRef, useState } from 'react'
import { ACCESS_IDS } from '../../../main/media-settings.js'
import { NAMES } from '../views'
import { chosenDeviceId } from '../devices'
import { playTestTone } from '../ring'

// Settings > Calls and devices: which microphone, camera and speaker IV Chat and the website panels use,
// who may use the microphone and camera, and ringing for Telegram calls. Devices are saved by name.
// The microphone and camera only turn on while you're testing them here.
const KINDS = [
  { key: 'mic', kind: 'audioinput', label: 'Microphone' },
  { key: 'camera', kind: 'videoinput', label: 'Camera' },
  { key: 'speaker', kind: 'audiooutput', label: 'Speaker' }
]
const ACCESS_LABEL = { telegram: 'Telegram and IV Chat' }
const CHOICES = [
  ['ask', 'Ask'],
  ['allow', 'Allow'],
  ['block', 'Block']
]

const stopStream = (s) => s?.getTracks().forEach((t) => t.stop())

function useDevices() {
  const [devices, setDevices] = useState([])
  const refresh = useCallback(async () => {
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices())
    } catch {
      setDevices([])
    }
  }, [])
  useEffect(() => {
    refresh()
    navigator.mediaDevices?.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh)
  }, [refresh])
  return [devices, refresh]
}

// A live loudness bar for the chosen microphone, while the test is on.
function MicTest({ name, onError }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    let stream = null
    let ctx = null
    let timer = null
    let gone = false
    ;(async () => {
      try {
        const id = await chosenDeviceId('audioinput', name)
        stream = await navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true })
        if (gone) return stopStream(stream)
        ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        ctx.createMediaStreamSource(stream).connect(analyser)
        const data = new Uint8Array(analyser.fftSize)
        timer = setInterval(() => {
          analyser.getByteTimeDomainData(data)
          let peak = 0
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128))
          setLevel(Math.min(1, peak / 90))
        }, 60)
      } catch (err) {
        onError(`Couldn't open the microphone: ${err.message || err}`)
      }
    })()
    return () => {
      gone = true
      clearInterval(timer)
      ctx?.close().catch(() => {})
      stopStream(stream)
    }
  }, [name, onError])
  return (
    <span className="mic-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
      <span style={{ '--level': level }} />
    </span>
  )
}

// A small live picture from the chosen camera, while the test is on.
function CameraTest({ name, onError }) {
  const video = useRef(null)
  useEffect(() => {
    let stream = null
    let gone = false
    ;(async () => {
      try {
        const id = await chosenDeviceId('videoinput', name)
        stream = await navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { exact: id } } : true })
        if (gone) return stopStream(stream)
        if (video.current) video.current.srcObject = stream
      } catch (err) {
        onError(`Couldn't open the camera: ${err.message || err}`)
      }
    })()
    return () => {
      gone = true
      stopStream(stream)
    }
  }, [name, onError])
  return <video ref={video} className="camera-test" autoPlay muted playsInline aria-label="Camera preview" />
}

export default function DeviceSettings({ media, onChange }) {
  const [devices, refresh] = useDevices()
  const [testing, setTesting] = useState(null) // 'mic' | 'camera' | null
  const [error, setError] = useState(null)
  const named = devices.some((d) => d.label)
  const set = (patch) => onChange({ media: patch })

  // Windows only shows device names after the first microphone or camera permission.
  const reveal = async () => {
    setError(null)
    try {
      stopStream(await navigator.mediaDevices.getUserMedia({ audio: true, video: true }))
    } catch {
      try {
        stopStream(await navigator.mediaDevices.getUserMedia({ audio: true }))
      } catch (err) {
        setError(`IV Chat couldn't see your devices: ${err.message || err}. Check "Telegram and IV Chat" below, and Windows Settings, Privacy.`)
      }
    }
    refresh()
  }

  // Leaving Settings ends a test (the test components stop their device when they go).
  const onError = useCallback((msg) => {
    setError(msg)
    setTesting(null)
  }, [])

  return (
    <>
      <h2 className="section-title">Calls and devices</h2>
      <ul className="rows">
        {!named && (
          <li className="row">
            <span className="toggle">
              <span>
                <span className="toggle-label">Your devices</span>
                <span className="toggle-hint dim">Windows hasn't shown IV Chat your device names yet. This asks for the microphone and camera once; nothing is recorded.</span>
              </span>
            </span>
            <div className="row-actions">
              <button type="button" className="btn btn-quiet" onClick={reveal}>
                Allow IV Chat to see your devices
              </button>
            </div>
          </li>
        )}
        {KINDS.map(({ key, kind, label }) => {
          const list = devices.filter((d) => d.kind === kind && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications')
          const saved = media[key]
          const missing = saved && named && !list.some((d) => d.label === saved)
          return (
            <li key={key} className="row device-row">
              <label className="device-pick">
                <span className="toggle-label">{label}</span>
                <select
                  value={saved}
                  disabled={!named}
                  onChange={(e) => {
                    setTesting(null)
                    set({ [key]: e.target.value })
                  }}
                >
                  <option value="">Windows default</option>
                  {list.map((d) => (
                    <option key={d.deviceId} value={d.label}>
                      {d.label}
                    </option>
                  ))}
                  {missing && <option value={saved}>{saved} (not connected)</option>}
                </select>
                {missing && <span className="toggle-hint dim">{saved} isn't connected, so Windows' default is used.</span>}
                {key === 'mic' && testing === 'mic' && <MicTest name={missing ? '' : saved} onError={onError} />}
                {key === 'camera' && testing === 'camera' && <CameraTest name={missing ? '' : saved} onError={onError} />}
              </label>
              <div className="row-actions">
                {key === 'speaker' ? (
                  <button type="button" className="btn btn-quiet" onClick={() => playTestTone(missing ? '' : saved).catch((err) => setError(`Couldn't play: ${err.message || err}`))}>
                    Play test sound
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`btn btn-quiet${testing === key ? ' is-on' : ''}`}
                    onClick={() => {
                      setError(null)
                      setTesting((t) => (t === key ? null : key))
                    }}
                  >
                    {testing === key ? 'Stop test' : key === 'mic' ? 'Test microphone' : 'Show camera'}
                  </button>
                )}
              </div>
            </li>
          )
        })}
        <li className="row">
          <label className="toggle">
            <span>
              <span className="toggle-label">Ring for Telegram calls</span>
              <span className="toggle-hint dim">When someone calls you on Telegram, IV Chat shows who's calling and rings on the speaker above. Answer on your phone or in Telegram Desktop.</span>
            </span>
            <input type="checkbox" role="switch" checked={media.ring} onChange={(e) => set({ ring: e.target.checked })} />
          </label>
        </li>
      </ul>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}

      <h3 className="sub-title">Who can use your microphone and camera</h3>
      <p className="dim small">
        Ask shows a question the first time a service wants them each time IV Chat runs. The panels' own calls use the devices chosen above, where the site lets IV Chat pick.
      </p>
      <ul className="rows">
        {ACCESS_IDS.map((id) => (
          <li key={id} className="row">
            <span className="toggle-label">{ACCESS_LABEL[id] || NAMES[id]}</span>
            <div className="segmented" role="radiogroup" aria-label={`Microphone and camera for ${ACCESS_LABEL[id] || NAMES[id]}`}>
              {CHOICES.map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={media.access[id] === value}
                  className={media.access[id] === value ? 'on' : ''}
                  onClick={() => set({ access: { [id]: value } })}
                >
                  {text}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
