// The WhatsApp and Messenger panels: each is the real website in its own sandboxed WebContentsView
// with its own persistent session. IV Chat only watches the tab title for the unread count, keeps
// navigation on the service's own domains, and runs src/preload/panel.js: a passkey guard plus a
// read-only chat list reader for the Updates page.
import { Menu, WebContentsView, clipboard, dialog, session, shell } from 'electron'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { SERVICES, PANEL_IDS, READS_CHATS, chromeUserAgent, hostAllowed, parseUnread, popupAllowed } from './services'
import { MEDIA_DEFAULTS, accessDecision, checkAnswer } from './media-settings.js'

// Chromium's code for a navigation that was replaced by another one; not a real failure.
const ERR_ABORTED = -3

const PANEL_PRELOAD = path.join(__dirname, '../preload/panel.js')

// Keys that still work while a panel has focus (the panel would otherwise swallow them).
const SHORTCUTS = { 1: 'updates', 2: 'telegram', 3: 'whatsapp', 4: 'messenger', 5: 'instagram', 6: 'linkedin', ',': 'settings' }

export class Panels extends EventEmitter {
  constructor(win) {
    super()
    this.win = win
    this.views = new Map()
    this.bounds = { x: 0, y: 0, width: 0, height: 0 }
    this.active = null
    this.configured = new Set()
    // Answers to "wants to use your microphone and camera" for services set to Ask, for this run only.
    this.mediaGrants = new Map()
    this.media = MEDIA_DEFAULTS
    this.states = Object.fromEntries(PANEL_IDS.map((id) => [id, { id, enabled: false, state: 'off', unread: 0 }]))
    // Latest chats read from each panel's chat list. Kept in memory only, never written to disk.
    this.readerOn = false
    this.assistSeq = 0
    this.assistWaiting = new Map()
    this.assistQueue = Promise.resolve()
    this.borrowed = null
    this.locked = false
    win.on('resize', () => this.layout())
    this.chats = Object.fromEntries(PANEL_IDS.map((id) => [id, { status: 'off', chats: [] }]))
  }

  // ---------- devices and access ----------

  // Settings > Calls and devices. Switching a service back to Ask forgets this run's answer for it.
  setMedia(media) {
    for (const id of PANEL_IDS) {
      if (media.access[id] === 'ask' && this.media.access[id] !== 'ask') this.mediaGrants.delete(id)
    }
    this.media = media
    for (const view of this.views.values()) view.webContents.send('media:set', this.wantedDevices())
  }

  wantedDevices() {
    return { mic: this.media.mic, camera: this.media.camera, speaker: this.media.speaker }
  }

  // ---------- latest messages ----------

  setReader(on) {
    this.readerOn = Boolean(on)
    for (const view of this.views.values()) view.webContents.send('reader:set', this.readerOn)
    if (!this.readerOn) for (const id of PANEL_IDS) this.setChats(id, { status: 'off', chats: [] })
  }

  // Only accept chat lists from the panel's own page, not from pop-ups or anything else.
  chatsFrom(webContentsId, sanitized) {
    if (!this.readerOn) return
    const id = [...this.views].find(([, v]) => v.webContents.id === webContentsId)?.[0]
    if (id) this.setChats(id, sanitized)
  }

  setChats(id, value) {
    this.chats[id] = value
    this.emit('chats', this.chatsSnapshot())
  }

  chatsSnapshot() {
    return Object.fromEntries(PANEL_IDS.map((id) => [id, { ...this.chats[id] }]))
  }

  snapshot() {
    return Object.values(this.states).map((s) => ({ ...s }))
  }

  update(id, patch) {
    const before = this.states[id]
    this.states[id] = { ...before, ...patch }
    if (patch.unread !== undefined && patch.unread > before.unread) this.emit('unread-increased', id, patch.unread)
    this.emit('change', this.snapshot())
  }

  // ---------- lifecycle ----------

  // While IV Chat can't unlock its saved sign-ins (index.js unlockAtStart) no website is loaded: a site
  // that can't read its cookies would show its login page, and signing in there would replace them.
  sync(settings) {
    for (const id of PANEL_IDS) {
      const want = settings.services[id].enabled && !this.locked
      if (want && !this.views.has(id)) this.create(id)
      if (!want && this.views.has(id)) this.destroy(id)
    }
    this.layout()
  }

  create(id) {
    const service = SERVICES[id]
    this.configureSession(service)
    const view = new WebContentsView({
      webPreferences: {
        partition: service.partition,
        preload: PANEL_PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Keep the site's connection alive while another panel is showing.
        backgroundThrottling: false,
        spellcheck: true
      }
    })
    view.setBackgroundColor('#100c0e')
    view.setVisible(false)
    this.win.contentView.addChildView(view)
    this.views.set(id, view)
    this.wire(service, view.webContents)
    this.update(id, { enabled: true, state: 'loading', unread: 0 })
    view.webContents.loadURL(service.url)
  }

