import { useEffect, useRef, useState } from 'react'
import { TelegramAvatar } from '../Avatar'
import RichText from './RichText'
import { Media, SafeMessage, clock, usePreview } from './TgMedia'

// The panel beside a conversation, like Telegram Desktop's chat info: the picture, name, status or member
// count, @username, phone (for your contacts), about text, quick mute, pin and archive, and the chat's shared
// photos and videos, files, links and voice messages.

const TABS = [
  ['media', 'Media'],
  ['files', 'Files'],
  ['links', 'Links'],
  ['voice', 'Voice']
]

const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function Tile({ dialogId, m, onOpenPhoto, onJump }) {
  const src = usePreview(dialogId, m.id, true)
  const video = m.media?.kind !== 'photo'
  return (
    <button type="button" className="shared-tile" onClick={() => (video ? onJump(m.id) : onOpenPhoto({ msgId: m.id, preview: src }))} title={video ? 'Play in the chat' : 'Open the photo'}>
      {src ? <img src={src} alt="" /> : <span className="media-wait mono">…</span>}
      {video && <span className="shared-tile-badge mono">{m.media?.duration ? clock(m.media.duration) : '▶'}</span>}
    </button>
  )
}

export default function InfoPanel({ dialog, onClose, onJump, onOpenPhoto, onError }) {
  const [info, setInfo] = useState(null)
  const [tab, setTab] = useState('media')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [more, setMore] = useState(true)
  const listRef = useRef(null)
  const busy = useRef(false)

  const loadInfo = () => window.iv.telegram.details(dialog.id).then(setInfo).catch(() => {})
  useEffect(() => {
    setInfo(null)
    loadInfo()
    const esc = (e) => e.key === 'Escape' && !document.querySelector('.viewer, .modal') && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog.id])

  // The open tab's items, more as you scroll.
  const loadPage = async (reset) => {
    if (busy.current || (!reset && !more)) return
    busy.current = true
    setLoading(true)
    try {
      const before = reset ? 0 : items[items.length - 1]?.id || 0
      const page = await window.iv.telegram.shared(dialog.id, tab, before)
      setItems((list) => (reset ? page : [...list, ...page]))
      setMore(page.length >= 40)
    } catch (err) {
      onError(clean(err))
    } finally {
      busy.current = false
      setLoading(false)
    }
  }
  useEffect(() => {
    setItems([])
    setMore(true)
    loadPage(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog.id, tab])

  const act = async (fn) => {
    try {
      await fn()
      setTimeout(loadInfo, 900)
    } catch (err) {
      onError(clean(err))
    }
  }

  const d = info || dialog
  const t = window.iv.telegram
  const sub =
    d.kind === 'person' || d.kind === 'saved'
      ? info?.subtitle || ''
      : info?.members
        ? `${info.members.toLocaleString()} ${d.kind === 'channel' ? 'subscribers' : 'members'}${info.online ? `, ${info.online.toLocaleString()} online` : ''}`
        : d.kind

  return (
    <aside className="info-panel" aria-label={`About ${dialog.name}`}>
      <div className="info-head">
        <button type="button" className="btn btn-quiet head-btn" onClick={onClose} aria-label="Close the chat info" title="Close (Esc)">
          ×
        </button>
        <span className="mono dim">{d.kind === 'person' ? 'User info' : d.kind === 'channel' ? 'Channel info' : d.kind === 'saved' ? 'Saved Messages' : 'Group info'}</span>
      </div>
      <div
        className="info-scroll"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) loadPage(false)
        }}
      >
        <div className="info-who">
          <TelegramAvatar dialog={dialog} size={96} />
          <h3 className="info-name">{dialog.name}</h3>
          {sub && <span className={`mono${sub === 'online' ? ' is-online' : ' dim'}`}>{sub}</span>}
        </div>
        <dl className="info-facts">
          {d.username && (
            <>
              <dt className="mono dim">Username</dt>
              <dd>
                <a className="tg-link" href={`https://t.me/${d.username}`} target="_blank" rel="noreferrer">
                  @{d.username}
                </a>
              </dd>
            </>
          )}
          {info?.phone && (
            <>
              <dt className="mono dim">Phone</dt>
              <dd>{info.phone}</dd>
            </>
          )}
          {info?.about && (
            <>
              <dt className="mono dim">{d.kind === 'person' ? 'Bio' : 'About'}</dt>
              <dd>
                <RichText text={info.about} entities={[]} />
              </dd>
            </>
          )}
        </dl>
        {d.kind !== 'saved' && info && !info.found && (
          <div className="info-actions">
            <button type="button" className="btn btn-quiet" onClick={() => act(() => t.mute(d.id, d.muted ? 0 : 'forever'))}>
              {d.muted ? '🔔 Unmute' : '🔕 Mute'}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => act(() => t.pinChat(d.id, !d.pinned))}>
              📌 {d.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => act(() => t.archive(d.id, !d.archived))}>
              {d.archived ? 'Unarchive' : 'Archive'}
            </button>
          </div>
        )}
        <div className="info-tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`tg-folder${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>
              {label}
              {info?.counts?.[id] > 0 && <span className="tg-folder-count is-quiet">{info.counts[id]}</span>}
            </button>
          ))}
        </div>
        {tab === 'media' ? (
          <div className="shared-grid">
            {items
              .filter((m) => m.media)
              .map((m) => (
                <Tile key={m.id} dialogId={dialog.id} m={m} onOpenPhoto={onOpenPhoto} onJump={onJump} />
              ))}
          </div>
        ) : (
          <ul className="shared-list">
            {items.map((m) => (
              <li key={m.id}>
                {tab === 'links' ? (
                  <button type="button" className="shared-link" onClick={() => onJump(m.id)} title="Go to the message">
                    <span className="mono dim small">{new Date(m.at).toLocaleDateString()}</span>
                    {m.link?.title && <span className="link-card-title">{m.link.title}</span>}
                    <RichText text={m.body || m.text} entities={m.entities} />
                  </button>
                ) : (
                  <SafeMessage>
                    {m.media ? <Media dialogId={dialog.id} m={m} onOpenPhoto={onOpenPhoto} /> : <span className="dim small">{m.text}</span>}
                  </SafeMessage>
                )}
              </li>
            ))}
          </ul>
        )}
        {loading && <p className="dim small center">Loading…</p>}
        {!loading && !items.length && <p className="dim small center">Nothing here yet.</p>}
      </div>
    </aside>
  )
}
