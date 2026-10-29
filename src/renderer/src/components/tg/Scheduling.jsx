import { useEffect, useState } from 'react'

// Sending later. The Schedule dialog picks a date and time; the scheduled list shows what's waiting in a
// chat, with Send now and Delete, as in Telegram Desktop.
const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// A datetime-local value for a time, in local time.
const localValue = (ms) => {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const whenText = (at) => new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function ScheduleDialog({ onSchedule, onClose }) {
  const [value, setValue] = useState(() => localValue(Date.now() + 3600e3 - (Date.now() % 60000)))
  const at = new Date(value).getTime()
  const ok = Number.isFinite(at) && at > Date.now() + 60e3 && at < Date.now() + 365 * 86400e3
  const quick = [
    ['In 1 hour', Date.now() + 3600e3],
    ['Tonight at 8', new Date(new Date().setHours(20, 0, 0, 0)).getTime()],
    ['Tomorrow at 9', new Date(new Date(Date.now() + 86400e3).setHours(9, 0, 0, 0)).getTime()]
  ].filter(([, t]) => t > Date.now() + 60e3)
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Schedule message" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h3 className="modal-title">Send later</h3>
        <div className="row-actions">
          {quick.map(([label, t]) => (
            <button key={label} type="button" className="btn btn-quiet" onClick={() => setValue(localValue(t))}>
              {label}
            </button>
          ))}
        </div>
        <input type="datetime-local" value={value} min={localValue(Date.now() + 120e3)} onChange={(e) => setValue(e.target.value)} />
        <p className="dim small">{ok ? `Telegram will send it ${whenText(at)}, even if IV Chat is closed.` : 'Pick a time at least a minute from now, within a year.'}</p>
        <div className="row-actions">
          <button type="button" className="btn btn-primary" disabled={!ok} onClick={() => onSchedule(at)}>
            Schedule
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

export function ScheduledList({ dialogId, onClose, onChanged }) {
  const [list, setList] = useState(null)
  const [error, setError] = useState(null)
  const load = () =>
    window.iv.telegram
      .scheduled(dialogId)
      .then(setList)
      .catch((err) => setError(clean(err)))
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogId])
  const act = async (fn) => {
    setError(null)
    try {
      await fn()
      await load()
      onChanged()
    } catch (err) {
      setError(clean(err))
    }
  }
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Scheduled messages" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h3 className="modal-title">Scheduled</h3>
        {error && <p className="error">{error}</p>}
        <ul className="pick-list scheduled-list">
          {(list || []).map((m) => (
            <li key={m.id} className="scheduled-item">
              <span className="mono accent small">{whenText(m.at)}</span>
              <span className="scheduled-text">{m.text}</span>
              <span className="row-actions">
                <button type="button" className="btn btn-quiet" onClick={() => act(() => window.iv.telegram.sendScheduledNow(dialogId, [m.id]))}>
                  Send now
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => act(() => window.iv.telegram.deleteScheduled(dialogId, [m.id]))}>
                  Delete
                </button>
              </span>
            </li>
          ))}
          {list && !list.length && <li className="dim small">Nothing scheduled in this chat.</li>}
          {!list && !error && <li className="dim small">Loading…</li>}
        </ul>
        <div className="row-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
