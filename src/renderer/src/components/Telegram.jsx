import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { aiCanSee, chatKey } from '../../../main/ai-access.js'
import Hero from './Hero'
import Avatar from './Avatar'

export function shortTime(at) {
  if (!at) return ''
  const d = new Date(at)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = (now - d) / 86400e3
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function Shell({ title, accent, children }) {
  return (
    <section className="page" aria-label="Telegram">
      <Hero title={title} accent={accent} kicker="Telegram · direct" />
      {children}
    </section>
  )
}

function KeysSetup() {
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [error, setError] = useState(null)
  const save = async (e) => {
    e.preventDefault()
    setError(null)
    try {
      await window.iv.telegram.saveKeys(apiId, apiHash)
    } catch (err) {
      setError(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  return (
    <Shell title="Set up" accent="Telegram.">
      <p className="lead dim">
        IV Chat needs its own Telegram app keys. Sign in at{' '}
        <a className="link" href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">
          my.telegram.org
        </a>
        , open API development tools, create an app, then copy its api_id and api_hash here. They're stored encrypted on this
        computer.
      </p>
      <form className="form" onSubmit={save}>
        <label className="field">
          <span className="mono dim">api_id</span>
          <input inputMode="numeric" value={apiId} onChange={(e) => setApiId(e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span className="mono dim">api_hash</span>
          <input value={apiHash} onChange={(e) => setApiHash(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={!apiId || !apiHash}>
          Save keys
        </button>
      </form>
      <p className="dim small">For the public release these keys are built into IV Chat, so people won't see this step.</p>
    </Shell>
  )
}

function SignIn({ state }) {
  const [pw, setPw] = useState('')
  if (state.status === 'qr') {
    return (
      <Shell title="Scan to" accent="connect.">
        <div className="qr-wrap">
          {state.qr ? <img className="qr" src={state.qr} alt="Telegram sign-in QR code" /> : <div className="qr qr-wait dim">Getting a code…</div>}
          <ol className="steps">
            <li>Open Telegram on your phone.</li>
            <li>
              Go to <b>Settings</b>, then <b>Devices</b>, then <b>Link Desktop Device</b>.
            </li>
            <li>Point your phone at this code.</li>
          </ol>
        </div>
        {state.error && <p className="error">{state.error}</p>}
        <button type="button" className="btn" onClick={() => window.iv.telegram.cancel()}>
          Cancel
        </button>
      </Shell>
    )
  }
  if (state.status === 'password') {
    return (
      <Shell title="Two-step" accent="password.">
        <p className="lead dim">Your Telegram account has a password. Type it to finish connecting.</p>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            window.iv.telegram.password(pw)
            setPw('')
          }}
        >
          <label className="field">
            <span className="mono dim">Password{state.passwordHint ? ` (hint: ${state.passwordHint})` : ''}</span>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" />
          </label>
          {state.error && <p className="error">{state.error}</p>}
          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={!pw}>
              Continue
            </button>
            <button type="button" className="btn" onClick={() => window.iv.telegram.cancel()}>
              Cancel
            </button>
          </div>
        </form>
      </Shell>
    )
  }
  if (state.status === 'signed-out') {
    return (
      <Shell title="Connect" accent="Telegram.">
        <p className="lead dim">
          Connect your Telegram account to see your chats here and let your AI draft replies. You sign in by scanning a code
          with Telegram on your phone.
        </p>
        {state.error && <p className="error">{state.error}</p>}
        <button type="button" className="btn btn-primary" onClick={() => window.iv.telegram.signIn()}>
          Connect Telegram
        </button>
      </Shell>
    )
  }
  if (state.status === 'error') {
    return (
      <Shell title="Can't reach" accent="Telegram.">
        <p className="lead dim">Check your internet connection, then try again.</p>
        <p className="mono dim">{state.error}</p>
        <button type="button" className="btn btn-primary" onClick={() => window.iv.telegram.cancel()}>
          Try again
        </button>
      </Shell>
    )
  }
  return (
    <Shell title="Connecting" accent="…">
      <p className="dim">One moment.</p>
    </Shell>
  )
}

export function formatSize(bytes) {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}

const fileExt = (name) => (name && name.includes('.') ? name.split('.').pop() : '')

// If one message can't be drawn, show a note in its place instead of losing the whole window.
class SafeMessage extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? <span className="media-label mono">Couldn't show this message here</span> : this.props.children
  }
}

const KIND_LABEL = { photo: 'Photo', video: 'Video', voice: 'Voice message', audio: 'Audio', file: 'File', sticker: 'Sticker', other: 'Media' }

const clock = (sec) => {
  const s = Math.max(0, Math.round(sec || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const MAX_PLAY_BYTES = 25 * 1024 * 1024

// The quick reactions shown when hovering a message, and the emoji picker for the reply box.
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '🙏']
const EMOJI = (
  '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😜 🤪 🤗 🤔 🤨 😐 😏 😒 🙄 😬 😌 😔 😴 😷 🤒 ' +
  '🥳 😎 🤓 😕 😟 😮 😲 😳 🥺 😢 😭 😱 😤 😡 🤬 💀 👍 👎 👏 🙌 🙏 🤝 💪 👀 👋 ✌️ 🤞 👌 🤙 ❤️ 🧡 💛 💚 💙 💜 ' +
  '🖤 🤍 💔 💯 🔥 ✨ 🎉 🎊 🎂 🎁 ⭐ 🌟 ☀️ 🌙 ⚡ 🌈 ☕ 🍕 🍔 🍻 🥂 ⚽ 🏀 🎬 🎵 📸 💻 📱 💡 📌 ✅ ❌ ❓ ❗'
).split(' ')

function EmojiPicker({ onPick, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const away = (e) => !ref.current?.contains(e.target) && onClose()
    const esc = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])
  return (
    <div className="emoji-picker" ref={ref} role="dialog" aria-label="Emoji">
      {EMOJI.map((e) => (
        <button key={e} type="button" onClick={() => onPick(e)}>
          {e}
        </button>
      ))}
    </div>
  )
}

function Reactions({ m, onReact }) {
  if (!m.reactions?.length) return null
  return (
    <div className="reactions">
      {m.reactions.map((r, i) => (
        <button
          key={`${r.emoji}-${i}`}
          type="button"
          className={`reaction${r.mine ? ' mine' : ''}`}
          disabled={r.custom}
          title={r.mine ? 'Remove your reaction' : r.custom ? 'A custom emoji' : `React with ${r.emoji}`}
          onClick={() => onReact(m, r.mine ? null : r.emoji)}
        >
          <span className="reaction-emoji">{r.emoji}</span>
          {r.count > 1 || !r.mine ? <span className="reaction-count">{r.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

// A voice message or audio file, drawn like Telegram Desktop's: a round play button, the message's own
// waveform filling in as it plays (click to jump), the time, and a speed button. Nothing downloads until
// it's played; the audio then stays in memory. Only one plays at a time.
const SPEEDS = [1, 1.5, 2]

function AudioMessage({ dialogId, m, onSave, saving }) {
  const info = m.media
  const audioRef = useRef(null)
  const wantPlay = useRef(false)
  const wantSeek = useRef(null)
  const [src, setSrc] = useState(null)
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(info.duration || 0)
  const [speed, setSpeed] = useState(1)
  const [error, setError] = useState(null)
  const bars = info.bars?.length ? info.bars : Array.from({ length: 44 }, () => 0.4)
  const tooBig = info.size > MAX_PLAY_BYTES
  const label = info.kind === 'voice' ? 'Voice message' : info.name || 'Audio'

  // Starting another player pauses this one.
  useEffect(() => {
    const onOther = (e) => {
      if (e.detail !== audioRef.current) audioRef.current?.pause()
    }
    window.addEventListener('iv-audio-play', onOther)
    return () => window.removeEventListener('iv-audio-play', onOther)
  }, [])

  // Once the audio has arrived, jump to where the person clicked and start playing.
  useEffect(() => {
    const a = audioRef.current
    if (!a || !src) return
    a.playbackRate = speed
    if (wantSeek.current != null) {
      const go = () => {
        a.currentTime = wantSeek.current * (a.duration || length)
        wantSeek.current = null
      }
      if (a.readyState >= 1) go()
      else a.addEventListener('loadedmetadata', go, { once: true })
    }
    if (wantPlay.current) {
      wantPlay.current = false
      a.play().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  const load = async () => {
    if (src || loading) return
    setLoading(true)
    setError(null)
    try {
      setSrc(await window.iv.telegram.audio(dialogId, m.id))
    } catch (err) {
      wantPlay.current = false
      setError(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setLoading(false)
    }
  }

  const toggle = () => {
    const a = audioRef.current
    if (!src) {
      wantPlay.current = true
      return load()
    }
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }

  const seek = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    if (!src) {
      wantSeek.current = frac
      wantPlay.current = true
      return load()
    }
    const a = audioRef.current
    a.currentTime = frac * (a.duration || length)
    setTime(a.currentTime)
  }

  const nextSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
    setSpeed(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }

  const progress = length ? Math.min(1, time / length) : 0

  return (
    <div className={`voice${playing ? ' is-playing' : ''}`}>
      <button type="button" className="voice-play" onClick={toggle} disabled={tooBig} aria-label={playing ? `Pause ${label}` : `Play ${label}`}>
        {loading ? <span className="voice-spin" aria-hidden="true" /> : playing ? <span className="voice-pause" aria-hidden="true" /> : <span className="voice-tri" aria-hidden="true" />}
      </button>
      <div className="voice-main">
        <div
          className="voice-wave"
          role="slider"
          tabIndex={0}
          aria-label={`${label} position`}
          aria-valuemin={0}
          aria-valuemax={Math.round(length)}
          aria-valuenow={Math.round(time)}
          onClick={seek}
          onKeyDown={(e) => {
            const a = audioRef.current
            if (!a || !src) return
            if (e.key === 'ArrowRight') a.currentTime = Math.min(a.duration || length, a.currentTime + 3)
            if (e.key === 'ArrowLeft') a.currentTime = Math.max(0, a.currentTime - 3)
          }}
        >
          {bars.map((b, i) => (
            <span key={i} className={(i + 0.5) / bars.length <= progress ? 'on' : ''} style={{ height: `${Math.round(b * 100)}%` }} />
          ))}
        </div>
        <div className="voice-meta">
          <span className="mono">{clock(playing || time ? time : length)}</span>
          {info.kind === 'audio' && <span className="voice-name">{label}</span>}
          {tooBig && <span className="mono dim">Too large to play here</span>}
          {src && (
            <button type="button" className="voice-speed mono" onClick={nextSpeed} aria-label="Playback speed">
              {speed}×
            </button>
          )}
          {info.kind === 'audio' && (
            <button type="button" className="voice-speed mono" onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
        {error && <span className="media-label mono">{error}</span>}
      </div>
      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="auto"
          onPlay={(e) => {
            setPlaying(true)
            window.dispatchEvent(new CustomEvent('iv-audio-play', { detail: e.currentTarget }))
          }}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false)
            setTime(0)
          }}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setLength(e.currentTarget.duration)}
        />
      )}
    </div>
  )
}

// A photo, video, sticker, voice note or file inside a message. Pictures load on demand and stay in memory;
// Save downloads the full file to a place the person picks.
function Media({ dialogId, m }) {
  const info = m.media
  const [src, setSrc] = useState(null)
  const [saving, setSaving] = useState(false)
  const wantsPicture = info.kind === 'photo' || info.preview

  useEffect(() => {
    if (!wantsPicture) return
    let live = true
    window.iv.telegram
      .preview(dialogId, m.id)
      .then((url) => live && setSrc(url))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [dialogId, m.id, wantsPicture])

  const save = async () => {
    setSaving(true)
    try {
      await window.iv.telegram.save(dialogId, m.id)
    } catch {
      /* the person can try again */
    } finally {
      setSaving(false)
    }
  }

  if (info.kind === 'voice' || info.kind === 'audio') return <AudioMessage dialogId={dialogId} m={m} onSave={save} saving={saving} />

  if (info.kind === 'sticker') return src ? <img className="media-sticker" src={src} alt="Sticker" /> : <span className="media-label mono">Sticker</span>

  if (info.kind === 'photo' || (info.kind === 'video' && src)) {
    return (
      <button type="button" className={`media-photo${info.kind === 'video' ? ' is-video' : ''}`} onClick={save} title="Save the full size to your computer">
        {src ? <img src={src} alt={KIND_LABEL[info.kind]} /> : <span className="media-wait mono">Loading {KIND_LABEL[info.kind].toLowerCase()}…</span>}
        {info.kind === 'video' && <span className="media-play" aria-hidden="true">▶</span>}
        <span className="media-save mono">{saving ? 'Saving…' : 'Save'}</span>
      </button>
    )
  }

  return (
    <div className="media-file">
      {src ? <img className="media-file-thumb" src={src} alt="" /> : <span className="media-file-icon mono">{(fileExt(info.name) || KIND_LABEL[info.kind] || 'File').slice(0, 4)}</span>}
      <span className="media-file-main">
        <span className="media-file-name">{info.name || info.label || KIND_LABEL[info.kind] || 'Attachment'}</span>
        <span className="mono dim">{[KIND_LABEL[info.kind], formatSize(info.size)].filter(Boolean).join(' · ')}</span>
      </span>
      {info.kind !== 'other' && (
        <button type="button" className="btn btn-quiet" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
    </div>
  )
}

function Conversation({ dialog, ai, draft, onToggleAi, refreshTick }) {
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [fromAi, setFromAi] = useState(false)
  const [pendingDraft, setPendingDraft] = useState(null)
  const [error, setError] = useState(null)
  const [sending, setSending] = useState(false)
  const [attachment, setAttachment] = useState(null)
  const [reactingTo, setReactingTo] = useState(null)
  const [picker, setPicker] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [draftedBy, setDraftedBy] = useState(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const stick = useRef(true)
  const key = chatKey('telegram', dialog.id)

  const load = useCallback(async () => {
    const list = await window.iv.telegram.messages(dialog.id)
    setMessages(list)
    setLoading(false)
  }, [dialog.id])

  useEffect(() => {
    setLoading(true)
    setMessages([])
    setText('')
    setFromAi(false)
    setPendingDraft(null)
    setAttachment(null)
    stick.current = true
    load()
    window.iv.telegram.markRead(dialog.id)
    return window.iv.telegram.onMessage((id) => {
      if (id === dialog.id) {
        load()
        window.iv.telegram.markRead(dialog.id)
      }
    })
  }, [dialog.id, load])

  // An AI draft fills an empty reply box; if the person is already typing, it waits to be chosen.
  useEffect(() => {
    if (!draft) return
    if (!text.trim()) {
      setText(draft)
      setFromAi(true)
    } else if (draft !== text) {
      setPendingDraft(draft)
    }
    // Only react to new drafts, not to typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  // "Refresh all" in the top bar reloads the open conversation too.
  useEffect(() => {
    if (refreshTick) load()
  }, [refreshTick, load])

  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // The reply box grows with what's in it, wrapped lines included, up to about a third of the window,
  // and only scrolls inside itself past that.
  useLayoutEffect(() => {
    const box = inputRef.current
    if (!box) return
    const fit = () => {
      box.style.height = 'auto'
      box.style.height = `${Math.min(box.scrollHeight + 2, Math.max(88, Math.round(window.innerHeight * 0.34)))}px`
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [text])

  const older = async () => {
    if (!messages.length) return
    stick.current = false
    const more = await window.iv.telegram.messages(dialog.id, { beforeId: messages[0].id })
    setMessages((m) => [...more, ...m])
  }

  // Reacting is the person's own click, the same as sending. One reaction per message; null removes it.
  const react = async (m, emoji) => {
    setReactingTo(null)
    setError(null)
    try {
      await window.iv.telegram.react(dialog.id, m.id, emoji)
      setMessages((list) =>
        list.map((x) => {
          if (x.id !== m.id) return x
          const rest = (x.reactions || [])
            .map((r) => (r.mine ? { ...r, mine: false, count: r.count - 1 } : r))
            .filter((r) => r.count > 0)
          if (!emoji) return { ...x, reactions: rest }
          const hit = rest.find((r) => r.emoji === emoji)
          return { ...x, reactions: hit ? rest.map((r) => (r === hit ? { ...r, mine: true, count: r.count + 1 } : r)) : [...rest, { emoji, count: 1, mine: true }] }
        })
      )
    } catch (err) {
      const msg = String(err.message || err)
      setError(/REACTION|INVALID|not allowed/i.test(msg) ? "That reaction isn't allowed in this chat." : "Couldn't react. Check your connection and try again.")
    }
  }

  // The Draft button: the person's own Codex or Claude writes a reply from this chat's recent messages.
  // Whatever is already typed is passed along as "what I want to say". Nothing is sent.
  const draftWithAi = async () => {
    if (drafting) return window.iv.draft.cancel()
    setDrafting(true)
    setError(null)
    try {
      const { text: reply, engine } = await window.iv.draft.telegram(dialog.id, text.trim())
      if (reply) {
        setText(reply)
        setFromAi(true)
        setDraftedBy(engine)
      }
    } catch (err) {
      const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      if (msg !== 'Cancelled') setError(msg)
    } finally {
      setDrafting(false)
    }
  }

  const insertEmoji = (emoji) => {
    const el = inputRef.current
    const at = el ? el.selectionStart : text.length
    const end = el ? el.selectionEnd : text.length
    const next = text.slice(0, at) + emoji + text.slice(end)
    setText(next)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + emoji.length, at + emoji.length)
    })
  }

  const attach = async () => {
    setError(null)
    try {
      const picked = await window.iv.telegram.pickFile()
      if (picked) setAttachment(picked)
    } catch (err) {
      setError(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const send = async () => {
    const body = text.trim()
    if ((!body && !attachment) || sending) return
    setSending(true)
    setError(null)
    try {
      // With a file attached, the text goes with it as its caption.
      if (attachment) await window.iv.telegram.sendFile(dialog.id, attachment.token, body)
      else await window.iv.telegram.send(dialog.id, body)
      setAttachment(null)
      setText('')
      setFromAi(false)
      window.iv.ai.clearDraft(key)
      stick.current = true
      await load()
    } catch (err) {
      setError("Couldn't send. Check your connection and try again.")
    } finally {
      setSending(false)
    }
  }

  const shared = aiCanSee(ai, key)

  return (
    <div className="convo">
      <header className="convo-head">
        <Avatar name={dialog.name} size={42} />
        <div className="convo-who">
          <h2 className="convo-name">{dialog.name}</h2>
          <span className="mono dim">{dialog.kind}</span>
        </div>
        <label className="toggle toggle-inline" title="Whether your AI (Codex or Claude) can read this chat and draft replies">
          <span className="toggle-label small">AI can see this chat</span>
          <input type="checkbox" role="switch" checked={shared} disabled={!ai.enabled} onChange={(e) => onToggleAi(key, e.target.checked)} />
        </label>
      </header>
      <div
        className="convo-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {!loading && messages.length >= 40 && (
          <button type="button" className="btn btn-quiet older" onClick={older}>
            Load older messages
          </button>
        )}
        {loading && <p className="dim small center">Loading…</p>}
        {messages.map((m) => (
          <div key={m.id} className={`bubble${m.outgoing ? ' is-out' : ''}${reactingTo === m.id ? ' is-reacting' : ''}`}>
            <button
              type="button"
              className="react-btn"
              aria-label="React to this message"
              title="React"
              onClick={() => setReactingTo(reactingTo === m.id ? null : m.id)}
            >
              ☺
            </button>
            {reactingTo === m.id && (
              <div className="react-bar" role="menu" aria-label="Reactions">
                {QUICK_REACTIONS.map((e) => (
                  <button key={e} type="button" role="menuitem" onClick={() => react(m, e)}>
                    {e}
                  </button>
                ))}
              </div>
            )}
            {!m.outgoing && dialog.kind !== 'person' && m.from && <span className="bubble-from mono">{m.from}</span>}
            {m.media ? (
              <>
                <SafeMessage>
                  <Media dialogId={dialog.id} m={m} />
                </SafeMessage>
                {m.caption && <span className="bubble-text">{m.caption}</span>}
              </>
            ) : (
              <span className="bubble-text">{m.text}</span>
            )}
            <Reactions m={m} onReact={react} />
            <span className="bubble-time mono">{shortTime(m.at)}</span>
          </div>
        ))}
      </div>
      <div className="composer">
        {pendingDraft && (
          <div className="draft-banner">
            <span>Your AI drafted a reply.</span>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setText(pendingDraft)
                setFromAi(true)
                setPendingDraft(null)
              }}
            >
              Use draft
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setPendingDraft(null)}>
              Dismiss
            </button>
          </div>
        )}
        {drafting && <p className="draft-note mono">Drafting a reply… click Draft again to stop.</p>}
        {!drafting && fromAi && text && (
          <p className="draft-note mono">Draft from {draftedBy || 'your AI'}. Edit it, then press Enter to send.</p>
        )}
        {error && <p className="error">{error}</p>}
        {attachment && (
          <div className="attach-chip">
            <span className="mono">{attachment.image ? 'Picture' : 'File'}</span>
            <span className="attach-name">{attachment.name}</span>
            <span className="mono dim">{formatSize(attachment.size)}</span>
            <button type="button" className="attach-remove" onClick={() => setAttachment(null)} aria-label="Remove the attachment">
              ×
            </button>
          </div>
        )}
        <div className="composer-row">
          <button type="button" className="btn btn-quiet attach-btn" onClick={attach} title="Attach a picture or file" aria-label="Attach a picture or file">
            +
          </button>
          <div className="emoji-wrap">
            <button type="button" className="btn btn-quiet attach-btn" onClick={() => setPicker((v) => !v)} title="Emoji" aria-label="Emoji" aria-expanded={picker}>
              😊
            </button>
            {picker && <EmojiPicker onPick={insertEmoji} onClose={() => setPicker(false)} />}
          </div>
          <textarea
            ref={inputRef}
            value={text}
            placeholder={attachment ? 'Add a caption (optional)' : `Message ${dialog.name}`}
            rows={1}
            onChange={(e) => {
              setText(e.target.value)
              if (!e.target.value) {
                setFromAi(false)
                setDraftedBy(null)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          <button
            type="button"
            className={`btn draft-btn${drafting ? ' is-busy' : ''}`}
            onClick={draftWithAi}
            title={text.trim() ? 'Draft a reply from what you typed, with your AI' : 'Draft a reply with your AI'}
          >
            <span aria-hidden="true">✨</span> {drafting ? 'Stop' : 'Draft'}
          </button>
          <button type="button" className="btn btn-primary" onClick={send} disabled={(!text.trim() && !attachment) || sending}>
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

function Chats({ dialogs, ai, drafts, openId, setOpenId, onToggleAi, refreshTick }) {
  const sorted = [...dialogs].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  const open = sorted.find((d) => d.id === openId)
  return (
    <div className="tg">
      <ul className="tg-list" aria-label="Telegram chats">
        {sorted.map((d) => {
          const key = chatKey('telegram', d.id)
          return (
            <li key={d.id}>
              <button type="button" className={`tg-item${d.id === openId ? ' is-active' : ''}`} onClick={() => setOpenId(d.id)}>
                <Avatar name={d.name} />
                <span className="tg-main">
                  <span className={`latest-name${d.unread ? ' is-unread' : ''}`}>
                    {d.name}
                    {aiCanSee(ai, key) && <span className="ai-dot" title="Your AI can see this chat" />}
                  </span>
                  <span className="latest-preview dim">{drafts[key] ? <span className="accent">Draft: </span> : null}{drafts[key] || d.preview}</span>
                </span>
                <span className="latest-meta">
                  <span className="mono dim">{shortTime(d.at)}</span>
                  {d.unread > 0 && <span className="latest-badge">{d.unread}</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {open ? (
        <Conversation
          key={open.id}
          dialog={open}
          ai={ai}
          draft={drafts[chatKey('telegram', open.id)]}
          onToggleAi={onToggleAi}
          refreshTick={refreshTick}
        />
      ) : (
        <div className="convo convo-empty dim">Choose a chat.</div>
      )}
    </div>
  )
}

export default function Telegram({ state, dialogs, ai, drafts, openId, setOpenId, onToggleAi, refreshTick }) {
  if (!state) return null
  if (state.status === 'needs-keys') return <KeysSetup />
  if (state.status !== 'ready') return <SignIn state={state} />
  return <Chats dialogs={dialogs} ai={ai} drafts={drafts} openId={openId} setOpenId={setOpenId} onToggleAi={onToggleAi} refreshTick={refreshTick} />
}
