import { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Panels } from './panels'
import { SERVICES, PANEL_IDS, sanitizeChats, totalUnread } from './services'
import { applyPatch, loadSettings, saveSettings } from './settings'
import { initUpdater, updateState } from './updater'
import { TelegramService } from './telegram'
import { RateLimiter, setChatAccess } from './ai-access.js'
import { createTools } from './mcp-tools.js'
import { startMcpPipe } from './mcp-pipe'
import * as connectors from './connectors.js'
import { createWhatsApp } from './whatsapp.js'
import { buildDraftPrompt, findEngines, pickEngine, runDraft } from './ai-draft.js'
import { flattenDraft } from './whatsapp-parse.js'

// Tests run against a throwaway profile so they never touch real sign-ins (scripts/smoke-test.mjs).
if (process.env.IV_CHAT_PROFILE) app.setPath('userData', process.env.IV_CHAT_PROFILE)

// One IV Chat at a time; opening it again brings the existing window forward.
if (!app.requestSingleInstanceLock()) app.quit()

// Windows shows the icon of whichever shortcut carries this ID, so development runs (electron.exe) use
// their own ID and can't lend the installed app Electron's logo.
app.setAppUserModelId(app.isPackaged ? 'ai.infinitevariance.chat' : 'ai.infinitevariance.chat.dev')

const VIEWS = ['updates', 'telegram', ...PANEL_IDS, 'settings']
const resource = (name) => path.join(app.getAppPath(), 'resources', name)
const startHidden = process.argv.includes('--hidden')

let settings
let win = null
let panels = null
let tray = null
let updater = null
let quitting = false
let activeView = 'updates'
let telegram = null
const activity = [] // the AI's recent tool calls, without message text; memory only
const aiDrafts = {} // chat key -> latest AI draft, shown in the Telegram reply box
const pickedFiles = new Map() // token -> file the person picked to send in Telegram

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#100c0e',
    title: 'IV Chat',
    icon: resource('icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#100c0e', symbolColor: '#f1ede5', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => {
    if (!startHidden) win.show()
  })

  // The app's own UI never navigates; external links open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  // Closing hides to the tray so messages keep arriving; Quit lives in the tray menu.
  win.on('close', (e) => {
    if (quitting || !settings.closeToTray) return
    e.preventDefault()
    win.hide()
    if (!settings.trayHintShown) {
      notify('IV Chat is still running', 'It keeps your messages coming in from the tray. Right-click the tray icon to quit.')
      updateSettings({ trayHintShown: true })
    }
  })

  panels = new Panels(win)
  panels.on('change', (states) => {
    send('services:changed', states)
    refreshUnread()
  })
  panels.on('unread-increased', onNewMessages)
  panels.on('shortcut', selectView)
  panels.on('chats', (chats) => send('chats:changed', chats))

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  panels.sync(settings)
  panels.setReader(settings.latestMessages)
}

function showWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// Main-process requests to change view (tray, notifications, shortcuts) go through the UI,
// which then reports back with view:set so both sides agree.
function selectView(view) {
  if (VIEWS.includes(view)) send('view:select', view)
}

// ---------- unread, tray and notifications ----------

const telegramUnread = () => (telegram?.status === 'ready' ? telegram.dialogList().reduce((n, d) => n + (d.unread ? 1 : 0), 0) : 0)

function refreshUnread() {
  if (!win || !tray) return
  const total = totalUnread(panels.states) + telegramUnread()
  win.setTitle(total ? `IV Chat (${total})` : 'IV Chat')
  if (process.platform === 'win32') {
    win.setOverlayIcon(total ? nativeImage.createFromPath(resource('overlay-unread.png')) : null, total ? `${total} unread` : '')
  }
  tray.setImage(nativeImage.createFromPath(resource(total ? 'tray-unread.png' : 'tray.png')))
  const lines = PANEL_IDS.filter((id) => panels.states[id].enabled).map(
    (id) => `${SERVICES[id].name}: ${panels.states[id].unread || 'no'} unread`
  )
  if (telegram?.status === 'ready') lines.unshift(`Telegram: ${telegramUnread() || 'no'} unread`)
  tray.setToolTip(['IV Chat', ...lines].join('\n'))
  buildTrayMenu()
}

