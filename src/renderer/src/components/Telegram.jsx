import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { aiCanSee, chatKey } from '../../../main/ai-access.js'
import Hero from './Hero'
import { TelegramAvatar } from './Avatar'
import RichText from './tg/RichText'
import VoiceRecorder from './tg/VoiceRecorder'
import ChatList, { shortTime } from './tg/ChatList'
import InfoPanel from './tg/InfoPanel'
import { LinkCard, Media, PhotoViewer, SafeMessage, formatSize } from './tg/TgMedia'

export { shortTime }

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

// ---------- small pieces ----------

// The quick reactions shown when hovering a message, and the emoji picker for the reply box.
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '🙏']
const EMOJI = (
  '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😜 🤪 🤗 🤔 🤨 😐 😏 😒 🙄 😬 😌 😔 😴 😷 🤒 ' +
  '🥳 😎 🤓 😕 😟 😮 😲 😳 🥺 😢 😭 😱 😤 😡 🤬 💀 👍 👎 👏 🙌 🙏 🤝 💪 👀 👋 ✌️ 🤞 👌 🤙 ❤️ 🧡 💛 💚 💙 💜 ' +
  '🖤 🤍 💔 💯 🔥 ✨ 🎉 🎊 🎂 🎁 ⭐ 🌟 ☀️ 🌙 ⚡ 🌈 ☕ 🍕 🍔 🍻 🥂 ⚽ 🏀 🎬 🎵 📸 💻 📱 💡 📌 ✅ ❌ ❓ ❗'
).split(' ')

