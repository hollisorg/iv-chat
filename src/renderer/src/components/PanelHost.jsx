import { useLayoutEffect, useRef, useState } from 'react'
import { NAMES } from '../views'

// The bar above each website panel: drafts a reply to the chat open in that site with the person's own
// Codex or Claude, and places it in the site's reply box. Nothing is sent; they press Enter there.
function DraftBar({ service }) {
  const name = NAMES[service]
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)

  const draft = async () => {
    if (busy) return window.iv.draft.cancel()
    setBusy(true)
    setStatus(null)
    try {
      const { engine } = await window.iv.draft.panel(service, hint.trim())
      setStatus({ ok: true, text: `Draft from ${engine} is in the reply box. Check it, then press Enter in ${name}.` })
      setHint('')
    } catch (err) {
      const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      setStatus(msg === 'Cancelled' ? null : { ok: false, text: msg })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel-tools">
      <button type="button" className={`btn draft-btn${busy ? ' is-busy' : ''}`} onClick={draft}>
        <span aria-hidden="true">✨</span> {busy ? 'Stop' : 'Draft reply'}
      </button>
      <input
        className="panel-tools-hint"
        value={hint}
        maxLength={500}
        placeholder="What do you want to say? (optional)"
        onChange={(e) => setHint(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && draft()}
      />
      <span className={`panel-tools-status mono${status && !status.ok ? ' is-error' : ''}`} role="status">
        {busy ? `Drafting for the chat open in ${name}…` : status?.text || `Drafts a reply to the chat open in ${name} below`}
      </span>
    </div>
  )
}

// Marks out where the active service's real website sits. The page itself is a separate native view
// that the main process lays over the measured area; what's drawn here only shows while it's loading, off or broken.
export default function PanelHost({ service, onEnable }) {
  const ref = useRef(null)
  const name = NAMES[service.id]
  const tools = service.enabled && service.state === 'ready'

  useLayoutEffect(() => {
    const el = ref.current
    const report = () => {
      const r = el.getBoundingClientRect()
      window.iv.view.setPanelBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [tools])

  return (
    <section className="panel-host" aria-label={name}>
      {tools && <DraftBar key={service.id} service={service.id} />}
      <div className={`panel-area${tools ? ' has-tools' : ''}`} ref={ref}>
        {!service.enabled && (
          <div className="panel-note">
            <p className="mono label">{name}</p>
            <h1 className="panel-title">{name} is turned off.</h1>
            <p className="dim">Turn it on to sign in and see your {name} chats here.</p>
            <button type="button" className="btn btn-primary" onClick={() => onEnable(service.id)}>
              Turn on {name}
            </button>
          </div>
        )}
        {service.enabled && service.state === 'loading' && (
          <div className="panel-note">
            <p className="mono label">{name}</p>
            <p className="dim">Opening {name}…</p>
          </div>
        )}
        {service.enabled && service.state === 'error' && (
          <div className="panel-note" role="alert">
            <p className="mono label">{name}</p>
            <h1 className="panel-title">{name} didn't load.</h1>
            <p className="dim">Check your internet connection, then try again.</p>
            <p className="mono dim">{service.error}</p>
            <button type="button" className="btn btn-primary" onClick={() => window.iv.services.reload(service.id)}>
              Try again
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
