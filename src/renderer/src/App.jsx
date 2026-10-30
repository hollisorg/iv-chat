import { useCallback, useEffect, useState } from 'react'
import { countsAsUnread } from '../../main/tg-format.js'
import Rail from './components/Rail'
import PanelHost from './components/PanelHost'
import Updates from './components/Updates'
import Telegram from './components/Telegram'
import Settings from './components/Settings'
import CallBanner from './components/CallBanner'
import Locked from './components/Locked'
import { ALL_VIEWS } from './views'
import chatMark from './assets/chat-mark.png'

export default function App() {
  const [view, setView] = useState('updates')
  const [services, setServices] = useState([])
  const [settings, setSettings] = useState(null)
  const [update, setUpdate] = useState(null)
  const [chats, setChats] = useState({})
  const [tgState, setTgState] = useState(null)
  const [tgDialogs, setTgDialogs] = useState([])
  const [tgOpen, setTgOpen] = useState(null)
  const [aiState, setAiState] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [refreshing, setRefreshing] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  const [calls, setCalls] = useState([]) // Telegram calls ringing now, newest last
  const [unlock, setUnlock] = useState(null) // { locked, retrying } when saved sign-ins couldn't be opened

  useEffect(() => {
    window.iv.services.list().then(setServices)
    window.iv.chats.get().then(setChats)
    window.iv.settings.get().then(setSettings)
    window.iv.app.update().then(setUpdate)
    window.iv.telegram.state().then(setTgState)
    window.iv.telegram.dialogs().then(setTgDialogs)
    window.iv.ai.get().then(setAiState)
    window.iv.ai.drafts().then(setDrafts)
    window.iv.app.unlock().then(setUnlock)
    const offs = [
      window.iv.services.onChange(setServices),
      window.iv.chats.onChange(setChats),
      window.iv.view.onSelect(setView),
      window.iv.app.onUpdate(setUpdate),
      window.iv.app.onUnlock(setUnlock),
      window.iv.telegram.onState(setTgState),
      window.iv.telegram.onDialogs(setTgDialogs),
      window.iv.telegram.onOpen((id) => setTgOpen(id)),
      window.iv.telegram.onCall((c) =>
        setCalls((list) => (c.state === 'ringing' ? [...list.filter((x) => x.id !== c.id), c] : list.filter((x) => x.id !== c.id)))
      ),
      window.iv.ai.onDraft(({ key, text }) => setDrafts((d) => ({ ...d, [key]: text }))),
      window.iv.ai.onActivity((activity) => setAiState((s) => (s ? { ...s, activity } : s)))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // The main process shows the matching website panel (or none) for whatever view is current.
  useEffect(() => {
    window.iv.view.set(view)
  }, [view])

  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const target = ALL_VIEWS.find((v) => v.key === e.key)
      if (target) {
        e.preventDefault()
        setView(target.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const changeSettings = useCallback(async (patch) => {
    const next = await window.iv.settings.set(patch)
    setSettings(next)
    setAiState((s) => (s ? { ...s, ai: next.ai } : s))
  }, [])

  const toggleAi = useCallback(async (key, on) => {
    setAiState(await window.iv.ai.setChat(key, on))
  }, [])

  // Reloads Telegram's chat list, the open Telegram conversation and every website panel.
  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    const started = Date.now()
    try {
      await window.iv.app.refreshAll()
      setRefreshTick((t) => t + 1)
    } finally {
      setTimeout(() => setRefreshing(false), Math.max(0, 900 - (Date.now() - started)))
    }
  }, [])

  const openTelegramChat = useCallback((id) => {
    setTgOpen(id)
    setView('telegram')
  }, [])

  const panel = services.find((s) => s.id === view)
  const tgUnread = tgState?.status === 'ready' ? tgDialogs.filter(countsAsUnread).length : 0
  const totalUnread = services.reduce((sum, s) => sum + (s.enabled ? s.unread : 0), 0) + tgUnread
  const ai = aiState?.ai ?? settings?.ai ?? { enabled: true, mode: 'chosen', allowed: [], excluded: [] }

  // Settings stays usable while the saved sign-ins are locked; every other view shows the locked screen.
  // Opened inside another app's package, Settings would only change that app's copy, so it's locked too.
  const locked = Boolean(unlock?.locked) && (Boolean(unlock?.borrowedBy) || view !== 'settings')

  return (
    <div className={`app${settings?.navCollapsed ? ' is-mini' : ''}`}>
      <header className="titlebar">
        <img className="brand-logo" src={chatMark} alt="IV Chat" />
        <span className="mono">Infinite Variance</span>
        <span className="mono dim">/ Chat</span>
        <div className="top-actions">
        {update?.status === 'ready' && (
          <button type="button" className="top-btn is-update" onClick={() => window.iv.app.installUpdate()} title={`IV Chat ${update.available} is downloaded. Restart to install it; your chats and sign-ins stay.`}>
            <span className="top-btn-icon" aria-hidden="true">↑</span>
            <span className="mono">Update to {update.available}</span>
          </button>
        )}
        <button type="button" className={`top-btn${refreshing ? ' is-busy' : ''}`} onClick={refreshAll} disabled={refreshing} title="Reload every chat: Telegram and all the website panels">
          <span className="top-btn-icon" aria-hidden="true">↻</span>
          <span className="mono">{refreshing ? 'Refreshing' : 'Refresh all'}</span>
        </button>
        <button
          type="button"
          className={`ai-pill${ai.enabled ? ' is-on' : ''}`}
          onClick={() => changeSettings({ ai: { enabled: !ai.enabled } })}
          title="Turns your AI's access to IV Chat on or off, for every chat at once"
        >
          <span className="ai-pill-dot" />
          <span className="mono">AI access {ai.enabled ? 'on' : 'off'}</span>
        </button>
        </div>
      </header>
      <Rail
        view={view}
        services={services}
        totalUnread={totalUnread}
        telegramUnread={tgUnread}
        version={update?.version}
        collapsed={Boolean(settings?.navCollapsed)}
        onToggle={() => changeSettings({ navCollapsed: !settings?.navCollapsed })}
        onSelect={setView}
      />
      {calls.length > 0 && (
        <div className="call-strip">
          <CallBanner
            key={calls[calls.length - 1].id}
            call={calls[calls.length - 1]}
            media={settings?.media}
            onOpenChat={openTelegramChat}
            onGone={(id) => setCalls((list) => list.filter((x) => x.id !== id))}
          />
        </div>
      )}
        <main className="main">
          {locked && <Locked unlock={unlock} onChange={setUnlock} />}
          {!locked && panel && (
            <PanelHost key={panel.id} service={panel} onEnable={(id) => changeSettings({ services: { [id]: { enabled: true } } })} />
          )}
          {!locked && view === 'updates' && (
            <Updates
              services={services}
              chats={chats}
              telegram={{ state: tgState, dialogs: tgDialogs }}
              latestEnabled={settings?.latestMessages ?? true}
              onSelect={setView}
              onOpenTelegram={openTelegramChat}
            />
          )}
          {!locked && view === 'telegram' && (
            <Telegram
              state={tgState}
              dialogs={tgDialogs}
              ai={ai}
              drafts={drafts}
              openId={tgOpen}
              setOpenId={setTgOpen}
              onToggleAi={toggleAi}
              refreshTick={refreshTick}
            />
          )}
          {!locked && view === 'settings' && (
            <Settings
              settings={settings}
              services={services}
              update={update}
              onChange={changeSettings}
              telegram={{ state: tgState, dialogs: tgDialogs }}
              chats={chats}
              aiState={aiState}
              setAiState={setAiState}
              onToggleAi={toggleAi}
            />
          )}
        </main>
    </div>
  )
}
