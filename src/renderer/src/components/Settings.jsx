import { NAMES } from '../views'
import AiSettings from './AiSettings'
import DeviceSettings from './DeviceSettings'
import Hero from './Hero'

function Toggle({ label, hint, checked, onChange }) {
  return (
    <label className="toggle">
      <span>
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint dim">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

function updateText(u) {
  if (!u) return ''
  switch (u.status) {
    case 'dev':
      return 'Development build: updates are off.'
    case 'checking':
      return 'Checking for updates…'
    case 'current':
      return u.checkedAt ? `You're up to date (checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}).` : "You're up to date."
    case 'downloading':
      return `Downloading ${u.available}… ${Math.round(u.percent ?? 0)}%`
    case 'ready':
      return `Version ${u.available} is ready to install.`
    case 'available':
      return `Version ${u.available} is available.`
    case 'error':
      return `Couldn't check for updates: ${u.error}`
    default:
      return ''
  }
}

export default function Settings({ settings, services, update, onChange, telegram, chats, aiState, setAiState, onToggleAi }) {
  if (!settings) return null
  return (
    <section className="page" aria-label="Settings">
      <Hero title="Settings" kicker="Services · calls · your AI · the app" />

      <h2 className="section-title">Services</h2>
      <ul className="rows">
        <li className="row">
          <span className="toggle">
            <span>
              <span className="toggle-label">Telegram</span>
              <span className="toggle-hint dim">
                {telegram.state?.status === 'ready'
                  ? `Connected${telegram.state.me?.name ? ` as ${telegram.state.me.name}` : ''}`
                  : 'Not connected. Open Telegram in the sidebar to connect.'}
              </span>
            </span>
          </span>
          {telegram.state?.status === 'ready' && (
            <div className="row-actions">
              <button type="button" className="btn btn-quiet" onClick={() => window.iv.telegram.signOut()}>
                Sign out
              </button>
            </div>
          )}
        </li>
        {services.map((s) => (
          <li key={s.id} className="row">
            <Toggle
              label={NAMES[s.id]}
              hint={s.enabled ? 'Shown in IV Chat' : 'Turned off'}
              checked={settings.services[s.id].enabled}
              onChange={(on) => onChange({ services: { [s.id]: { enabled: on } } })}
            />
            {s.enabled && (
              <div className="row-actions">
                <button type="button" className="btn btn-quiet" onClick={() => window.iv.services.reload(s.id)}>
                  Reload
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => window.iv.services.signOut(s.id)}>
                  Sign out
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {settings.media && <DeviceSettings media={settings.media} onChange={onChange} />}

      <AiSettings
        aiState={aiState}
        setAiState={setAiState}
        onChange={onChange}
        onToggleAi={onToggleAi}
        telegram={telegram}
        chats={chats}
        prefs={settings.replyPrefs}
      />

      <h2 className="section-title">App</h2>
      <ul className="rows">
        <li className="row">
          <Toggle
            label="Notifications"
            hint="A Windows notification when a chat gets a new message"
            checked={settings.notifications}
            onChange={(v) => onChange({ notifications: v })}
          />
        </li>
        <li className="row">
          <Toggle
            label="Show latest messages"
            hint="Reads the top of your WhatsApp and Messenger chat lists for the Updates page and your AI. Stays on this computer, in memory only."
            checked={settings.latestMessages}
            onChange={(v) => onChange({ latestMessages: v })}
          />
        </li>
        <li className="row">
          <Toggle
            label="Keep running in the tray"
            hint="Closing the window keeps messages coming in. Quit from the tray icon."
            checked={settings.closeToTray}
            onChange={(v) => onChange({ closeToTray: v })}
          />
        </li>
        <li className="row">
          <Toggle
            label="Start with Windows"
            hint="Opens quietly in the tray when you sign in to Windows"
            checked={settings.launchAtLogin}
            onChange={(v) => onChange({ launchAtLogin: v })}
          />
        </li>
      </ul>

      <h2 className="section-title">About</h2>
      <p className="dim">
        IV Chat {update?.version}. {updateText(update)}{' '}
        {update?.status === 'ready' && (
          <button type="button" className="btn btn-quiet" onClick={() => window.iv.app.installUpdate()}>
            Restart to update
          </button>
        )}
        {['current', 'error', 'idle', 'available'].includes(update?.status) && (
          <button type="button" className="btn btn-quiet" onClick={() => window.iv.app.checkForUpdate()}>
            Check now
          </button>
        )}
      </p>
      {update?.status !== 'dev' && (
        <p className="dim small">IV Chat checks for a new version when it opens and every six hours, downloads it in the background, and installs it when you restart or quit.</p>
      )}
      <p className="dim small">
        WhatsApp and Messenger run as their own websites inside IV Chat. Your sign-ins stay on this computer.{' '}
        <button type="button" className="link" onClick={() => window.iv.app.openLicenses()}>
          Licenses
        </button>
      </p>
    </section>
  )
}