const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// Closes a pop-up on a click elsewhere or Escape.
function useDismiss(ref, onClose) {
  useEffect(() => {
    const away = (e) => !ref.current?.contains(e.target) && onClose()
    const esc = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [ref, onClose])
}

function EmojiPicker({ onPick, onClose }) {
  const ref = useRef(null)
  useDismiss(ref, onClose)
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

function dayLabel(at) {
  const d = new Date(at)
  const now = new Date()
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400e3)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' })
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

// Day separators, service lines ("Sam joined the group") and albums (several pictures sent together) shown
// as one grid.
function buildRows(messages) {
  const rows = []
  let lastDay = ''
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const day = new Date(m.at).toDateString()
    if (day !== lastDay) {
      rows.push({ type: 'day', key: `d${m.id}`, at: m.at })
      lastDay = day
    }
    if (m.service) {
      rows.push({ type: 'service', key: `s${m.id}`, m })
      continue
    }
    if (m.album && m.media) {
      const group = [m]
      while (i + 1 < messages.length && messages[i + 1].album === m.album) group.push(messages[++i])
      if (group.length > 1) {
        // The album answers to its captioned message (or its last one) for reactions, replies and the menu.
        const lead = group.find((x) => x.body) || group[group.length - 1]
        rows.push({ type: 'msg', key: `a${m.id}`, m: lead, group })
        continue
      }
    }
    rows.push({ type: 'msg', key: `m${m.id}`, m })
  }
  return rows
}

// Edit is allowed on your own text messages: always in Saved Messages, otherwise for 48 hours, as Telegram does.
const canEdit = (m, dialog) => m.outgoing && (m.body || m.caption) && !m.forwarded && (dialog.kind === 'saved' || Date.now() - m.at < 48 * 3600e3)
const canDelete = (m, dialog) => m.outgoing || dialog.kind === 'saved' || dialog.kind === 'person'

function MessageMenu({ at, m, dialog, onClose, onAction }) {
  const ref = useRef(null)
  useDismiss(ref, onClose)
  const items = [
    ['reply', 'Reply'],
    m.body || m.caption ? ['copy', 'Copy text'] : null,
    ['forward', 'Forward'],
    dialog.kind !== 'channel' || m.outgoing ? ['pin', m.pinned ? 'Unpin' : 'Pin'] : null,
    canEdit(m, dialog) ? ['edit', 'Edit'] : null,
    m.media && m.media.kind !== 'other' ? ['save', 'Save to computer'] : null,
    canDelete(m, dialog) ? ['delete', 'Delete'] : null
  ].filter(Boolean)
  const style = { left: Math.min(at.x, window.innerWidth - 200), top: Math.min(at.y, window.innerHeight - items.length * 36 - 16) }
  return (
    <div className="msg-menu" ref={ref} role="menu" style={style}>
      {items.map(([id, label]) => (
        <button key={id} type="button" role="menuitem" className={id === 'delete' ? 'is-danger' : ''} onClick={() => onAction(id)}>
          {label}
        </button>
      ))}
    </div>
  )
}

function Modal({ title, children, onClose }) {
  const ref = useRef(null)
  useDismiss(ref, onClose)
  return (
    <div className="modal-back">
      <div className="modal" ref={ref} role="dialog" aria-label={title}>
        <h3 className="modal-title">{title}</h3>
        {children}
      </div>
    </div>
  )
}

function DeleteDialog({ count, dialog, outgoing, onConfirm, onClose }) {
  const [everyone, setEveryone] = useState(false)
  const offer = dialog.kind !== 'saved' && dialog.kind !== 'channel' && (outgoing || dialog.kind === 'person')
  return (
    <Modal title={count > 1 ? `Delete ${count} messages?` : 'Delete this message?'} onClose={onClose}>
      {offer && (
        <label className="check">
          <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
          <span>{dialog.kind === 'person' ? `Also delete for ${dialog.name}` : 'Delete for everyone'}</span>
        </label>
      )}
      {!offer && <p className="dim small">{dialog.kind === 'channel' ? 'It will be deleted from the channel.' : 'It will be deleted from Saved Messages on all your devices.'}</p>}
      <div className="row-actions">
        <button type="button" className="btn btn-danger" onClick={() => onConfirm(dialog.kind === 'channel' || everyone)}>
          Delete
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

function ForwardDialog({ dialogs, onPick, onClose }) {
  const [q, setQ] = useState('')
  const list = [...dialogs]
    .filter((d) => d.kind !== 'channel' && d.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (a.kind === 'saved' ? -1 : b.kind === 'saved' ? 1 : (b.at ?? 0) - (a.at ?? 0)))
    .slice(0, 60)
  return (
    <Modal title="Forward to…" onClose={onClose}>
      <input className="modal-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" autoFocus />
      <ul className="pick-list">
        {list.map((d) => (
          <li key={d.id}>
            <button type="button" className="pick-item" onClick={() => onPick(d)}>
              <TelegramAvatar dialog={d} size={30} />
              <span>{d.name}</span>
            </button>
          </li>
        ))}
        {!list.length && <li className="dim small">No chats match.</li>}
      </ul>
    </Modal>
  )
}

// ---------- one message ----------

function Bubble({ m, group, dialog, flash, reacting, onReactToggle, onReact, onMenu, onJump, onOpenPhoto }) {
  const album = group && group.length > 1
  const sticker = !album && m.media && /^sticker|^round$/.test(m.media.kind) && !m.body
  const text = album ? group.find((x) => x.body) : m
  const showText = album ? Boolean(text) : m.media ? Boolean(m.caption) : true
  return (
    <div
      id={`tg-msg-${m.id}`}
      className={`bubble${m.outgoing ? ' is-out' : ''}${reacting ? ' is-reacting' : ''}${flash ? ' is-flash' : ''}${sticker ? ' is-bare' : ''}${album ? ' is-album' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(m, group, { x: e.clientX, y: e.clientY })
      }}
    >
      <div className="bubble-tools">
        <button type="button" className="react-btn" aria-label="React to this message" title="React" onClick={() => onReactToggle(m.id)}>
          ☺
        </button>
        <button
          type="button"
          className="react-btn"
          aria-label="More actions"
          title="Reply, forward, pin, edit, delete"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            onMenu(m, group, { x: r.left, y: r.bottom + 4 })
          }}
        >
          ⋯
        </button>
      </div>
      {reacting && (
        <div className="react-bar" role="menu" aria-label="Reactions">
          {QUICK_REACTIONS.map((e) => (
            <button key={e} type="button" role="menuitem" onClick={() => onReact(m, e)}>
              {e}
            </button>
          ))}
        </div>
      )}
      {!m.outgoing && dialog.kind !== 'person' && dialog.kind !== 'saved' && m.from && <span className="bubble-from mono">{m.from}</span>}
      {m.forwarded && <span className="bubble-fwd mono">Forwarded from {m.forwarded}</span>}
      {m.reply && (
        <button type="button" className="bubble-reply" onClick={() => onJump(m.reply.id)} title="Go to the message this replies to">
          <span className="bubble-reply-from mono">{m.reply.from || 'Reply'}</span>
          <span className="bubble-reply-text">{m.reply.text}</span>
        </button>
      )}
      {album ? (
        <div className={`album album-${Math.min(group.length, 4)}`}>
          {group.map((x) => (
            <SafeMessage key={x.id}>
              <Media dialogId={dialog.id} m={x} onOpenPhoto={onOpenPhoto} inAlbum />
            </SafeMessage>
          ))}
        </div>
      ) : (
        m.media && (
          <SafeMessage>
            <Media dialogId={dialog.id} m={m} onOpenPhoto={onOpenPhoto} />
          </SafeMessage>
        )
      )}
      {showText && <RichText text={album ? text.body : m.body || m.text} entities={album ? text.entities : m.entities} />}
      {m.link && !m.media && (
        <SafeMessage>
          <LinkCard dialogId={dialog.id} m={m} />
        </SafeMessage>
      )}
      <Reactions m={m} onReact={onReact} />
      <span className="bubble-time mono">
        {m.pinned && <span title="Pinned">📌 </span>}
        {m.edited && 'edited · '}
        {shortClock(m.at)}
        {m.outgoing && (
          <span className={`tick${m.read ? ' is-read' : ''}`} title={m.read ? 'Read' : 'Sent'}>
            {m.read ? ' ✓✓' : ' ✓'}
          </span>
        )}
      </span>
    </div>
  )
}

const shortClock = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// ---------- the conversation ----------

function Conversation({ dialog, dialogs, ai, draft, onToggleAi, refreshTick }) {
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [hasOlder, setHasOlder] = useState(true)
  const [detached, setDetached] = useState(false) // showing an older stretch, not the latest messages
  const [unseen, setUnseen] = useState(0)
  const [atBottom, setAtBottom] = useState(true)
  const [text, setText] = useState('')
  const [fromAi, setFromAi] = useState(false)
  const [pendingDraft, setPendingDraft] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [sending, setSending] = useState(false)
  const [attachment, setAttachment] = useState(null)
  const [reactingTo, setReactingTo] = useState(null)
  const [picker, setPicker] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [draftedBy, setDraftedBy] = useState(null)
  const [replyTo, setReplyTo] = useState(null)
  const [editing, setEditing] = useState(null)
  const [menu, setMenu] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [forwarding, setForwarding] = useState(null)
  const [viewer, setViewer] = useState(null)
  const [flash, setFlash] = useState(null)
  const [info, setInfo] = useState({})
  const [typing, setTyping] = useState(null)
  const [pinned, setPinned] = useState(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [recording, setRecording] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const stick = useRef(true)
  const restore = useRef(null)
  const loadingOlder = useRef(false)
  const detachedRef = useRef(false)
  const key = chatKey('telegram', dialog.id)

  const say = (msg) => {
    setNotice(msg)
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 3500)
  }

  // The latest page, merged with any older messages already loaded above it.
  const load = useCallback(async () => {
    const fresh = await window.iv.telegram.messages(dialog.id)
    setMessages((prev) => {
      const first = fresh[0]?.id ?? Infinity
      return [...prev.filter((x) => x.id < first), ...fresh]
    })
    setLoading(false)
  }, [dialog.id])

  const refreshHeader = useCallback(() => {
    window.iv.telegram.chatInfo(dialog.id).then(setInfo).catch(() => {})
    window.iv.telegram.pinned(dialog.id).then(setPinned).catch(() => {})
  }, [dialog.id])

  useEffect(() => {
    setLoading(true)
    setMessages([])
    setText('')
    setFromAi(false)
    setPendingDraft(null)
    setAttachment(null)
    setReplyTo(null)
    setEditing(null)
    setDetached(false)
    detachedRef.current = false
    setHasOlder(true)
    setUnseen(0)
    stick.current = true
    load()
    refreshHeader()
    window.iv.telegram.markRead(dialog.id)
    const offMessage = window.iv.telegram.onMessage((id) => {
      if (id !== dialog.id && id !== '*') return
      if (detachedRef.current) {
        if (id === dialog.id) setUnseen((n) => n + 1)
        return
      }
      if (!stick.current && id === dialog.id) setUnseen((n) => n + 1)
      load()
      window.iv.telegram.pinned(dialog.id).then(setPinned).catch(() => {})
      if (id === dialog.id) window.iv.telegram.markRead(dialog.id)
    })
    const offTyping = window.iv.telegram.onTyping((t) => {
      if (t.chatId !== dialog.id) return
      setTyping(t.text ? t : null)
    })
    const offStatus = window.iv.telegram.onStatus((id) => id === dialog.id && refreshHeader())
    // "last seen 5 minutes ago" keeps counting.
    const tick = setInterval(refreshHeader, 60_000)
    return () => {
      offMessage()
      offTyping()
      offStatus()
      clearInterval(tick)
    }
  }, [dialog.id, load, refreshHeader])

  // A typing note fades by itself if no update follows.
  useEffect(() => {
    if (!typing) return
    const t = setTimeout(() => setTyping(null), Math.max(500, typing.until - Date.now()))
    return () => clearTimeout(t)
  }, [typing])

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
    if (!el) return
    if (restore.current != null) {
      // Older messages were added above: keep the reading position where it was.
      el.scrollTop = el.scrollHeight - restore.current
      restore.current = null
    } else if (stick.current) el.scrollTop = el.scrollHeight
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
    if (!messages.length || loadingOlder.current || !hasOlder) return
    loadingOlder.current = true
    try {
      const el = listRef.current
      const more = await window.iv.telegram.messages(dialog.id, { beforeId: messages[0].id })
      if (!more.length) setHasOlder(false)
      if (el) restore.current = el.scrollHeight - el.scrollTop
      stick.current = false
      setMessages((list) => [...more.filter((x) => x.id < (list[0]?.id ?? Infinity)), ...list])
    } finally {
      loadingOlder.current = false
    }
  }

  const onScroll = (e) => {
    const el = e.currentTarget
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    stick.current = bottom && !detachedRef.current
    setAtBottom(bottom)
    if (bottom && !detachedRef.current) setUnseen(0)
    if (el.scrollTop < 120) older()
  }

  const toLatest = async () => {
    if (detachedRef.current) {
      detachedRef.current = false
      setDetached(false)
      setMessages([])
      stick.current = true
      await load()
    }
    stick.current = true
    setUnseen(0)
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  // Scrolls to a message and flashes it, loading the stretch around it if it isn't on screen.
  const jumpTo = async (msgId) => {
    setResults(null)
    let el = document.getElementById(`tg-msg-${msgId}`)
    if (!el) {
      try {
        const around = await window.iv.telegram.messages(dialog.id, { aroundId: msgId })
        if (!around.some((x) => x.id === msgId)) return say('That message is no longer available.')
        detachedRef.current = true
        setDetached(true)
        stick.current = false
        setHasOlder(true)
        setMessages(around)
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        el = document.getElementById(`tg-msg-${msgId}`)
      } catch (err) {
        return setError(clean(err))
      }
    }
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlash(msgId)
    setTimeout(() => setFlash((f) => (f === msgId ? null : f)), 1800)
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
          const rest = (x.reactions || []).map((r) => (r.mine ? { ...r, mine: false, count: r.count - 1 } : r)).filter((r) => r.count > 0)
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

  const startEdit = (m) => {
    setReplyTo(null)
    setAttachment(null)
    setEditing(m)
    setText(m.body || m.caption || '')
    setFromAi(false)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const cancelCompose = () => {
    if (editing) setText('')
    setEditing(null)
    setReplyTo(null)
  }

  const onAction = async (action) => {
    const { m, group } = menu
    const ids = group?.length ? group.map((x) => x.id) : [m.id]
    setMenu(null)
    setError(null)
    try {
      if (action === 'reply') {
        setEditing(null)
        setReplyTo(m)
        inputRef.current?.focus()
      } else if (action === 'copy') {
        await window.iv.app.copy(m.body || m.caption || '')
        say('Copied.')
      } else if (action === 'forward') setForwarding(ids)
      else if (action === 'pin') {
        await window.iv.telegram.pin(dialog.id, m.id, m.pinned)
        setMessages((list) => list.map((x) => (x.id === m.id ? { ...x, pinned: !m.pinned } : x)))
        refreshHeader()
      } else if (action === 'edit') startEdit(m)
      else if (action === 'save') await window.iv.telegram.save(dialog.id, m.id)
      else if (action === 'delete') setConfirmDelete({ ids, outgoing: m.outgoing })
    } catch (err) {
      setError(/CHAT_ADMIN_REQUIRED|RIGHT_FORBIDDEN/.test(String(err)) ? "You don't have permission to do that in this chat." : clean(err))
    }
  }

  const doDelete = async (everyone) => {
    const { ids } = confirmDelete
    setConfirmDelete(null)
    try {
      await window.iv.telegram.remove(dialog.id, ids, everyone)
      setMessages((list) => list.filter((x) => !ids.includes(x.id)))
    } catch (err) {
      setError(clean(err))
    }
  }

  const doForward = async (to) => {
    const ids = forwarding
    setForwarding(null)
    try {
      await window.iv.telegram.forward(dialog.id, ids, to.id)
      say(`Forwarded to ${to.name}.`)
      if (to.id === dialog.id) load()
    } catch (err) {
      setError(clean(err))
    }
  }

  const runSearch = async (e) => {
    e?.preventDefault()
    if (!query.trim()) return setResults(null)
    try {
      setResults(await window.iv.telegram.search(dialog.id, query.trim()))
    } catch (err) {
      setError(clean(err))
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
      const msg = clean(err)
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
      setError(clean(err))
    }
  }

  // A file dropped on the chat, or a picture pasted into the reply box, waits as the attachment.
  const takeFile = async (file) => {
    setError(null)
    try {
      const where = window.iv.telegram.pathFor(file)
      const staged = where ? await window.iv.telegram.stagePath(where) : await window.iv.telegram.stageBytes(file.name || 'pasted.png', await file.arrayBuffer())
      setEditing(null)
      setAttachment(staged)
      inputRef.current?.focus()
    } catch (err) {
      setError(clean(err))
    }
  }

  const send = async () => {
    const body = text.trim()
    if ((!body && !attachment) || sending) return
    setSending(true)
    setError(null)
    try {
      if (editing) {
        await window.iv.telegram.edit(dialog.id, editing.id, body)
        setMessages((list) => list.map((x) => (x.id === editing.id ? { ...x, body, caption: body, text: body, entities: [], edited: true } : x)))
        setEditing(null)
        setText('')
        return
      }
      const opts = { replyTo: replyTo?.id }
      // With a file attached, the text goes with it as its caption.
      if (attachment) await window.iv.telegram.sendFile(dialog.id, attachment.token, body, opts)
      else await window.iv.telegram.send(dialog.id, body, opts)
      setAttachment(null)
      setReplyTo(null)
      setText('')
      setFromAi(false)
      window.iv.ai.clearDraft(key)
      if (detachedRef.current) await toLatest()
      stick.current = true
      await load()
    } catch (err) {
      setError(editing ? `Couldn't save the edit: ${clean(err)}` : "Couldn't send. Check your connection and try again.")
    } finally {
      setSending(false)
    }
  }

  // A recorded voice message, sent by the person's own Send click in the recording bar.
  const sendVoice = async (bytes, wave) => {
    setError(null)
    try {
      await window.iv.telegram.sendVoice(dialog.id, bytes, wave, { replyTo: replyTo?.id })
      setReplyTo(null)
      setRecording(false)
      if (detachedRef.current) await toLatest()
      stick.current = true
      await load()
    } catch (err) {
      setRecording(false)
      setError(`Couldn't send the voice message: ${clean(err)}`)
    }
  }

  const shared = aiCanSee(ai, key)
  const rows = buildRows(messages)
  const lastOwn = [...messages].reverse().find((x) => canEdit(x, dialog))

  return (
    <div
      className={`convo${dragging ? ' is-dropping' : ''}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const file = e.dataTransfer.files?.[0]
        if (file) takeFile(file)
      }}
    >
      <header className="convo-head">
        <button type="button" className="convo-who-btn" onClick={() => setInfoOpen((v) => !v)} title="Chat info" aria-label={`About ${dialog.name}`}>
          <TelegramAvatar dialog={dialog} size={42} />
        </button>
        <div className="convo-who" onClick={() => setInfoOpen((v) => !v)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setInfoOpen((v) => !v)}>
          <h2 className="convo-name">{dialog.name}</h2>
          {typing ? <span className="mono typing">{typing.text}…</span> : <span className={`mono dim${info.subtitle === 'online' ? ' is-online' : ''}`}>{info.subtitle || dialog.kind}</span>}
        </div>
        <button type="button" className={`btn btn-quiet head-btn${searchOpen ? ' is-on' : ''}`} onClick={() => setSearchOpen((v) => !v)} title="Search this chat" aria-label="Search this chat">
          ⌕
        </button>
        <button type="button" className={`btn btn-quiet head-btn${infoOpen ? ' is-on' : ''}`} onClick={() => setInfoOpen((v) => !v)} title="Chat info, shared media and files" aria-label="Chat info">
          ⓘ
        </button>
        <label className="toggle toggle-inline" title="Whether your AI (Codex or Claude) can read this chat and draft replies">
          <span className="toggle-label small">AI can see this chat</span>
          <input type="checkbox" role="switch" checked={shared} disabled={!ai.enabled} onChange={(e) => onToggleAi(key, e.target.checked)} />
        </label>
      </header>
      {searchOpen && (
        <form className="convo-search" onSubmit={runSearch}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${dialog.name}`}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchOpen(false)
                setResults(null)
              }
            }}
          />
          <button type="submit" className="btn btn-quiet">
            Search
          </button>
          {results && (
            <ul className="search-results">
              {results.length ? (
                results.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => jumpTo(r.id)}>
                      <span className="mono dim">
                        {r.from} · {shortTime(r.at)}
                      </span>
                      <span>{r.text}</span>
                    </button>
                  </li>
                ))
              ) : (
                <li className="dim small">Nothing found.</li>
              )}
            </ul>
          )}
        </form>
      )}
      {pinned && (
        <button type="button" className="pinned-bar" onClick={() => jumpTo(pinned.id)} title="Go to the pinned message">
          <span className="mono accent">Pinned</span>
          <span className="pinned-text">{pinned.text}</span>
        </button>
      )}
      <div className="convo-list" ref={listRef} onScroll={onScroll} onClick={() => reactingTo && setReactingTo(null)}>
        {loading && <p className="dim small center">Loading…</p>}
        {!loading && !hasOlder && <p className="dim small center">The beginning of this chat.</p>}
        {rows.map((r) =>
          r.type === 'day' ? (
            <div key={r.key} className="day-sep mono">
              <span>{dayLabel(r.at)}</span>
            </div>
          ) : r.type === 'service' ? (
            <div key={r.key} className="service-line">
              {r.m.from && r.m.from !== 'You' ? `${r.m.from} ` : r.m.from === 'You' ? 'You ' : ''}
              {r.m.service}
            </div>
          ) : (
            <Bubble
              key={r.key}
              m={r.m}
              group={r.group}
              dialog={dialog}
              flash={flash === r.m.id || r.group?.some((x) => x.id === flash)}
              reacting={reactingTo === r.m.id}
              onReactToggle={(id) => setReactingTo(reactingTo === id ? null : id)}
              onReact={react}
              onMenu={(m, group, at) => setMenu({ m, group, at })}
              onJump={jumpTo}
              onOpenPhoto={setViewer}
            />
          )
        )}
      </div>
      {(!atBottom || detached) && (
        <button type="button" className="to-latest" onClick={toLatest} title="Go to the latest messages" aria-label="Go to the latest messages">
          ↓{unseen > 0 && <span className="to-latest-count">{unseen}</span>}
        </button>
      )}
      {dragging && <div className="drop-hint">Drop to send</div>}
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
        {(replyTo || editing) && (
          <div className="compose-context">
            <span className="mono accent">{editing ? 'Editing' : `Replying to ${replyTo.outgoing ? 'yourself' : replyTo.from || dialog.name}`}</span>
            <span className="compose-context-text">{(editing || replyTo).text}</span>
            <button type="button" className="attach-remove" onClick={cancelCompose} aria-label={editing ? 'Stop editing' : 'Cancel the reply'}>
              ×
            </button>
          </div>
        )}
        {drafting && <p className="draft-note mono">Drafting a reply… click Draft again to stop.</p>}
        {!drafting && fromAi && text && <p className="draft-note mono">Draft from {draftedBy || 'your AI'}. Edit it, then press Enter to send.</p>}
        {error && <p className="error">{error}</p>}
        {notice && !error && <p className="notice mono">{notice}</p>}
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
        {recording ? (
          <VoiceRecorder onSend={sendVoice} onCancel={() => setRecording(false)} onError={setError} />
        ) : (
        <div className="composer-row">
          <button type="button" className="btn btn-quiet attach-btn" onClick={attach} disabled={Boolean(editing)} title="Attach a picture or file (or drop one on the chat)" aria-label="Attach a picture or file">
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
            placeholder={editing ? 'Edit your message' : attachment ? 'Add a caption (optional)' : `Message ${dialog.name}`}
            rows={1}
            onChange={(e) => {
              setText(e.target.value)
              if (!e.target.value) {
                setFromAi(false)
                setDraftedBy(null)
              }
            }}
            onPaste={(e) => {
              const file = [...(e.clipboardData?.files || [])][0]
              if (file) {
                e.preventDefault()
                takeFile(file)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              } else if (e.key === 'Escape' && (replyTo || editing)) {
                cancelCompose()
              } else if (e.key === 'ArrowUp' && !text && !attachment && lastOwn) {
                // As in Telegram Desktop: Up in an empty box edits your last message.
                e.preventDefault()
                startEdit(lastOwn)
              }
            }}
          />
          <button type="button" className={`btn draft-btn${drafting ? ' is-busy' : ''}`} onClick={draftWithAi} title={text.trim() ? 'Draft a reply from what you typed, with your AI' : 'Draft a reply with your AI'}>
            <span aria-hidden="true">✨</span> {drafting ? 'Stop' : 'Draft'}
          </button>
          {!text.trim() && !attachment && !editing ? (
            <button type="button" className="btn btn-primary mic-btn" onClick={() => setRecording(true)} title="Record a voice message" aria-label="Record a voice message">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
              </svg>
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={send} disabled={(!text.trim() && !attachment) || sending}>
              {editing ? 'Save' : 'Send'}
            </button>
          )}
        </div>
        )}
      </div>
      {menu && <MessageMenu at={menu.at} m={menu.m} dialog={dialog} onClose={() => setMenu(null)} onAction={onAction} />}
      {confirmDelete && <DeleteDialog count={confirmDelete.ids.length} dialog={dialog} outgoing={confirmDelete.outgoing} onConfirm={doDelete} onClose={() => setConfirmDelete(null)} />}
      {forwarding && <ForwardDialog dialogs={dialogs} onPick={doForward} onClose={() => setForwarding(null)} />}
      {infoOpen && <InfoPanel dialog={dialog} onClose={() => setInfoOpen(false)} onJump={jumpTo} onOpenPhoto={setViewer} onError={setError} />}
      {viewer && <PhotoViewer dialogId={dialog.id} msgId={viewer.msgId} preview={viewer.preview} onClose={() => setViewer(null)} />}
    </div>
  )
}

