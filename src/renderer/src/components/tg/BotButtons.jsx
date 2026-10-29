import { useState } from 'react'

// Bot buttons. Inline buttons sit under a bot's message: pressing one asks the bot (its answer shows as a
// note or an alert), opens its link in your browser, or copies its text. A bot keyboard replaces your reply
// box's buttons: pressing one sends its text, as in Telegram.
const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function InlineButtons({ dialogId, m, onNote, onAlert, onError }) {
  const [busy, setBusy] = useState(null)
  const press = async (b, key) => {
    if (b.kind === 'url') return window.open(b.url, '_blank', 'noreferrer')
    if (b.kind === 'copy') {
      await window.iv.app.copy(b.copy)
      return onNote('Copied.')
    }
    if (b.kind !== 'callback') return
    setBusy(key)
    try {
      const res = await window.iv.telegram.pressButton(dialogId, m.id, b.data, b.game)
      if (res.url) window.open(res.url, '_blank', 'noreferrer')
      if (res.message) (res.alert ? onAlert : onNote)(res.message)
    } catch (err) {
      const msg = clean(err)
      // Bots that don't answer in time aren't an error the person can do anything about.
      if (!/BOT_RESPONSE_TIMEOUT|timeout/i.test(msg)) onError(msg)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="bot-buttons">
      {m.buttons.rows.map((row, r) => (
        <div key={r} className="bot-row">
          {row.map((b, i) => {
            const key = `${r}:${i}`
            const unsupported = b.kind === 'other'
            return (
              <button
                key={key}
                type="button"
                className={`bot-btn${busy === key ? ' is-busy' : ''}`}
                disabled={unsupported || busy === key}
                title={b.kind === 'url' ? b.url : unsupported ? 'This kind of button only works in the Telegram app' : undefined}
                onClick={() => press(b, key)}
              >
                {b.text}
                {b.kind === 'url' && <span className="bot-btn-mark"> ↗</span>}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export function BotKeyboard({ markup, onPress }) {
  return (
    <div className={`bot-keyboard${markup.resize ? ' is-compact' : ''}`} role="group" aria-label="Bot keyboard">
      {markup.rows.map((row, r) => (
        <div key={r} className="bot-row">
          {row.map((b, i) => (
            <button key={i} type="button" className="bot-btn" disabled={b.kind !== 'text'} title={b.kind !== 'text' ? 'This kind of button only works in the Telegram app' : undefined} onClick={() => onPress(b.text)}>
              {b.text}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
