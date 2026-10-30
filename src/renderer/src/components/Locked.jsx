import { useState } from 'react'
import Hero from './Hero'

// Shown instead of every view while IV Chat can't unlock its saved sign-ins (main/index.js unlockAtStart).
// They're still on disk, and signing in again would replace them, so this offers a restart first. Start over
// is for when restarting keeps failing, for example after the Windows account's protection was reset.
export default function Locked({ unlock, onChange }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const run = async (action) => {
    setBusy(true)
    setError(null)
    try {
      const next = await action()
      if (next) onChange(next)
    } catch (err) {
      setError(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
    setBusy(false)
  }

  // Started inside another app's package (main/package-guard.js): the sign-ins are fine, just out of sight here.
  if (unlock.borrowedBy) {
    return (
      <section className="page" aria-label="Opened inside another app">
        <Hero title="Opened inside" accent={`${unlock.borrowedBy}.`} kicker="IV Chat · this computer" />
        <p className="lead">
          IV Chat was started from inside {unlock.borrowedBy}, so Windows gave it {unlock.borrowedBy}'s private copy of IV
          Chat's folder instead of yours. Your sign-ins are safe; they just can't be seen from here.
        </p>
        <p className="dim">Close this window, then open IV Chat from the Start menu or the taskbar.</p>
        <div className="row-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => run(() => window.iv.app.quit())}>
            Close IV Chat
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
    )
  }

  return (
    <section className="page" aria-label="Sign-ins locked">
      <Hero title="Sign-ins" accent="locked." kicker="IV Chat · this computer" />
      <p className="lead">
        IV Chat couldn't unlock your saved sign-ins for Telegram and the websites. They're still saved on this computer.
        This can happen right after Windows starts, and restarting IV Chat usually brings them back.
      </p>
      <p className="dim">Don't sign in again for now: that would replace the saved sign-ins.</p>
      {unlock.retrying && <p className="mono dim">IV Chat will restart itself in a few seconds to try again.</p>}
      <div className="row-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => run(() => window.iv.app.restart())}>
          Restart IV Chat
        </button>
        {!confirming && (
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setConfirming(true)}>
            Start over
          </button>
        )}
      </div>
      {confirming && (
        <div className="locked-confirm">
          <p>
            Start over removes the saved sign-ins IV Chat can't open, and you sign in to Telegram and each website again. Only
            do this if restarting hasn't helped.
          </p>
          <div className="row-actions">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => run(() => window.iv.app.startOver())}>
              Remove and sign in again
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