function buildTrayMenu() {
  const tg = telegram?.status === 'ready' ? [{ label: telegramUnread() ? `Telegram (${telegramUnread()})` : 'Telegram', click: () => (showWindow(), selectView('telegram')) }] : []
  const serviceItems = [...tg, ...PANEL_IDS.filter((id) => panels.states[id].enabled).map((id) => {
    const n = panels.states[id].unread
    return {
      label: n ? `${SERVICES[id].name} (${n})` : SERVICES[id].name,
      click: () => {
        showWindow()
        selectView(id)
      }
    }
  })]
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open IV Chat', click: showWindow },
      { type: 'separator' },
      ...serviceItems,
      { type: 'separator' },
      {
        label: 'Quit IV Chat',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(resource('tray.png')))
  tray.setToolTip('IV Chat')
  tray.on('click', showWindow)
  buildTrayMenu()
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon: resource('icon.png'), silent: false })
  if (onClick) n.on('click', onClick)
  n.show()
}

// The count comes from the site's tab title, which counts unread chats. No message content is read.
function onNewMessages(id, unread) {
  if (!settings.notifications) return
  const looking = win.isVisible() && win.isFocused() && activeView === id
  if (looking) return
  const name = SERVICES[id].name
  notify(name, unread === 1 ? 'You have a new message.' : `You have new messages in ${unread} chats.`, () => {
    showWindow()
    selectView(id)
  })
}

// ---------- settings ----------

