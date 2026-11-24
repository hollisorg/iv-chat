import { useEffect, useState } from 'react'

// Settings > Voice to text: which speech engine turns voice messages and spoken Draft instructions into
// text. IV Voice's engine is used when it is installed; otherwise one click downloads IV Chat's own.
export default function SpeechSettings() {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    window.iv.speech.status().then(setStatus)
    return window.iv.speech.onStatus(setStatus)
  }, [])

  const setup = async () => {
    setError(null)
    try {
      setStatus(await window.iv.speech.setup())
    } catch (err) {
      setError(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  if (!status) return null
  const working = status.setup
  return (
    <>
      <h2 className="section-title">Voice to text</h2>
      <ul className="rows">
        <li className="row speech-row">
          <div className="speech-text">
            {status.ready ? (
              <>
                <span className="toggle-label">
                  Ready, using {status.source === 'IV Voice' ? "IV Voice's" : "IV Chat's own"} speech engine ({status.model}
                  {status.gpu ? ', graphics card' : ', processor'})
                </span>
                <span className="toggle-hint">
                  Shows the words of Telegram voice messages ("Show text"), lets your AI read them, and turns what you say into the
                  instruction for ✨ Draft. It all happens on this computer; no audio is uploaded.
                </span>
              </>
            ) : (
              <>
                <span className="toggle-label">Not set up yet</span>
                <span className="toggle-hint">
                  IV Chat uses the same speech engine as IV Voice. If IV Voice is installed it is used as it is. Otherwise set one up
                  here: a one-time download (about 600 MB with an NVIDIA graphics card, 200 MB without), kept on this computer.
                </span>
              </>
            )}
            {working && (
              <span className="toggle-hint mono" role="status">
                {working.phase}
                {working.percent != null ? ` ${working.percent}%` : '…'}
              </span>
            )}
            {error && <span className="error">{error}</span>}
          </div>
          {!status.ready && (
            <button type="button" className="btn btn-primary" onClick={setup} disabled={Boolean(working)}>
              {working ? 'Setting up…' : 'Set up voice to text'}
            </button>
          )}
        </li>
      </ul>
    </>
  )
}
