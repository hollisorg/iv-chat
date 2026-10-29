import { latestAcross } from '../../../main/services'
import { NAMES, READS_CHATS } from '../views'
import { shortTime } from './Telegram'
import Hero from './Hero'
import Avatar, { TelegramAvatar } from './Avatar'

const STATUS = {
  off: 'Turned off',
  loading: 'Opening…',
  ready: 'Running',
  error: "Didn't load"
}

function ServiceCard({ id, unread, status, note, onOpen, actionLabel }) {
  return (
    <li className="card">
      <div className="card-head">
        <span className="card-name">{NAMES[id]}</span>
        <span className="mono dim">{status}</span>
      </div>
      <p className="card-count">
        {note ? (
          <span className="dim">{note}</span>
        ) : unread ? (
          <>
            <span className="accent">{unread}</span> {unread === 1 ? 'chat' : 'chats'} with new messages
          </>
        ) : (
          <span className="dim">Nothing new</span>
        )}
      </p>
      {onOpen && (
        <button type="button" className="btn" onClick={onOpen}>
          {actionLabel}
        </button>
      )}
    </li>
  )
}

// Why a running service has nothing in the list yet.
function serviceNote(service, chats) {
  if (!READS_CHATS.includes(service.id) || !service.enabled || service.state !== 'ready') return null
  const name = NAMES[service.id]
  if (chats.status === 'no-list') return `Sign in to ${name} to see its latest messages here.`
  if (chats.status === 'unreadable') return `Couldn't read the ${name} chat list. Open ${name} to see your messages.`
  return null
}

function LatestMessages({ services, chats, telegram, enabled, onSelect, onOpenTelegram }) {
  const tgReady = telegram.state?.status === 'ready'
  const tgChats = tgReady ? telegram.dialogs.map((d) => ({ id: d.id, name: d.name, preview: d.preview, at: d.at, time: shortTime(d.at), unread: d.unread })) : []
  // Telegram comes straight from Telegram, so it shows even when reading the website panels is turned off.
  const ready = enabled ? services.filter((s) => s.enabled && chats[s.id]?.status === 'ok') : []
  const items = latestAcross({ telegram: tgChats, ...Object.fromEntries(ready.map((s) => [s.id, chats[s.id].chats])) })
  const notes = enabled
    ? services.map((s) => serviceNote(s, chats[s.id] ?? {})).filter(Boolean)
    : ['Latest WhatsApp and Messenger messages are turned off. You can turn them on in Settings.']
  if (!tgReady) notes.push('Connect Telegram to see its chats here.')

  return (
    <>
      {items.length > 0 ? (
        <ul className="latest">
          {items.map((c, i) => (
            <li key={`${c.service}-${i}-${c.name}`}>
              <button
                type="button"
                className="latest-item"
                onClick={() => (c.service === 'telegram' ? onOpenTelegram(c.id) : onSelect(c.service))}
              >
                {c.service === 'telegram' ? <TelegramAvatar dialog={{ id: c.id, name: c.name, kind: c.kind }} /> : <Avatar name={c.name} />}
                <span className="latest-main">
                  <span className="latest-top">
                    <span className={`latest-name${c.unread ? ' is-unread' : ''}`}>{c.name}</span>
                    <span className={`latest-service mono is-${c.service}`}>{NAMES[c.service]}</span>
                  </span>
                  <span className="latest-preview dim">{c.preview || ' '}</span>
                </span>
                <span className="latest-meta">
                  <span className="mono dim">{c.time}</span>
                  {c.unread > 0 && <span className="latest-badge">{c.unread}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        notes.length === 0 && <p className="dim">No chats to show yet.</p>
      )}
      {notes.map((n) => (
        <p key={n} className="dim small">
          {n}
        </p>
      ))}
    </>
  )
}

const TG_STATUS = { ready: 'Connected', 'needs-keys': 'Not set up', 'signed-out': 'Not connected', qr: 'Connecting', password: 'Connecting', connecting: 'Connecting', starting: 'Starting', error: "Can't reach" }

export default function Updates({ services, chats, telegram, latestEnabled, onSelect, onOpenTelegram }) {
  const tg = telegram.state
  const tgUnread = tg?.status === 'ready' ? telegram.dialogs.filter((d) => d.unread > 0).length : 0
  return (
    <section className="page" aria-label="Updates">
      <Hero title="What's" accent="new." kicker="Every chat · one place" />

      <h2 className="section-title">Latest messages</h2>
      <LatestMessages
        services={services}
        chats={chats}
        telegram={telegram}
        enabled={latestEnabled}
        onSelect={onSelect}
        onOpenTelegram={onOpenTelegram}
      />

      <h2 className="section-title">Services</h2>
      <ul className="cards">
        <ServiceCard
          id="telegram"
          unread={tgUnread}
          status={TG_STATUS[tg?.status] ?? ''}
          note={tg?.status === 'ready' ? null : 'Connect it to see your chats here.'}
          onOpen={() => onSelect('telegram')}
          actionLabel={tg?.status === 'ready' ? 'Open Telegram' : 'Connect Telegram'}
        />
        {services.map((s) => (
          <ServiceCard
            key={s.id}
            id={s.id}
            unread={s.enabled ? s.unread : 0}
            status={STATUS[s.state] ?? ''}
            note={!s.enabled ? 'Turned off in IV Chat' : s.state === 'error' ? "Couldn't load. Open it to try again." : null}
            onOpen={() => onSelect(s.id)}
            actionLabel={s.enabled ? `Open ${NAMES[s.id]}` : `Turn on ${NAMES[s.id]}`}
          />
        ))}
      </ul>
      <p className="dim small">
        WhatsApp and Messenger messages are read from the chat lists already on screen in their panels, and Telegram's come
        straight from Telegram. They stay on this computer. Instagram and LinkedIn show unread counts for now.
      </p>
    </section>
  )
}
