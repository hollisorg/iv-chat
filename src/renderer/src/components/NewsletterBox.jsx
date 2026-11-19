// The IV Newsletter signup box, shared by every IV app (source of truth: IVAI docs/newsletter/apps/NewsletterBox.jsx).
// variant "settings": the box in Settings/About. variant "card": the one-time first-run card with "Not now".
// title={false} drops the box's own heading when the app's settings card already says "The IV Newsletter".
// `api` is the preload's newsletter bridge ({status, join, closeCard, openPage}). Opt-in only: the field starts
// empty and nothing is sent until Join is clicked. Colours come from the app (CSS variables in newsletter-box.css).
import { useEffect, useId, useState } from 'react'
import './newsletter-box.css'

const when = (iso) => {
  try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) } catch { return '' }
}

export default function NewsletterBox({ api, variant = 'settings', onClose, title = true }) {
  const id = useId()
  const [status, setStatus] = useState(null)
  const [email, setEmail] = useState('')
  const [phase, setPhase] = useState('idle') // idle | sending | done
  const [error, setError] = useState(null) // {error, field?, offline?}
  const [again, setAgain] = useState(false)
  const [closed, setClosed] = useState(false) // the card hides itself after Not now or Done

  useEffect(() => {
    let live = true
    api?.status().then((s) => { if (live) setStatus(s) }).catch(() => { if (live) setStatus({}) })
    return () => { live = false }
  }, [api])

  if (!api || !status || closed) return null
  const card = variant === 'card'
  // The card shows once: never after joining or "Not now" (but it stays up to show its own thank-you).
  if (card && phase !== 'done' && (status.joinedAt || status.cardClosedAt)) return null

  const submit = async (e) => {
    e.preventDefault()
    if (phase === 'sending') return
    setError(null)
    setPhase('sending')
    const r = await api.join({ email }).catch(() => ({ ok: false, offline: true, error: "Couldn't reach the signup service." }))
    if (r.ok) { setPhase('done'); setStatus((s) => ({ ...s, joinedAt: r.joinedAt })); setEmail(''); setAgain(false) }
    else { setPhase('idle'); setError(r) }
  }
  const notNow = async () => { setClosed(true); await api.closeCard().catch(() => {}); onClose?.() }
  const done = () => { setClosed(true); onClose?.() }

  const showForm = phase !== 'done' && (!status.joinedAt || again)
  return (
    <section className={`ivnl ivnl-${variant}`} aria-labelledby={title ? `${id}-h` : undefined} aria-label={title ? undefined : 'The IV Newsletter'}>
      {title && <h3 id={`${id}-h`} className="ivnl-title">The IV Newsletter</h3>}
      <p className="ivnl-lead">One email a week from Matt: what's new in the IV apps, how things are made, and free tools.</p>

      {phase === 'done' && (
        <p className="ivnl-done" role="status">Check your inbox. Click the link in Kit's email to confirm.</p>
      )}

      {phase !== 'done' && status.joinedAt && !again && (
        <p className="ivnl-done" role="status">
          You joined on {when(status.joinedAt)}. Not seeing the email? Check Promotions or spam.{' '}
          <button type="button" className="ivnl-link" onClick={() => setAgain(true)}>Use another address</button>
        </p>
      )}

      {showForm && (
        <form className="ivnl-form" onSubmit={submit} noValidate>
          <label htmlFor={`${id}-email`} className="ivnl-label">Your email</label>
          <div className="ivnl-row">
            <input
              id={`${id}-email`}
              className="ivnl-input"
              type="email"
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (error) setError(null) }}
              aria-invalid={error?.field === 'email' ? 'true' : undefined}
              aria-describedby={error ? `${id}-err` : `${id}-small`}
              disabled={phase === 'sending'}
            />
            <button type="submit" className="ivnl-join" disabled={phase === 'sending'}>
              {phase === 'sending' ? 'Joining…' : 'Join'}
            </button>
          </div>
          {error && (
            <p id={`${id}-err`} className="ivnl-error" role="alert">
              {error.error}{' '}
              {error.offline && (
                <button type="button" className="ivnl-link" onClick={() => api.openPage()}>Join on infinitevariance.ai instead</button>
              )}
            </p>
          )}
          <p id={`${id}-small`} className="ivnl-small">
            Kit, our email service, sends you a confirm email first. Nothing arrives until you click it. Unsubscribe any
            time. This app doesn't keep your address.
          </p>
        </form>
      )}

      {card && (
        <div className="ivnl-card-actions">
          {phase === 'done'
            ? <button type="button" className="ivnl-secondary" onClick={done}>Done</button>
            : <button type="button" className="ivnl-secondary" onClick={notNow}>Not now</button>}
        </div>
      )}
    </section>
  )
}