  destroy(id) {
    const view = this.views.get(id)
    this.views.delete(id)
    if (view) {
      this.win.contentView.removeChildView(view)
      view.webContents.close()
    }
    this.update(id, { enabled: false, state: 'off', unread: 0 })
    this.setChats(id, { status: 'off', chats: [] })
  }

  configureSession(service) {
    if (this.configured.has(service.id)) return
    this.configured.add(service.id)
    const ses = session.fromPartition(service.partition)
    ses.setUserAgent(chromeUserAgent(ses.getUserAgent()))

    // IV Chat raises its own notifications (see index.js), so the sites' own ones are declined.
    // Microphone and camera follow Settings > Calls and devices: Allow, Block, or ask when a site first wants
    // them. Choosing a speaker goes with that. Everything else is declined.
    const media = () => accessDecision(this.media.access[service.id], this.mediaGrants.get(service.id))
    const decide = (permission) => {
      if (permission === 'clipboard-sanitized-write' || permission === 'fullscreen') return true
      if (permission === 'media') return media()
      if (permission === 'speaker-selection') return media() === true
      return false
    }
    ses.setPermissionCheckHandler((_wc, permission) => (permission === 'media' ? checkAnswer(media()) : decide(permission) === true))
    ses.setPermissionRequestHandler(async (_wc, permission, callback, details) => {
      const known = decide(permission)
      if (known !== null) return callback(known)
      const what = (details.mediaTypes || []).join(' and ') || 'microphone or camera'
      const { response } = await dialog.showMessageBox(this.win, {
        type: 'question',
        buttons: ['Allow', 'Block'],
        defaultId: 0,
        cancelId: 1,
        title: service.name,
        message: `${service.name} wants to use your ${what}.`,
        detail: 'This lasts until IV Chat is closed. To decide for good, choose Allow or Block in Settings > Calls and devices.'
      })
      this.mediaGrants.set(service.id, response === 0)
      callback(response === 0)
    })
  }

