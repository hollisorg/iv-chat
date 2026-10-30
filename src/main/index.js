import { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, protocol, shell } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Panels } from './panels'
import { SERVICES, PANEL_IDS, sanitizeChats, totalUnread } from './services'
import { applyPatch, loadSettings, saveSettings } from './settings'
import { initUpdater, updateState } from './updater'
import { TelegramService } from './telegram'
import { checkUnlock, forgetLocked, holdStore } from './secure-store'
import { borrowedFolder } from './package-guard.js'
import { MediaCache, SCHEME as MEDIA_SCHEME, mediaUrl } from './tg-media.js'
import { webmToOgg } from './ogg-opus.js'
import { countsAsUnread } from './tg-format.js'
import { RateLimiter, setChatAccess } from './ai-access.js'
import { accessDecision } from './media-settings.js'
import { createTools } from './mcp-tools.js'
import { startMcpPipe } from './mcp-pipe'
import * as connectors from './connectors.js'
import { createWhatsApp } from './whatsapp.js'
import { buildDraftPrompt, findEngines, pickEngine, runDraft } from './ai-draft.js'
import { flattenDraft } from './whatsapp-parse.js'

// Tests run against a throwaway profile so they never touch real sign-ins (scripts/smoke-test.mjs).
if (process.env.IV_CHAT_PROFILE) app.setPath('userData', process.env.IV_CHAT_PROFILE)

// ivtg:// carries Telegram videos, GIFs and full photos to the window's own players (tg-media.js). It has to be
// declared before the app is ready so <video> can stream from it and seek.
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])

// One IV Chat at a time; opening it again brings the existing window forward.
if (!app.requestSingleInstanceLock()) app.quit()

// Windows shows the icon of whichever shortcut carries this ID, so development runs (electron.exe) use
// their own ID and can't lend the installed app Electron's logo.
app.setAppUserModelId(app.isPackaged ? 'ai.infinitevariance.chat' : 'ai.infinitevariance.chat.dev')

const VIEWS = ['updates', 'telegram', ...PANEL_IDS, 'settings']
const resource = (name) => path.join(app.getAppPath(), 'resources', name)
const startHidden = process.argv.includes('--hidden')
// Set on the one automatic restart IV Chat makes when it can't unlock its saved sign-ins (see unlockAtStart).
const UNLOCK_RETRY = '--unlock-retry'

let settings
let win = null
let panels = null
let tray = null
let updater = null
let quitting = false
let activeView = 'updates'
let telegram = null
let unlock = 'ok' // 'locked' while the saved sign-ins can't be opened; see unlockAtStart()
let borrowed = null // { app } when started inside another app's package; see unlockAtStart()
const activity = [] // the AI's recent tool calls, without message text; memory only
const aiDrafts = {} // chat key -> latest AI draft, shown in the Telegram reply box
const pickedFiles = new Map() // token -> file the person picked to send in Telegram

// The window is destroyed while quitting, but panels and Telegram can still fire events for a moment.
const alive = () => Boolean(win && !win.isDestroyed())
const inFront = (view) => alive() && win.isVisible() && win.isFocused() && (view === undefined || activeView === view)

function send(channel, payload) {
  if (alive()) win.webContents.send(channel, payload)
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
  guardOwnMedia(win.webContents.session)

  // The app's own UI never navigates; external links open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Links in messages: web pages, e-mail addresses and Telegram's own tg:// links.
    if (/^(https?:\/\/|mailto:|tg:\/\/)/i.test(url)) shell.openExternal(url)
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

  panels.setMedia(settings.media)
  panels.locked = unlock === 'locked'
  panels.sync(settings)
  panels.setReader(settings.latestMessages)
}

