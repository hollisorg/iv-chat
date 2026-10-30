import { useEffect, useState } from 'react'
import Avatar from './Avatar'
import { startRing } from '../ring'

// Someone calling on Telegram. Shown at the top of the window, above any panel, and rings on the chosen
// speaker if ringing is on. IV Chat can't answer calls yet: Decline ends the call for every device, and the
// banner goes away on its own when the call is answered elsewhere or the caller hangs up.
export default function CallBanner({ call, media, onOpenChat, onGone }) {
  const [photo, setPhoto] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    window.iv.telegram
      .avatar(call.chatId)
      .then((src) => live && setPhoto(src))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [call.chatId])

  useEffect(() => {
    if (!media?.ring) return undefined
    return startRing(media.speaker)
  }, [call.id, media?.ring, media?.speaker])

  const decline = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.iv.telegram.declineCall(call.id)
      onGone(call.id)
    } catch (err) {
      setError(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setBusy(false)
    }
  }

  const name = call.name || 'Someone'
  return (
    <div className="call-banner" role="alert" aria-label={`${name} is calling on Telegram`}>
      <span className="call-pulse">
        <Avatar name={name} src={photo} size={40} />
      </span>
      <span className="call-who">
        <span className="call-name">{name}</span>
        <span className="mono dim call-kind">
          Telegram {call.video ? 'video call' : 'call'} · answer on your phone or in Telegram Desktop
        </span>
        {error && <span className="call-error">{error}</span>}
      </span>
      <div className="row-actions">
        <button type="button" className="btn btn-quiet" onClick={() => onOpenChat(call.chatId)}>
          Open the chat
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={decline} title="Declines the call on every device">
          {busy ? 'Declining…' : 'Decline'}
        </button>
      </div>
    </div>
  )
}
