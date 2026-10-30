// Whether IV Chat was started from inside another app's Windows package (an MSIX app such as the Claude
// desktop app). Windows then quietly gives it that app's private copy of AppData: new files land in
// %LOCALAPPDATA%\Packages\<app>\LocalCache\Roaming\IV Chat instead of %APPDATA%\IV Chat. Signed in there,
// IV Chat looks signed out when Windows starts it normally, and the other way round (seen 2026-10-29/30).
//
// Windows doesn't say so directly, so IV Chat writes a tiny marker into its own folder and looks for it in
// each app's private copy. Found there means borrowed. The marker is removed straight away.
import fs from 'node:fs'
import path from 'node:path'

// { app: 'Claude', folder } when the profile folder is borrowed, otherwise null. Anything unexpected counts
// as not borrowed, so a failed check never stops IV Chat from starting.
export function borrowedFolder({ userData, appData, localAppData, files = fs, id = `${process.pid}-${Date.now()}` }) {
  if (!userData || !appData || !localAppData) return null
  const rel = path.relative(appData, userData)
  // A profile outside AppData (tests pass --user-data-dir) isn't redirected.
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const marker = `.where-am-i-${id}`
  const own = path.join(userData, marker)
  try {
    files.mkdirSync(userData, { recursive: true })
    files.writeFileSync(own, '')
  } catch {
    return null
  }
  try {
    const packages = path.join(localAppData, 'Packages')
    for (const pkg of files.readdirSync(packages)) {
      const folder = path.join(packages, pkg, 'LocalCache', 'Roaming', rel)
      if (files.existsSync(path.join(folder, marker))) return { app: pkg.split('_')[0] || pkg, folder }
    }
    return null
  } catch {
    return null
  } finally {
    try {
      files.rmSync(own, { force: true })
    } catch {
      /* a leftover empty marker is harmless */
    }
  }
}
