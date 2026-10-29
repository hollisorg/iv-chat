import { useState } from 'react'
import { starterMessage } from '../../../main/starter.js'

function Segmented({ value, options, onChange, label }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={value === id ? 'on' : ''} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  )
}

// How to start using IV Chat from Codex or Claude: the steps, the person's reply preferences, and a
// starter message to copy into a new chat with their AI.
export default function AiGuide({ prefs, onChange }) {
  const [app, setApp] = useState('codex')
  const [copied, setCopied] = useState(false)
  const [notes, setNotes] = useState(prefs.notes)
  const [signOff, setSignOff] = useState(prefs.signOff)
  const message = starterMessage(app, { ...prefs, notes, signOff })

  const copy = async () => {
    await window.iv.app.copy(message)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <>
      <h3 className="sub-title">Use IV Chat with your AI</h3>
      <ol className="guide-steps">
        <li>Connect Codex or Claude above, then restart it.</li>
        <li>Share the chats you want help with, below or with the switch at the top of a Telegram chat.</li>
        <li>Pick how you like your replies written.</li>
        <li>Copy the starter message and paste it into a new Codex or Claude chat.</li>
        <li>
          Then just ask: <i>"What's new?"</i>, <i>"Reply to Sam that I'll be there at 7"</i>, or <i>"Find the address Jo sent me."</i>{' '}
          Drafts appear in the chat for you to check and send.
        </li>
      </ol>

      <div className="prefs">
        <div className="pref-row">
          <span className="pref-label">Tone</span>
          <Segmented
            label="Tone"
            value={prefs.tone}
            onChange={(tone) => onChange({ tone })}
            options={[
              ['friendly', 'Friendly'],
              ['professional', 'Professional'],
              ['casual', 'Casual']
            ]}
          />
        </div>
        <div className="pref-row">
          <span className="pref-label">Length</span>
          <Segmented
            label="Length"
            value={prefs.length}
            onChange={(length) => onChange({ length })}
            options={[
              ['short', 'Short'],
              ['medium', 'Paragraph'],
              ['match', 'Match theirs']
            ]}
          />
        </div>
        <label className="pref-row">
          <span className="pref-label">Sign-off name</span>
          <input
            value={signOff}
            maxLength={60}
            placeholder="Optional, e.g. Matt"
            onChange={(e) => setSignOff(e.target.value)}
            onBlur={() => onChange({ signOff })}
          />
        </label>
        <label className="pref-row">
          <span className="pref-label">Anything else</span>
          <textarea
            rows={2}
            value={notes}
            maxLength={500}
            placeholder="Optional, e.g. never use emojis with clients"
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => onChange({ notes })}
          />
        </label>
      </div>

      <div className="starter">
        <div className="starter-head">
          <Segmented
            label="Starter message for"
            value={app}
            onChange={setApp}
            options={[
              ['codex', 'For Codex'],
              ['claude', 'For Claude']
            ]}
          />
          <button type="button" className="btn btn-primary" onClick={copy}>
            {copied ? 'Copied' : 'Copy message'}
          </button>
        </div>
        <pre className="starter-text">{message}</pre>
      </div>
    </>
  )
}
