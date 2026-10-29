import { useEffect, useMemo, useRef, useState } from 'react'
import { aiCanSee, chatKey } from '../../../../main/ai-access.js'
import { countsAsUnread } from '../../../../main/tg-format.js'
import { TelegramAvatar } from '../Avatar'

// The Telegram chat list, like Telegram Desktop's: your folders as tabs, pinned chats first, an "Archived
// chats" row, search across your chats plus people and public groups, a right-click menu for each chat
// (pin, mute, mark read or unread, archive), and New chat.

const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function shortTime(at) {
  if (!at) return ''
  const d = new Date(at)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = (now - d) / 86400e3
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// Pinned chats in Telegram's order, then everything else newest first.
function sortChats(list, pinnedIds) {
  const pinRank = new Map((pinnedIds || []).map((id, i) => [id, i]))
  return [...list].sort((a, b) => {
    const pa = pinnedIds ? pinRank.has(a.id) : a.pinned
    const pb = pinnedIds ? pinRank.has(b.id) : b.pinned
    if (pa !== pb) return pa ? -1 : 1
    if (pa && pb) return pinnedIds ? pinRank.get(a.id) - pinRank.get(b.id) : a.order - b.order
    return (b.at ?? 0) - (a.at ?? 0)
  })
}

const MUTE_FOR = [
  ['For 1 hour', 3600e3],
  ['For 8 hours', 8 * 3600e3],
  ['For 2 days', 2 * 86400e3],
  ['Until I turn it back on', 'forever']
]

function ChatMenu({ at, d, onClose, onError }) {
  const ref = useRef(null)
  const [muteOpen, setMuteOpen] = useState(false)
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
  const run = async (fn) => {
    onClose()
    try {
      await fn()
    } catch (err) {
      onError(/PINNED_DIALOGS_TOO_MUCH/.test(String(err)) ? 'You have pinned as many chats as Telegram allows. Unpin one first.' : clean(err))
    }
  }
  const t = window.iv.telegram
  const style = { left: Math.min(at.x, window.innerWidth - 220), top: Math.min(at.y, window.innerHeight - 260) }
  return (
    <div className="msg-menu" ref={ref} role="menu" style={style}>
      <button type="button" role="menuitem" onClick={() => run(() => t.pinChat(d.id, !d.pinned))}>
        {d.pinned ? 'Unpin' : 'Pin to top'}
      </button>
      {d.muted ? (
        <button type="button" role="menuitem" onClick={() => run(() => t.mute(d.id, 0))}>
          Unmute
        </button>
      ) : (
        <button type="button" role="menuitem" aria-expanded={muteOpen} onClick={() => setMuteOpen((v) => !v)}>
          Mute… {muteOpen ? '▴' : '▾'}
        </button>
      )}
      {muteOpen &&
        MUTE_FOR.map(([label, ms]) => (
          <button key={label} type="button" role="menuitem" className="is-sub" onClick={() => run(() => t.mute(d.id, ms === 'forever' ? 'forever' : Date.now() + ms))}>
            {label}
          </button>
        ))}
      {d.unread > 0 || d.unreadMark ? (
        <button type="button" role="menuitem" onClick={() => run(() => t.markUnread(d.id, false))}>
          Mark as read
        </button>
      ) : (
        <button type="button" role="menuitem" onClick={() => run(() => t.markUnread(d.id, true))}>
          Mark as unread
        </button>
      )}
      {d.kind !== 'saved' && (
        <button type="button" role="menuitem" onClick={() => run(() => t.archive(d.id, !d.archived))}>
          {d.archived ? 'Unarchive' : 'Archive'}
        </button>
      )}
    </div>
  )
}

function ChatRow({ d, active, ai, drafts, onOpen, onMenu }) {
  const key = chatKey('telegram', d.id)
  const badge = d.unread > 0 ? d.unread : d.unreadMark ? '' : null
  return (
    <li>
      <button
        type="button"
        className={`tg-item${active ? ' is-active' : ''}`}
        onClick={() => onOpen(d.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu(d, { x: e.clientX, y: e.clientY })
        }}
      >
        <TelegramAvatar dialog={d} />
        <span className="tg-main">
          <span className={`latest-name${d.unread || d.unreadMark ? ' is-unread' : ''}`}>
            {d.name}
            {d.muted && (
              <span className="chat-flag" title="Muted" aria-label="Muted">
                🔕
              </span>
            )}
            {aiCanSee(ai, key) && <span className="ai-dot" title="Your AI can see this chat" />}
          </span>
          <span className="latest-preview dim">
            {drafts[key] ? <span className="accent">Draft: </span> : null}
            {drafts[key] || d.preview}
          </span>
        </span>
        <span className="latest-meta">
          <span className="mono dim">{shortTime(d.at)}</span>
          <span className="chat-badges">
            {d.mentions > 0 && <span className="latest-badge is-mention">@</span>}
            {badge !== null ? (
              <span className={`latest-badge${d.muted ? ' is-muted' : ''}${badge === '' ? ' is-dot' : ''}`}>{badge}</span>
            ) : d.pinned ? (
              <span className="chat-pin" title="Pinned" aria-label="Pinned">
                📌
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  )
}

// New chat: find one of your contacts, or a public person, group or channel by name or @username.
export function NewChatDialog({ onOpen, onClose }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const ref = useRef(null)
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  useEffect(() => {
    if (q.trim().length < 2) return setResults([])
    let live = true
    setBusy(true)
    const t = setTimeout(async () => {
      try {
        const r = await window.iv.telegram.findChats(q)
        if (live) {
          setResults(r)
          setError(null)
        }
      } catch (err) {
        if (live) setError(clean(err))
      } finally {
        if (live) setBusy(false)
      }
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" ref={ref} role="dialog" aria-label="New chat">
        <h3 className="modal-title">New chat</h3>
        <input className="modal-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or @username" autoFocus />
        {error && <p className="error">{error}</p>}
        <ul className="pick-list">
          {results.map((r) => (
            <li key={r.id}>
              <button type="button" className="pick-item" onClick={() => onOpen(r)}>
                <TelegramAvatar dialog={r} size={34} />
                <span className="pick-main">
                  <span>{r.name}</span>
                  <span className="mono dim small">
                    {[r.username && `@${r.username}`, r.kind === 'person' ? (r.mine ? 'contact' : 'person') : r.kind, r.members ? `${r.members.toLocaleString()} members` : ''].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {!busy && q.trim().length >= 2 && !results.length && !error && <li className="dim small">No one found.</li>}
          {q.trim().length < 2 && <li className="dim small">Type at least two letters.</li>}
        </ul>
      </div>
    </div>
  )
}

export default function ChatList({ dialogs, ai, drafts, openId, onOpen, onError }) {
  const [folders, setFolders] = useState([])
  const [folder, setFolder] = useState('all')
  const [archive, setArchive] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState([])
  const [menu, setMenu] = useState(null)
  const [newChat, setNewChat] = useState(false)

  useEffect(() => {
    window.iv.telegram.folders().then(setFolders).catch(() => {})
    return window.iv.telegram.onFolders(setFolders)
  }, [])

  // People and public chats matching the search, beyond your own chats.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) return setFound([])
    let live = true
    const t = setTimeout(() => {
      window.iv.telegram
        .findChats(q)
        .then((r) => live && setFound(r))
        .catch(() => live && setFound([]))
    }, 350)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [query])

  const current = folders.find((f) => f.id === folder)
  // Chats opened from search show only while open; archived ones live behind the Archived row.
  const visible = dialogs.filter((d) => !d.found || d.id === openId)
  const q = query.trim().toLowerCase()
  const list = useMemo(() => {
    if (q) return sortChats(dialogs.filter((d) => d.name.toLowerCase().includes(q) || d.username?.toLowerCase().includes(q.replace(/^@/, ''))))
    if (archive) return sortChats(visible.filter((d) => d.archived))
    if (current) {
      const ids = new Set(current.ids)
      return sortChats(visible.filter((d) => ids.has(d.id)), current.pinned)
    }
    return sortChats(visible.filter((d) => !d.archived))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogs, q, archive, folder, folders, openId])
  const archived = dialogs.filter((d) => d.archived)
  const archivedUnread = archived.filter((d) => d.unread > 0 || d.unreadMark).length
  const folderUnread = (f) => dialogs.filter((d) => f.ids.includes(d.id) && countsAsUnread({ ...d, archived: false })).length
  const extra = q ? found.filter((r) => !dialogs.some((d) => d.id === r.id)) : []

  const openFound = async (r) => {
    try {
      const id = await window.iv.telegram.openFound(r.id)
      setQuery('')
      setNewChat(false)
      onOpen(id)
    } catch (err) {
      onError(clean(err))
    }
  }

  return (
    <div className="tg-side">
      <div className="tg-search">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search chats and people" onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
        <button type="button" className="btn btn-quiet head-btn" onClick={() => setNewChat(true)} title="New chat" aria-label="New chat">
          ✎
        </button>
      </div>
      {!q && !archive && folders.length > 0 && (
        <div className="tg-folders" role="tablist" aria-label="Folders">
          {[{ id: 'all', title: 'All chats', ids: null }, ...folders].map((f) => {
            const n = f.ids ? folderUnread(f) : dialogs.filter(countsAsUnread).length
            return (
              <button key={f.id} type="button" role="tab" aria-selected={folder === f.id} className={`tg-folder${folder === f.id ? ' on' : ''}`} onClick={() => setFolder(f.id)}>
                {f.emoticon ? `${f.emoticon} ` : ''}
                {f.title}
                {n > 0 && <span className="tg-folder-count">{n}</span>}
              </button>
            )
          })}
        </div>
      )}
      {archive && (
        <button type="button" className="tg-back" onClick={() => setArchive(false)}>
          ← Archived chats
        </button>
      )}
      <ul className="tg-list" aria-label="Telegram chats">
        {!q && !archive && folder === 'all' && archived.length > 0 && (
          <li>
            <button type="button" className="tg-item tg-archive-row" onClick={() => setArchive(true)}>
              <span className="avatar is-archive" style={{ width: 38, height: 38 }} aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                  <path d="M3 7h18v3H3zM5 10v9h14v-9M10 14h4" />
                </svg>
              </span>
              <span className="tg-main">
                <span className="latest-name">Archived chats</span>
                <span className="latest-preview dim">{archived.slice(0, 3).map((d) => d.name).join(', ')}</span>
              </span>
              <span className="latest-meta">{archivedUnread > 0 && <span className="latest-badge is-muted">{archivedUnread}</span>}</span>
            </button>
          </li>
        )}
        {list.map((d) => (
          <ChatRow key={d.id} d={d} active={d.id === openId} ai={ai} drafts={drafts} onOpen={onOpen} onMenu={(chat, at) => setMenu({ d: chat, at })} />
        ))}
        {q && extra.length > 0 && <li className="tg-section mono dim">People and public chats</li>}
        {extra.map((r) => (
          <li key={`f${r.id}`}>
            <button type="button" className="tg-item" onClick={() => openFound(r)}>
              <TelegramAvatar dialog={r} />
              <span className="tg-main">
                <span className="latest-name">{r.name}</span>
                <span className="latest-preview dim">{[r.username && `@${r.username}`, r.members ? `${r.members.toLocaleString()} members` : r.kind].filter(Boolean).join(' · ')}</span>
              </span>
            </button>
          </li>
        ))}
        {!list.length && !extra.length && <li className="dim small tg-empty">{q ? 'No chats found.' : archive ? 'Nothing archived.' : 'No chats in this folder.'}</li>}
      </ul>
      {menu && <ChatMenu at={menu.at} d={menu.d} onClose={() => setMenu(null)} onError={onError} />}
      {newChat && <NewChatDialog onOpen={openFound} onClose={() => setNewChat(false)} />}
    </div>
  )
}