// IV Chat's own window (Telegram, voice messages, the Settings device tests) follows the "Telegram and IV Chat"
// choice in Settings > Calls and devices. Other permissions keep Electron's defaults for the app's own page.
let ownMediaGrant = null
function guardOwnMedia(ses) {
  const media = () => accessDecision(settings.media.access.telegram, ownMediaGrant)
  // Checks decide whether IV Chat's own page sees device names (to find the chosen microphone, camera and
  // speaker); they stay visible unless blocked. Actually opening the microphone or camera is a request (below).
  ses.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'media' || permission === 'speaker-selection') return media() !== false
    return true
  })
  ses.setPermissionRequestHandler(async (_wc, permission, callback, details) => {
    if (permission === 'speaker-selection') return callback(media() !== false)
    if (permission !== 'media') return callback(true)
    const known = media()
    if (known !== null) return callback(known)
    const what = (details.mediaTypes || []).join(' and ') || 'microphone or camera'
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Allow', 'Block'],
      defaultId: 0,
      cancelId: 1,
      title: 'IV Chat',
      message: `IV Chat wants to use your ${what}.`,
      detail: 'For Telegram voice messages and the device tests in Settings. This lasts until IV Chat is closed. To decide for good, choose Allow or Block in Settings > Calls and devices.'
    })
    ownMediaGrant = response === 0
    callback(ownMediaGrant)
  })
}

