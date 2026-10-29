import { useEffect, useState } from 'react'
import { aiCanSee, chatKey } from '../../../main/ai-access.js'
import { NAMES } from '../views'
import AiGuide from './AiGuide'

const APPS = [
  { id: 'codex', name: 'Codex', hint: 'OpenAI Codex on this computer (its config.toml)' },
  { id: 'claudeDesktop', name: 'Claude Desktop', hint: 'The Claude app on this computer' },
  { id: 'claudeCode', name: 'Claude Code', hint: 'Claude Code on this computer, through its own command' }
]

const TOOL_NAMES = {
  list_chats: 'Listed chats',
  get_updates: 'Checked for new messages',
  read_chat: 'Read a chat',
  search_messages: 'Searched messages',
  draft_reply: 'Drafted a reply'
}

// Every chat IV Chat knows about, with the same ids the AI uses.
function knownChats(telegram, chats) {
  const out = []
  if (telegram.state?.status === 'ready') {
    for (const d of telegram.dialogs) out.push({ key: chatKey('telegram', d.id), service: 'telegram', name: d.name })
  }
  for (const service of ['whatsapp', 'messenger']) {
    if (chats[service]?.status !== 'ok') continue
    for (const c of chats[service].chats) {
      out.push({ key: chatKey(service, service === 'messenger' && c.id ? c.id : c.name), service, name: c.name })
    }
  }
  return out
}

export default function AiSettings({ aiState, setAiState, onChange, onToggleAi, telegram, chats, prefs }) {
  const [busy, setBusy] = useState(null)
  const [result, setResult] = useState(null)
  const [filter, setFilter] = useState('')
  const [engines, setEngines] = useState(null)
  useEffect(() => {
    window.iv.draft.engines().then(setEngines)
  }, [])
  const chooseEngine = async (draftEngine) => {
    await onChange({ draftEngine })
    setEngines(await window.iv.draft.engines())
  }
  if (!aiState) return null
  const { ai, connections, activity } = aiState
  const list = knownChats(telegram, chats).filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()))
  const names = Object.fromEntries(knownChats(telegram, chats).map((c) => [c.key, c.name]))

  const change = async (id, connect) => {
    setBusy(id)
    setResult(null)
    try {
      const next = await (connect ? window.iv.ai.connect(id) : window.iv.ai.disconnect(id))
      setAiState(next)
      setResult(next.error ? { error: next.error } : next.message ? { message: next.message } : null)
    } catch (err) {
      setResult({ error: String(err.message || err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <h2 className="section-title">Your AI</h2>
      <p className="dim small">
        Codex or Claude on this computer can read the chats you share below and draft replies. It can never send: you review
        every draft and press Enter yourself.
      </p>
      <ul className="rows">
        <li className="row">
          <label className="toggle">
            <span>
              <span className="toggle-label">AI access</span>
              <span className="toggle-hint dim">Turn off to stop your AI seeing anything in IV Chat</span>
            </span>
            <input type="checkbox" role="switch" checked={ai.enabled} onChange={(e) => onChange({ ai: { enabled: e.target.checked } })} />
          </label>
        </li>
        <li className="row">
          <label className="toggle">
            <span>
              <span className="toggle-label">Share every chat</span>
              <span className="toggle-hint dim">
                {ai.mode === 'all' ? 'Your AI can see all chats except the ones you switch off.' : 'Your AI only sees the chats you switch on below.'}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={ai.mode === 'all'}
              onChange={(e) => onChange({ ai: { mode: e.target.checked ? 'all' : 'chosen' } })}
            />
          </label>
        </li>
        {APPS.map((a) => (
          <li key={a.id} className="row">
            <span className="toggle">
              <span>
                <span className="toggle-label">{a.name}</span>
                <span className="toggle-hint dim">{connections[a.id] ? 'Connected' : a.hint}</span>
              </span>
            </span>
            <div className="row-actions">
              <button
                type="button"
                className={`btn ${connections[a.id] ? 'btn-quiet' : ''}`}
                disabled={busy !== null}
                onClick={() => change(a.id, !connections[a.id])}
              >
                {busy === a.id ? 'Working…' : connections[a.id] ? 'Disconnect' : `Connect to ${a.name}`}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {result?.message && <p className="ok small">{result.message}</p>}
      {result?.error && <p className="error">{result.error}</p>}

      {engines && (
        <div className="draft-engine">
          <div>
            <span className="toggle-label">Draft button uses</span>
            <span className="toggle-hint dim">
              {engines.chosen
                ? `The ✨ Draft buttons write replies with ${engines.chosen === 'codex' ? 'Codex' : 'Claude Code'} on this computer, using your own login.`
                : 'Install Codex or Claude Code to use the ✨ Draft buttons.'}
            </span>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Draft button uses">
            {[
              ['auto', 'Auto', true],
              ['codex', engines.codex ? 'Codex' : 'Codex (not found)', engines.codex],
              ['claude', engines.claude ? 'Claude Code' : 'Claude Code (not found)', engines.claude]
            ].map(([id, label, ok]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={engines.setting === id}
                className={engines.setting === id ? 'on' : ''}
                disabled={!ok}
                onClick={() => chooseEngine(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {prefs && <AiGuide prefs={prefs} onChange={(p) => onChange({ replyPrefs: p })} />}

      <h3 className="sub-title">Chats your AI can see</h3>
      {list.length === 0 && !filter ? (
        <p className="dim small">Your chats appear here once Telegram is connected or you're signed in to WhatsApp or Messenger.</p>
      ) : (
        <>
          <input className="search" placeholder="Find a chat" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul className="rows chat-access">
            {list.map((c) => (
              <li key={c.key} className="row">
                <label className="toggle">
                  <span>
                    <span className="toggle-label">{c.name}</span>
                    <span className="toggle-hint mono dim">{NAMES[c.service]}</span>
                  </span>
                  <input type="checkbox" role="switch" checked={aiCanSee({ ...ai, enabled: true }, c.key)} onChange={(e) => onToggleAi(c.key, e.target.checked)} />
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="sub-title">What your AI did</h3>
      {activity.length === 0 ? (
        <p className="dim small">Nothing yet.</p>
      ) : (
        <ul className="activity">
          {activity.slice(0, 15).map((a, i) => (
            <li key={`${a.at}-${i}`} className={a.ok ? '' : 'is-failed'}>
              <span className="mono dim">{new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
              <span>
                {TOOL_NAMES[a.tool] || a.tool}
                {a.chat_id ? `: ${names[a.chat_id] || a.chat_id}` : ''}
                {!a.ok && a.error ? ` (refused: ${a.error})` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
