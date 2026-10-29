// IV Chat updates itself from GitHub Releases (latest.yml is published next to the installer), the same
// way IV Downloader and IV Studio do: it checks on launch and every six hours, downloads a new version in
// the background, and installs it when the person clicks "Restart to update" or quits the app.
// IV_CHAT_UPDATE_FEED (a URL with a latest.yml) points a test copy at a local feed; such a copy never
// installs on quit, so a test can't replace the installed app.
import { app, shell } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater
const TEST_FEED = process.env.IV_CHAT_UPDATE_FEED
const SIX_HOURS = 6 * 60 * 60 * 1000

// macOS only installs updates into an app signed with an Apple Developer ID. Until the Mac build is
// signed, it reports new versions and sends people to the release page instead.
const MANUAL = process.platform === 'darwin'
const RELEASES = 'https://github.com/hollisorg/iv-chat/releases/latest'

let state = { status: 'idle', version: app.getVersion(), available: null, percent: null, error: null, checkedAt: null }

export function updateState() {
  return state
}

export function initUpdater(onChange) {
  const set = (patch) => {
    state = { ...state, ...patch }
    onChange(state)
  }

  // Development builds have no app-update.yml; only packaged builds check.
  if (!app.isPackaged) {
    set({ status: 'dev' })
    return { check: async () => state, install: () => false }
  }

  if (TEST_FEED) autoUpdater.setFeedURL({ provider: 'generic', url: TEST_FEED })
  autoUpdater.autoDownload = !MANUAL
  autoUpdater.autoInstallOnAppQuit = !MANUAL && !TEST_FEED

  const now = () => new Date().toISOString()
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }))
  autoUpdater.on('update-not-available', () => set({ status: 'current', available: null, checkedAt: now() }))
  autoUpdater.on('update-available', (info) =>
    set(
      MANUAL
        ? { status: 'available', available: info.version, checkedAt: now() }
        : { status: 'downloading', available: info.version, percent: 0, checkedAt: now() }
    )
  )
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: p.percent }))
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', available: info.version, percent: 100 }))
  autoUpdater.on('error', (err) => {
    const message = String(err?.message || err)
    // Before the first release is published (drafts only), GitHub has no "latest" to report.
    if (/Unable to find latest version/i.test(message)) return set({ status: 'current', error: null, checkedAt: now() })
    set({ status: 'error', error: message.split('\n')[0] })
  })

  const check = async () => {
    // A download in progress, or one waiting to install, isn't restarted by another check.
    if (state.status === 'downloading' || state.status === 'ready') return state
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      /* reported through the error event */
    }
    return state
  }

  setTimeout(check, 10_000)
  setInterval(check, SIX_HOURS)

  return {
    check,
    // Silent install, then IV Chat opens again on the new version.
    install: () => {
      if (MANUAL) {
        shell.openExternal(RELEASES)
        return false
      }
      if (state.status !== 'ready') return false
      autoUpdater.quitAndInstall(true, true)
      return true
    }
  }
}