function Chats({ dialogs, ai, drafts, openId, setOpenId, onToggleAi, refreshTick }) {
  const [listError, setListError] = useState(null)
  const open = dialogs.find((d) => d.id === openId)
  useEffect(() => {
    if (!listError) return
    const t = setTimeout(() => setListError(null), 5000)
    return () => clearTimeout(t)
  }, [listError])
  return (
    <div className="tg">
      <ChatList dialogs={dialogs} ai={ai} drafts={drafts} openId={openId} onOpen={setOpenId} onError={setListError} />
      {open ? (
        <Conversation key={open.id} dialog={open} dialogs={dialogs} ai={ai} draft={drafts[chatKey('telegram', open.id)]} onToggleAi={onToggleAi} refreshTick={refreshTick} />
      ) : (
        <div className="convo convo-empty dim">Choose a chat.</div>
      )}
      {listError && <p className="error tg-toast">{listError}</p>}
    </div>
  )
}

export default function Telegram({ state, dialogs, ai, drafts, openId, setOpenId, onToggleAi, refreshTick }) {
  if (!state) return null
  if (state.status === 'needs-keys') return <KeysSetup />
  if (state.status !== 'ready') return <SignIn state={state} />
  return <Chats dialogs={dialogs} ai={ai} drafts={drafts} openId={openId} setOpenId={setOpenId} onToggleAi={onToggleAi} refreshTick={refreshTick} />
}