function showWindow() {
  if (!alive()) return
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

const telegramUnread = () => (telegram?.status === 'ready' ? telegram.dialogList().filter(countsAsUnread).length : 0)

function refreshUnread() {
  if (!alive() || !tray || tray.isDestroyed()) return
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
  if (inFront(id)) return
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
  // Inside another app's package the startup entry would only be written to that app's private registry.
  if (before.launchAtLogin !== settings.launchAtLogin && app.isPackaged && !borrowed) {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: ['--hidden'] })
  }
  panels?.sync(settings)
  panels?.setReader(settings.latestMessages)
  panels?.setMedia(settings.media)
  if (settings.media.access.telegram === 'ask' && before.media.access.telegram !== 'ask') ownMediaGrant = null
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
  // A panel page asks, as it loads, which microphone, camera and speaker were chosen (names only).
  ipcMain.on('panel:media', (e) => {
    e.returnValue = panels.wantedDevices()
  })

  ipcMain.handle('app:copy', (_e, text) => clipboard.writeText(String(text ?? '').slice(0, 20000)))

  // Saved sign-ins that couldn't be unlocked at startup (see unlockAtStart): restart, or start over.
  ipcMain.handle('app:unlock', () => unlockState())
  ipcMain.handle('app:restart', (e) => {
    fromWindow(e)
    // Restarting from inside another app's package would start inside it again.
    if (borrowed) throw new Error('Close IV Chat and open it from the Start menu instead.')
    restartApp(false)
  })
  ipcMain.handle('app:quit', (e) => {
    fromWindow(e)
    quitting = true
    app.quit()
  })
  // The person chose to sign in again rather than restart: removes only the saved sign-ins that can't be
  // opened (website panels lose theirs too, since their cookies use the same key).
  ipcMain.handle('app:startOver', (e) => {
    fromWindow(e)
    if (borrowed) throw new Error('Close IV Chat and open it from the Start menu instead.')
    unlock = forgetLocked()
    if (unlock !== 'locked') {
      panels.locked = false
      panels.sync(settings)
      telegram.start()
    }
    send('app:unlock', unlockState())
    return unlockState()
  })

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
  // Reply, send without sound, or send later (a time at least a minute ahead, within a year).
  const sendOpts = (opts) => {
    const schedule = Number(opts?.schedule) || 0
    const ok = schedule > Date.now() + 30_000 && schedule < Date.now() + 365 * 86400e3
    return { replyTo: Number(opts?.replyTo) || 0, silent: Boolean(opts?.silent), schedule: ok ? schedule : 0 }
  }
  ipcMain.handle('telegram:state', () => telegram.state())
  ipcMain.handle('telegram:dialogs', () => (telegram.status === 'ready' ? telegram.dialogList() : []))
  ipcMain.handle('telegram:saveKeys', (_e, apiId, apiHash) => telegram.saveAppKeys(apiId, apiHash))
  ipcMain.handle('telegram:signIn', () => {
    telegram.signIn()
  })
  ipcMain.handle('telegram:password', (_e, pw) => telegram.submitPassword(pw))
  ipcMain.handle('telegram:cancel', () => telegram.cancelSignIn())
  ipcMain.handle('telegram:messages', (_e, id, opts) =>
    telegram.messages(tgId(id), { limit: 40, beforeId: Number(opts?.beforeId) || 0, aroundId: Number(opts?.aroundId) || 0 })
  )
  ipcMain.handle('telegram:chatInfo', (_e, id) => telegram.chatInfo(tgId(id)))
  ipcMain.handle('telegram:pinned', (_e, id) => telegram.pinned(tgId(id)))
  ipcMain.handle('telegram:avatar', (_e, id) => telegram.avatar(tgId(id)))
  ipcMain.handle('telegram:folders', () => (telegram.status === 'ready' ? telegram.folderList() : []))
  ipcMain.handle('telegram:findChats', (_e, query) => telegram.findChats(String(query ?? '').slice(0, 64)))
  ipcMain.handle('telegram:openFound', (_e, id) => telegram.openFound(tgId(id)))
  ipcMain.handle('telegram:details', (_e, id) => telegram.chatDetails(tgId(id)))
  ipcMain.handle('telegram:scheduled', (_e, id) => telegram.scheduled(tgId(id)))
  ipcMain.handle('telegram:translate', (_e, id, msgIds, toLang) => telegram.translate(tgId(id), (Array.isArray(msgIds) ? msgIds : [msgIds]).map(Number).slice(0, 50), String(toLang || 'en')))
  ipcMain.handle('telegram:shared', (_e, id, kind, beforeId) => telegram.sharedMedia(tgId(id), String(kind), Number(beforeId) || 0))
  ipcMain.handle('telegram:search', (_e, id, query) => telegram.search(String(query ?? '').slice(0, 200), tgId(id)))
  ipcMain.handle('telegram:mediaUrl', (_e, id, msgId) => mediaUrl(tgId(id), Number(msgId)))
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
  // Files dropped on the chat or pasted into it: like the picker, the window gets a token and the file stays here.
  const stage = (filePath, name) => {
    const size = fs.statSync(filePath).size
    if (size > 2000 * 1024 * 1024) throw new Error('Telegram files can be up to 2 GB')
    const token = crypto.randomUUID()
    pickedFiles.set(token, filePath)
    return { token, name: name || path.basename(filePath), size, image: /\.(png|jpe?g|gif|webp)$/i.test(name || filePath) }
  }
  // A voice message recorded in the window (WebM Opus), rewrapped as OGG Opus and sent. Only the person's
  // own click in this window can do this.
  ipcMain.handle('telegram:sendVoice', async (e, id, bytes, waveform, opts) => {
    if (e.sender !== win?.webContents) throw new Error('Not allowed')
    const webm = Buffer.from(bytes)
    if (!webm.length || webm.length > 20 * 1024 * 1024) throw new Error('That recording is too long to send')
    const { ogg, seconds } = webmToOgg(webm)
    const dir = path.join(app.getPath('temp'), 'iv-chat-uploads')
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `voice-${crypto.randomUUID()}.ogg`)
    fs.writeFileSync(filePath, ogg)
    try {
      const levels = Array.isArray(waveform) ? waveform.slice(0, 100).map(Number).filter(Number.isFinite) : []
      await telegram.sendVoiceFromPerson(tgId(id), filePath, { seconds, waveform: levels, replyTo: Number(opts?.replyTo) || 0 })
    } finally {
      fs.rm(filePath, { force: true }, () => {})
    }
    delete aiDrafts[`telegram:${tgId(id)}`]
  })
  ipcMain.handle('telegram:stagePath', (e, filePath) => {
    if (e.sender !== win?.webContents) throw new Error('Not allowed')
    const p = String(filePath || '')
    if (!path.isAbsolute(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error("That file can't be sent")
    return stage(p)
  })
  ipcMain.handle('telegram:stageBytes', (e, name, bytes) => {
    if (e.sender !== win?.webContents) throw new Error('Not allowed')
    const buf = Buffer.from(bytes)
    if (!buf.length || buf.length > 50 * 1024 * 1024) throw new Error('Pasted pictures can be up to 50 MB')
    const safe = String(name || 'pasted.png').replace(/[^\w.-]/g, '_').slice(0, 80)
    const dir = path.join(app.getPath('temp'), 'iv-chat-uploads')
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${crypto.randomUUID()}-${safe}`)
    fs.writeFileSync(filePath, buf)
    return stage(filePath, safe)
  })
  ipcMain.handle('telegram:sendFile', async (e, id, token, caption, opts) => {
    if (e.sender !== win?.webContents) throw new Error('Not allowed')
    const filePath = pickedFiles.get(token)
    if (!filePath) throw new Error('Pick the file again')
    pickedFiles.delete(token)
    await telegram.sendFileFromPerson(tgId(id), filePath, caption, sendOpts(opts))
    delete aiDrafts[`telegram:${tgId(id)}`]
  })
  ipcMain.handle('telegram:refresh', () => telegram.refreshDialogs())
  // Sending exists only here: a request from IV Chat's own window, made by the person pressing Enter or Send.
  // The MCP has no way to reach it.
  ipcMain.handle('telegram:send', async (e, id, text, opts) => {
    if (e.sender !== win?.webContents) throw new Error('Not allowed')
    await telegram.sendFromPerson(tgId(id), String(text ?? '').slice(0, 4096), sendOpts(opts))
    delete aiDrafts[`telegram:${tgId(id)}`]
  })
  // Editing, deleting, forwarding and pinning: like sending, only from the person's own clicks in this window.
  const fromWindow = (e) => {
    if (e.sender !== win?.webContents) throw new Error('Not allowed')
  }
  const ids = (list) => (Array.isArray(list) ? list : [list]).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100)
  ipcMain.handle('telegram:edit', async (e, id, msgId, text) => {
    fromWindow(e)
    await telegram.editFromPerson(tgId(id), Number(msgId), String(text ?? '').slice(0, 4096))
  })
  ipcMain.handle('telegram:delete', async (e, id, msgIds, everyone) => {
    fromWindow(e)
    await telegram.deleteFromPerson(tgId(id), ids(msgIds), Boolean(everyone))
  })
  ipcMain.handle('telegram:forward', async (e, fromId, msgIds, toId) => {
    fromWindow(e)
    await telegram.forwardFromPerson(tgId(fromId), ids(msgIds), tgId(toId))
  })
  // Polls, bot buttons and scheduled messages: also only from the person's clicks.
  // Declining a ringing call: only from the person's click on the call banner.
  ipcMain.handle('telegram:declineCall', async (e, callId) => {
    fromWindow(e)
    await telegram.declineCall(String(callId).slice(0, 30))
  })
  ipcMain.handle('telegram:vote', async (e, id, msgId, options) => {
    fromWindow(e)
    await telegram.voteFromPerson(tgId(id), Number(msgId), (Array.isArray(options) ? options : []).map(String).slice(0, 10))
  })
  ipcMain.handle('telegram:sendPoll', async (e, id, poll, opts) => {
    fromWindow(e)
    const p = poll || {}
    await telegram.sendPollFromPerson(tgId(id), { question: String(p.question ?? ''), answers: (Array.isArray(p.answers) ? p.answers : []).map(String), multiple: Boolean(p.multiple), quiz: Boolean(p.quiz), correct: Number(p.correct) || 0, anonymous: p.anonymous !== false }, sendOpts(opts))
  })
  ipcMain.handle('telegram:pressButton', async (e, id, msgId, data, game) => {
    fromWindow(e)
    return telegram.pressButtonFromPerson(tgId(id), Number(msgId), String(data ?? ''), Boolean(game))
  })
  ipcMain.handle('telegram:sendScheduledNow', async (e, id, msgIds) => {
    fromWindow(e)
    await telegram.sendScheduledNowFromPerson(tgId(id), ids(msgIds))
  })
  ipcMain.handle('telegram:deleteScheduled', async (e, id, msgIds) => {
    fromWindow(e)
    await telegram.deleteScheduledFromPerson(tgId(id), ids(msgIds))
  })
  // The chat list's own actions, also only from the person's clicks.
  ipcMain.handle('telegram:pinChat', async (e, id, pinned) => {
    fromWindow(e)
    await telegram.pinChatFromPerson(tgId(id), Boolean(pinned))
  })
  ipcMain.handle('telegram:mute', async (e, id, until) => {
    fromWindow(e)
    await telegram.muteFromPerson(tgId(id), until === 'forever' ? Infinity : Math.max(0, Number(until) || 0))
  })
  ipcMain.handle('telegram:archive', async (e, id, archived) => {
    fromWindow(e)
    await telegram.archiveFromPerson(tgId(id), Boolean(archived))
  })
  ipcMain.handle('telegram:markUnread', async (e, id, unread) => {
    fromWindow(e)
    await telegram.markUnreadFromPerson(tgId(id), Boolean(unread))
  })
  ipcMain.handle('telegram:pin', async (e, id, msgId, unpin) => {
    fromWindow(e)
    await telegram.pinFromPerson(tgId(id), Number(msgId), Boolean(unpin))
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
      if (settings.notifications && !inFront(service)) {
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
  telegram.on('typing', (t) => send('telegram:typing', t))
  telegram.on('folders', (f) => send('telegram:folders', f))
  telegram.on('status', (id) => send('telegram:status', id))
  // Someone calling: the banner in the window (which rings), plus a notification if the window isn't in front.
  telegram.on('call', (c) => {
    send('telegram:call', c)
    if (c.state !== 'ringing' || !settings.notifications) return
    if (inFront()) return
    notify(c.name ? `${c.name} is calling` : 'Incoming Telegram call', `Telegram ${c.video ? 'video call' : 'call'}. Answer on your phone or in Telegram Desktop.`, () => {
      showWindow()
    })
  })
  telegram.on('missed-call', ({ chat_id, name }) => {
    if (!settings.notifications) return
    notify('Telegram', name ? `Missed call from ${name}` : 'Missed call', () => {
      showWindow()
      selectView('telegram')
      send('telegram:open', chat_id)
    })
  })
  telegram.on('incoming', ({ chat_id, name }) => {
    if (!settings.notifications) return
    if (inFront('telegram')) return
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

// Saved sign-ins (Telegram's, and the website panels' cookies) are locked with one Windows-protected key.
// Once, right after a Windows restart, IV Chat couldn't open it and everything looked signed out although
// it was all still saved, and a plain restart brought it back. So check first; while locked, don't load the
// websites or offer to sign in again (either could replace a saved sign-in), and restart once by itself.
function unlockAtStart() {
  // Started inside another app's package (package-guard.js): this isn't the person's real IV Chat folder, so
  // load nothing and write nothing, and say how to open IV Chat properly. No restart: it would land there again.
  borrowed = borrowedFolder({ userData: app.getPath('userData'), appData: app.getPath('appData'), localAppData: process.env.LOCALAPPDATA })
  if (borrowed) {
    holdStore()
    unlock = 'locked'
    return
  }
  unlock = checkUnlock()
  if (unlock !== 'locked' || process.argv.includes(UNLOCK_RETRY)) return
  setTimeout(() => restartApp(true), 20_000)
}

function unlockState() {
  return {
    locked: unlock === 'locked',
    retrying: unlock === 'locked' && !borrowed && !process.argv.includes(UNLOCK_RETRY),
    borrowedBy: borrowed?.app ?? null
  }
}

function restartApp(automatic) {
  const args = process.argv.slice(1).filter((a) => a !== UNLOCK_RETRY)
  app.relaunch({ args: automatic ? [...args, UNLOCK_RETRY] : args })
  quitting = true
  telegram?.disconnect()
  app.exit(0)
}

app.whenReady().then(() => {
  settings = loadSettings()
  unlockAtStart()
  startTelegram()
  const media = new MediaCache(path.join(app.getPath('temp'), 'iv-chat-media'), (chatId, msgId) => telegram.mediaSource(String(chatId).slice(0, 40), msgId))
  protocol.handle(MEDIA_SCHEME, (request) => media.respond(request))
  registerIpc()
  createWindow()
  createTray()
  refreshUnread()
  // Borrowed folder: no AI connection and no self-update (an update would reopen IV Chat in the same place).
  if (borrowed) return
  startAi()
  updater = initUpdater((state) => send('update:changed', state))
})

app.on('before-quit', () => {
  quitting = true
  telegram?.disconnect()
})

// The window only really closes when quitting (or when close-to-tray is off).
app.on('window-all-closed', () => app.quit())
