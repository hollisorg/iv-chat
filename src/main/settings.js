import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { PANEL_IDS } from './services'
import { AI_DEFAULTS, cleanAi } from './ai-access.js'
import { PREF_DEFAULTS, cleanPrefs } from './starter.js'
import { MEDIA_DEFAULTS, cleanMedia } from './media-settings.js'

const file = () => path.join(app.getPath('userData'), 'settings.json')

const defaults = () => ({
  services: Object.fromEntries(PANEL_IDS.map((id) => [id, { enabled: true }])),
  notifications: true,
  // Read the top of each chat list for the Updates page (in memory only).
  latestMessages: true,
  closeToTray: true,
  launchAtLogin: false,
  // Shown once, the first time the window hides to the tray.
  trayHintShown: false,
  // The sidebar shrunk to round logo buttons.
  navCollapsed: false,
  // What the person's AI may see through the MCP (see ai-access.js).
  ai: { ...AI_DEFAULTS },
  // How the person likes their replies written; goes into the starter message for Codex or Claude.
  replyPrefs: { ...PREF_DEFAULTS },
  // Which AI the Draft button runs: 'auto' (Codex if installed, else Claude Code), 'codex' or 'claude'.
  draftEngine: 'auto',
  // Microphone, camera and speaker, ringing for Telegram calls, and per-service access (see media-settings.js).
  media: cleanMedia(MEDIA_DEFAULTS),
  // The exact text added to Claude Desktop's settings, so Disconnect can remove exactly that.
  connections: { claudeDesktopInserted: null }
})

export function loadSettings() {
  const base = defaults()
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'))
    return {
      ...base,
      ...saved,
      services: Object.fromEntries(PANEL_IDS.map((id) => [id, { ...base.services[id], ...saved.services?.[id] }])),
      ai: cleanAi(saved.ai),
      replyPrefs: cleanPrefs(saved.replyPrefs),
      media: cleanMedia(saved.media),
      connections: { ...base.connections, ...saved.connections }
    }
  } catch {
    return base
  }
}

// Only known keys with the right types get through; everything else is ignored.
// Per-chat AI access is changed through setChatAccess (index.js), not here.
export function applyPatch(current, patch) {
  const next = structuredClone(current)
  for (const key of ['notifications', 'latestMessages', 'closeToTray', 'launchAtLogin', 'trayHintShown', 'navCollapsed']) {
    if (typeof patch?.[key] === 'boolean') next[key] = patch[key]
  }
  for (const id of PANEL_IDS) {
    const enabled = patch?.services?.[id]?.enabled
    if (typeof enabled === 'boolean') next.services[id].enabled = enabled
  }
  if (typeof patch?.ai?.enabled === 'boolean') next.ai.enabled = patch.ai.enabled
  if (patch?.ai?.mode === 'all' || patch?.ai?.mode === 'chosen') next.ai.mode = patch.ai.mode
  if (['auto', 'codex', 'claude'].includes(patch?.draftEngine)) next.draftEngine = patch.draftEngine
  if (patch?.replyPrefs && typeof patch.replyPrefs === 'object') next.replyPrefs = cleanPrefs({ ...next.replyPrefs, ...patch.replyPrefs })
  if (patch?.media && typeof patch.media === 'object') next.media = cleanMedia(patch.media, next.media)
  return next
}

export function saveSettings(settings) {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(settings, null, 2))
}