function updateSettings(patch) {
  const before = settings
  settings = applyPatch(settings, patch)
  saveSettings(settings)
  if (before.launchAtLogin !== settings.launchAtLogin && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: ['--hidden'] })
  }
  panels?.sync(settings)
  panels?.setReader(settings.latestMessages)
  return settings
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('services:list', () => panels.snapshot())
  ipcMain.handle('chats:get', () => panels.chatsSnapshot())
  // Sent by the read-only reader inside a panel; panels.chatsFrom checks it came from a panel's own page.
  ipcMain.on('panel:chats', (e, payload) => panels.chatsFrom(e.sender.id, sanitizeChats(payload)))
  // Answers from WhatsApp assisted mode; panels.assistReply checks they come from the panel that was asked.
  ipcMain.on('assist:reply', (e, payload) => panels.assistReply(e.sender.id, payload))

  ipcMain.handle('app:copy', (_e, text) => clipboard.writeText(String(text ?? '').slice(0, 20000)))

  // Refresh everything: Telegram's chat list and every website panel.
  ipcMain.handle('app:refreshAll', async () => {
    panels.reloadAll()
    if (telegram?.status === 'ready') await telegram.refreshDialogs().catch(() => {})
    else if (telegram && ['error', 'signed-out', 'starting'].includes(telegram.status)) await telegram.start()
  })

  ipcMain.on('view:set', (_e, view) => {
    if (!VIEWS.includes(view)) return
    activeView = view
    panels.show(view)
  })
  ipcMain.on('panel:bounds', (_e, rect) => panels.setBounds(rect))

  ipcMain.handle('panel:reload', (_e, id) => {
    if (PANEL_IDS.includes(id)) panels.reload(id)
  })
  ipcMain.handle('panel:signOut', async (_e, id) => {
    if (!PANEL_IDS.includes(id)) return false
    const name = SERVICES[id].name
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Sign out', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: `Sign out of ${name}`,
      message: `Sign out of ${name} in IV Chat?`,
      detail:
        id === 'whatsapp'
          ? 'This removes WhatsApp from IV Chat only. Your phone keeps working. To remove IV Chat from your phone\'s list too, open WhatsApp on your phone and go to Linked devices.'
          : `This removes your ${id === 'messenger' ? 'Facebook' : name} sign-in from IV Chat only. Your other devices stay signed in.`
    })
    if (response !== 0) return false
    await panels.signOut(id)
    return true
  })

  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', (_e, patch) => updateSettings(patch || {}))

  ipcMain.handle('update:state', () => updateState())
  ipcMain.handle('update:check', () => updater?.check())
  ipcMain.handle('update:install', () => {
    // Closing to the tray is skipped only when an update is really about to install.
    if (updateState().status === 'ready') quitting = true
    updater?.install()
  })

  ipcMain.handle('about:licenses', () => {
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
    return shell.openPath(path.join(base, 'THIRD_PARTY_NOTICES.txt'))
  })

  // ---------- Telegram ----------

  const tgId = (id) => String(id ?? '').slice(0, 40)
  ipcMain.handle('telegram:state', () => telegram.state())
  ipcMain.handle('telegram:dialogs', () => (telegram.status === 'ready' ? telegram.dialogList() : []))
  ipcMain.handle('telegram:saveKeys', (_e, apiId, apiHash) => telegram.saveAppKeys(apiId, apiHash))
  ipcMain.handle('telegram:signIn', () => {
    telegram.signIn()
  })
  ipcMain.handle('telegram:password', (_e, pw) => telegram.submitPassword(pw))
  ipcMain.handle('telegram:cancel', () => telegram.cancelSignIn())
  ipcMain.handle('telegram:messages', (_e, id, opts) => telegram.messages(tgId(id), { limit: 40, beforeId: Number(opts?.beforeId) || 0 }))
  ipcMain.handle('telegram:markRead', (_e, id) => telegram.markRead(tgId(id)))
  ipcMain.handle('telegram:preview', (_e, id, msgId) => telegram.preview(tgId(id), Number(msgId)))
  // Reacting, like sending, is accepted only from IV Chat's own window: the person's click. The AI can't react.
  ipcMain.handle('telegram:react', async (e, id, msgId, emoji) => {
    if (e.sender !== win?.webContents) throw new Error('Not allowed')
    const value = emoji == null ? null : String(emoji).slice(0, 16)
    await telegram.reactFromPerson(tgId(id), Number(msgId), value)
  })
  ipcMain.handle('telegram:audio', (_e, id, msgId) => telegram.audio(tgId(id), Number(msgId)))
  ipcMain.handle('telegram:save', async (_e, id, msgId) => {
    const msg = await telegram.message(tgId(id), Number(msgId))
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save from Telegram',
      defaultPath: path.join(app.getPath('downloads'), telegram.suggestedName(msg))
    })
    if (canceled || !filePath) return null
    await telegram.saveMedia(tgId(id), Number(msgId), filePath)
    shell.showItemInFolder(filePath)
    return filePath
  })
  // The person picks a file to send. The window only gets a token and the file's name and size, and the
  // path stays here, so nothing but the person's own pick can ever be sent.
  ipcMain.handle('telegram:pickFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Send a picture or file', properties: ['openFile'] })
    if (canceled || !filePaths[0]) return null
    const filePath = filePaths[0]
    const size = fs.statSync(filePath).size
    if (size > 2000 * 1024 * 1024) throw new Error('Telegram files can be up to 2 GB')
    const token = crypto.randomUUID()
    pickedFiles.set(token, filePath)
    return { token, name: path.basename(filePath), size, image: /\.(png|jpe?g|gif|webp)$/i.test(filePath) }
  })
  ipcMain.handle('telegram:sendFile', async (e, id, token, caption) => {
    if (e.sender !== win?.webContents) throw new Error('Not allowed')
    const filePath = pickedFiles.get(token)
    if (!filePath) throw new Error('Pick the file again')
    pickedFiles.delete(token)
    await telegram.sendFileFromPerson(tgId(id), filePath, caption)
    delete aiDrafts[`telegram:${tgId(id)}`]
  })
  ipcMain.handle('telegram:refresh', () => telegram.refreshDialogs())
  // Sending exists only here: a request from IV Chat's own window, made by the person pressing Enter or Send.
  // The MCP has no way to reach it.
  ipcMain.handle('telegram:send', async (e, id, text) => {
    if (e.sender !== win?.webContents) throw new Error('Not allowed')
    await telegram.sendFromPerson(tgId(id), String(text ?? '').slice(0, 4096))
    delete aiDrafts[`telegram:${tgId(id)}`]
  })
  ipcMain.handle('telegram:signOut', async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Sign out', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Sign out of Telegram',
      message: 'Sign out of Telegram in IV Chat?',
      detail: 'This ends IV Chat\'s Telegram session. Your phone and other Telegram apps stay signed in.'
    })
    if (response !== 0) return false
    await telegram.signOut()
    return true
  })

  // ---------- AI access ----------

  ipcMain.handle('ai:get', () => aiState())
  ipcMain.handle('ai:setChat', (_e, key, on) => {
    if (typeof key !== 'string' || !key.includes(':') || key.length > 300) return aiState()
    settings = { ...settings, ai: setChatAccess(settings.ai, key, Boolean(on)) }
    saveSettings(settings)
    return aiState()
  })
  ipcMain.handle('ai:drafts', () => aiDrafts)
  ipcMain.handle('ai:clearDraft', (_e, key) => {
    delete aiDrafts[key]
  })
  // ---------- Draft button ----------

  ipcMain.handle('draft:engines', () => {
    const engines = findEngines()
    return { codex: Boolean(engines.codex), claude: Boolean(engines.claude), chosen: pickEngine(settings.draftEngine, engines), setting: settings.draftEngine }
  })
  ipcMain.handle('draft:cancel', () => draftAbort?.abort())
  ipcMain.handle('draft:telegram', (e, id, hint) =>
    drafting(e, `telegram:${tgId(id)}`, async (engine, enginePath, signal) => {
      const d = telegram.dialogs.get(tgId(id))
      if (!d) throw new Error('Open a Telegram chat first')
      const msgs = await telegram.messages(tgId(id), { limit: 25 })
      const prompt = buildDraftPrompt({
        service: 'telegram',
        chatName: d.name,
        messages: msgs.map((m) => ({ from: m.from, text: m.text, outgoing: m.outgoing, time: new Date(m.at).toLocaleString() })),
        prefs: settings.replyPrefs,
        hint
      })
      return { text: await runDraft(engine, enginePath, prompt, { signal }) }
    })
  )
  // Website panels: read the chat open in the panel, draft, and place it in that site's reply box.
  // Every site sends on Enter, so drafts are one paragraph.
  ipcMain.handle('draft:panel', (e, service, hint) => {
    const name = SERVICES[service]?.name
    return drafting(e, `${service}:open chat`, async (engine, enginePath, signal) => {
      if (!name) throw new Error('Unknown service')
      const read = await panels.whileDrawn(service, () => panels.assist(service, 'read', { limit: 25 }))
      if (!read?.chat) throw new Error(`Open a chat in ${name} first`)
      const prompt = buildDraftPrompt({ service, chatName: read.chat, messages: read.messages, prefs: settings.replyPrefs, hint, oneParagraph: true })
      const text = flattenDraft(await runDraft(engine, enginePath, prompt, { signal }))
      await panels.whileDrawn(service, () => panels.assist(service, 'draft', { text }))
      return { text, chat: read.chat }
    })
  })

  ipcMain.handle('ai:connect', (_e, target) => changeConnection(target, true))
  ipcMain.handle('ai:disconnect', (_e, target) => changeConnection(target, false))
}

