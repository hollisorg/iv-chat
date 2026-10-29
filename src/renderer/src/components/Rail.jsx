import { SETTINGS, VIEWS } from '../views'

// IV Studio's numbered sidebar: condensed uppercase names, a red bar on the open one, unread counts on
// the right, and a faint slice of the chat artwork at the bottom.
export default function Rail({ view, services, totalUnread, telegramUnread, version, onSelect }) {
  const byId = Object.fromEntries(services.map((s) => [s.id, s]))
  const items = [...VIEWS, SETTINGS]
  return (
    <nav className="nav" aria-label="IV Chat">
      {items.map((item, i) => {
        const s = byId[item.id]
        const unread = item.id === 'updates' ? totalUnread : item.id === 'telegram' ? telegramUnread : s?.enabled ? s.unread : 0
        const off = item.panel && !s?.enabled
        return (
          <button
            key={item.id}
            type="button"
            className={`nav-item${view === item.id ? ' on' : ''}${off ? ' off' : ''}`}
            aria-current={view === item.id ? 'page' : undefined}
            aria-label={unread ? `${item.label}, ${unread} unread` : item.label}
            title={`${item.label}  (Ctrl+${item.key})`}
            onClick={() => onSelect(item.id)}
          >
            <span className="mono dim">{String(i + 1).padStart(2, '0')}</span>
            <span className="nav-name">{item.label}</span>
            {unread > 0 && <span className="nav-count">{unread > 99 ? '99+' : unread}</span>}
          </button>
        )
      })}
      <div className="nav-foot mono">
        <span>v{version}</span>
        <a className="nav-site" href="https://infinitevariance.ai" target="_blank" rel="noreferrer">
          infinitevariance.ai ↗
        </a>
      </div>
    </nav>
  )
}