  wire(service, wc) {
    const id = service.id

    wc.on('page-title-updated', (_e, title) => this.update(id, { unread: parseUnread(title) }))
    wc.on('did-start-loading', () => {
      if (this.states[id].state !== 'ready') this.update(id, { state: 'loading' })
    })
    wc.on('did-finish-load', () => {
      this.update(id, { state: 'ready', error: null })
      // A full page load starts the reader and device choice fresh, so tell them again.
      wc.send('reader:set', this.readerOn)
      wc.send('media:set', this.wantedDevices())
    })
    wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return
      this.update(id, { state: 'error', error: description || `Error ${code}` })
      this.layout()
    })
    wc.on('render-process-gone', (_e, details) => {
      this.update(id, { state: 'error', error: `The page stopped (${details.reason})` })
      this.layout()
    })

    // Navigation stays on the service's own domains; other links open in the default browser.
    const guard = (e, url, isMainFrame = true) => {
      if (!isMainFrame || hostAllowed(service, url)) return
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    }
    wc.on('will-navigate', (e) => guard(e, e.url))
    wc.on('will-redirect', (e) => guard(e, e.url, e.isMainFrame))
    wc.setWindowOpenHandler(({ url }) => {
      if (popupAllowed(service, url)) {
        // Calls and sign-in pop-ups stay inside the same signed-in session.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: this.win,
            autoHideMenuBar: true,
            backgroundColor: '#100c0e',
            webPreferences: {
              partition: service.partition,
              preload: PANEL_PRELOAD,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false
            }
          }
        }
      }
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
    // A pop-up kept in IV Chat may move between the site and its sign-in pages. If it heads anywhere else
    // (an ordinary link opened through a blank window), that goes to the default browser instead, and a
    // pop-up left with nothing in it closes.
    wc.on('did-create-window', (child) => {
      const popupGuard = (e, url) => {
        if (popupAllowed(service, url)) return
        e.preventDefault()
        if (/^https?:\/\//i.test(url)) shell.openExternal(url)
        const blank = child.webContents.getURL()
        if (!blank || blank === 'about:blank') child.close()
      }
      child.webContents.on('will-navigate', (e) => popupGuard(e, e.url))
      child.webContents.on('will-redirect', (e) => e.isMainFrame && popupGuard(e, e.url))
    })

    wc.on('context-menu', (_e, p) => this.contextMenu(wc, p))

    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return
      const view = SHORTCUTS[input.key]
      if (view) {
        e.preventDefault()
        this.emit('shortcut', view)
      }
    })
  }

  contextMenu(wc, p) {
    const items = []
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) })
      if (items.length) items.push({ type: 'separator' })
    }
    if (p.linkURL && /^https?:\/\//i.test(p.linkURL)) {
      items.push({ label: 'Open link in browser', click: () => shell.openExternal(p.linkURL) })
      items.push({ label: 'Copy link', click: () => clipboard.writeText(p.linkURL) })
      items.push({ type: 'separator' })
    }
    if (p.isEditable) {
      items.push({ role: 'cut', enabled: p.editFlags.canCut })
      items.push({ role: 'copy', enabled: p.editFlags.canCopy })
      items.push({ role: 'paste', enabled: p.editFlags.canPaste })
      items.push({ role: 'selectAll' })
    } else if (p.selectionText) {
      items.push({ role: 'copy' })
    }
    if (!items.length) return
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }

  // ---------- layout ----------

  setBounds(rect) {
    const n = (v) => Math.max(0, Math.round(Number(v) || 0))
    this.bounds = { x: n(rect?.x), y: n(rect?.y), width: n(rect?.width), height: n(rect?.height) }
    this.layout()
  }

  show(id) {
    this.active = PANEL_IDS.includes(id) ? id : null
    // With no panel on screen nothing reports the area, so fall back to working it out (see area()).
    if (!this.active) this.bounds = { x: 0, y: 0, width: 0, height: 0 }
    this.layout()
    const view = this.views.get(this.active)
    if (view && this.states[this.active].state !== 'error') view.webContents.focus()
  }

  // The panel area. Until the window has reported it, it's worked out from the layout: everything right of
  // the 210px sidebar and below the 40px title bar.
  area() {
    if (this.bounds.width > 0) return this.bounds
    const { width, height } = this.win.getContentBounds()
    return { x: 210, y: 40, width: Math.max(0, width - 210), height: Math.max(0, height - 40) }
  }

  // Only the active panel is visible, and only while it has something to show. Errors are drawn by the
  // app UI underneath, so the panel steps aside for them. Hidden panels keep their full size: WhatsApp only
  // draws the messages that fit, so a zero-size hidden panel would show the AI a single message.
  layout() {
    // Pages can still report a load failure or a stopped page while the window is closing.
    if (this.win.isDestroyed()) return
    const area = this.area()
    const front = this.borrowed ?? this.active
    for (const [id, view] of this.views) {
      view.setBounds(area)
      view.setVisible(id === front && this.states[id].state !== 'error' && area.width > 0)
    }
  }

  // ---------- assisted mode ----------

  // Electron gives a hidden panel's page zero height, and WhatsApp only lays out the messages that fit. So
  // while the AI opens, reads or drafts in WhatsApp, its panel is shown for that moment (the person sees
  // what the AI opened), then IV Chat goes back to what was on screen.
  async whileDrawn(id, fn) {
    if (this.active === id) return fn()
    this.borrowed = id
    this.layout()
    await new Promise((r) => setTimeout(r, 900))
    try {
      return await fn()
    } finally {
      this.borrowed = null
      this.layout()
    }
  }

  // Runs one WhatsApp action (open, read or draft) inside the panel and waits for its answer.
  // Actions run one at a time so two AI requests can't interleave in the same page.
  assist(id, op, args, timeoutMs = 8000) {
    const run = () =>
      new Promise((resolve, reject) => {
        const view = this.views.get(id)
        if (!view || this.states[id].state === 'error') return reject(new Error(`${SERVICES[id].name} is not open in IV Chat.`))
        const reqId = ++this.assistSeq
        const timer = setTimeout(() => {
          this.assistWaiting.delete(reqId)
          reject(new Error(`${SERVICES[id].name} did not answer in time.`))
        }, timeoutMs)
        this.assistWaiting.set(reqId, { webContentsId: view.webContents.id, resolve, reject, timer })
        view.webContents.send('assist:run', { id: reqId, op, args })
      })
    const next = this.assistQueue.then(run, run)
    this.assistQueue = next.catch(() => {})
    return next
  }

  assistReply(webContentsId, { id, ok, result, error } = {}) {
    const w = this.assistWaiting.get(id)
    if (!w || w.webContentsId !== webContentsId) return
    this.assistWaiting.delete(id)
    clearTimeout(w.timer)
    if (ok) w.resolve(result)
    else w.reject(new Error(String(error || 'Something went wrong')))
  }

  reloadAll() {
    for (const id of this.views.keys()) this.reload(id)
  }

  // ---------- actions ----------

  reload(id) {
    const view = this.views.get(id)
    if (!view) return
    this.update(id, { state: 'loading', error: null })
    this.setChats(id, { status: this.readerOn && READS_CHATS.includes(id) ? 'no-list' : 'off', chats: [] })
    this.layout()
    view.webContents.loadURL(SERVICES[id].url)
  }

  // Signs out of one service only: clears that panel's cookies and stored data, then starts fresh.
  async signOut(id) {
    const ses = session.fromPartition(SERVICES[id].partition)
    await ses.clearStorageData()
    await ses.clearCache()
    this.update(id, { unread: 0 })
    this.reload(id)
  }
}