// ---------- AI: Draft button, MCP, activity and Connect buttons ----------

let draftAbort = null
const ENGINE_NAMES = { codex: 'Codex', claude: 'Claude Code' }

// The Draft button runs only from the person's click in IV Chat's own window, with AI access on.
// It never sends; the result goes into the reply box.
async function drafting(e, chatKeyForLog, work) {
  if (e.sender !== win?.webContents) throw new Error('Not allowed')
  if (!settings.ai.enabled) throw new Error('AI access is off. Turn it on in the top bar to draft replies.')
  const engines = findEngines()
  const engine = pickEngine(settings.draftEngine, engines)
  if (!engine) throw new Error('Install Codex or Claude Code to draft replies here.')
  draftAbort?.abort()
  const controller = new AbortController()
  draftAbort = controller
  const entry = { at: Date.now(), tool: 'draft_button', chat_id: chatKeyForLog, ok: false }
  try {
    const result = await work(engine, engines[engine], controller.signal)
    entry.ok = true
    return { ...result, engine: ENGINE_NAMES[engine] }
  } catch (err) {
    entry.error = String(err?.message || err).slice(0, 200)
    throw err
  } finally {
    if (draftAbort === controller) draftAbort = null
    activity.push(entry)
    send('ai:activity', activity.slice(-50).reverse())
  }
}

// How Codex or Claude starts the bridge: IV Chat's own runtime in plain-Node mode.
const bridgeLaunch = () => ({
  command: process.execPath,
  args: [path.join(__dirname, 'bridge.js'), '--profile', app.getPath('userData')]
})

function aiState() {
  return {
    ai: settings.ai,
    activity: activity.slice(-50).reverse(),
    connections: {
      codex: connectors.codexConnected(),
      claudeDesktop: connectors.claudeDesktopConnected(),
      claudeCode: connectors.claudeCodeConnected()
    },
    launch: bridgeLaunch()
  }
}

const TARGETS = {
  codex: { name: 'Codex', file: () => connectors.codexConfigPath() },
  claudeDesktop: { name: 'Claude Desktop', file: () => connectors.claudeDesktopConfigPath() },
  claudeCode: { name: 'Claude Code', file: () => 'Claude Code\'s user settings (through its own "claude mcp" command)' }
}

async function changeConnection(target, connect) {
  const t = TARGETS[target]
  if (!t) throw new Error('Unknown app')
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [connect ? 'Connect' : 'Disconnect', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: `${connect ? 'Connect' : 'Disconnect'} ${t.name}`,
    message: connect ? `Let ${t.name} use IV Chat?` : `Remove IV Chat from ${t.name}?`,
    detail: `${connect ? 'IV Chat will add itself to' : 'IV Chat will remove only its own entry from'} ${t.file()}.${target === 'claudeCode' ? '' : ' A backup copy is saved next to it first.'} Restart ${t.name} afterwards.`
  })
  if (response !== 0) return { ...aiState(), message: null }
  const launch = bridgeLaunch()
  let message
  try {
    if (target === 'codex') {
      const r = connect ? connectors.connectCodex(launch) : connectors.disconnectCodex()
      message = connect ? `Added to ${r.file}.` : r.removed ? `Removed from ${r.file}.` : 'IV Chat was not in your Codex settings.'
      if (r.backup) message += ` Backup: ${r.backup}`
    } else if (target === 'claudeDesktop') {
      if (connect) {
        const r = connectors.connectClaudeDesktop(launch)
        settings = { ...settings, connections: { ...settings.connections, claudeDesktopInserted: r.inserted } }
        saveSettings(settings)
        message = `Added to ${r.file}.${r.backup ? ` Backup: ${r.backup}` : ''}`
      } else {
        const r = connectors.disconnectClaudeDesktop(settings.connections.claudeDesktopInserted)
        settings = { ...settings, connections: { ...settings.connections, claudeDesktopInserted: null } }
        saveSettings(settings)
        message = `Removed from ${r.file}. Backup: ${r.backup}`
      }
    } else {
      await (connect ? connectors.connectClaudeCode(launch) : connectors.disconnectClaudeCode())
      message = connect ? 'Added to Claude Code.' : 'Removed from Claude Code.'
    }
    message += ` Restart ${t.name} so it picks this up.`
  } catch (err) {
    return { ...aiState(), error: String(err?.message || err) }
  }
  return { ...aiState(), message }
}

function startAi() {
  const call = createTools({
    telegram,
    whatsapp: createWhatsApp(panels),
    getWebChats: () => panels.chatsSnapshot(),
    getAi: () => settings.ai,
    limiter: new RateLimiter({ calls: { max: 60, windowMs: 60e3 }, drafts: { max: 20, windowMs: 3600e3 } }),
    log: (entry) => {
      activity.push(entry)
      if (activity.length > 200) activity.shift()
      send('ai:activity', activity.slice(-50).reverse())
    },
    onDraft: (key, text) => {
      const service = key.slice(0, key.indexOf(':'))
      // Telegram drafts also fill IV Chat's own reply box; WhatsApp drafts are already in WhatsApp's.
      if (service === 'telegram') {
        aiDrafts[key] = text
        send('ai:draft', { key, text })
      }
      const name = service === 'whatsapp' ? 'WhatsApp' : 'Telegram'
      if (settings.notifications && !(win.isVisible() && win.isFocused() && activeView === service)) {
        notify('Draft ready', `Your AI drafted a reply in ${name}. Review it and press Enter to send.`, () => {
          showWindow()
          selectView(service)
        })
      }
    }
  })
  startMcpPipe(app.getPath('userData'), call)
}

function startTelegram() {
  telegram = new TelegramService()
  telegram.on('state', (s) => {
    send('telegram:state', s)
    refreshUnread()
  })
  telegram.on('dialogs', (d) => {
    send('telegram:dialogs', d)
    refreshUnread()
  })
  telegram.on('message', (id) => send('telegram:message', id))
  telegram.on('incoming', ({ chat_id, name }) => {
    if (!settings.notifications) return
    if (win.isVisible() && win.isFocused() && activeView === 'telegram') return
    notify('Telegram', name ? `New message from ${name}` : 'You have a new message.', () => {
      showWindow()
      selectView('telegram')
      send('telegram:open', chat_id)
    })
  })
  telegram.start()
}

// ---------- lifecycle ----------

app.on('second-instance', showWindow)

app.whenReady().then(() => {
  settings = loadSettings()
  startTelegram()
  registerIpc()
  createWindow()
  createTray()
  refreshUnread()
  startAi()
  updater = initUpdater((state) => send('update:changed', state))
})

app.on('before-quit', () => {
  quitting = true
  telegram?.disconnect()
})

// The window only really closes when quitting (or when close-to-tray is off).
app.on('window-all-closed', () => app.quit())
