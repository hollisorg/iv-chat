// "Connect to Codex" and "Connect to Claude": add IV Chat's MCP bridge to those apps' settings, and remove it
// again. Every edit backs the file up first, changes only IV Chat's own entry, and leaves every other byte
// of the file as it was. If a file can't be edited that safely, nothing is written and the person gets the
// exact text to add by hand instead.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SERVER = 'iv-chat'
const BEGIN = '# >>> IV Chat (added by IV Chat; use Disconnect in IV Chat to remove)'
const END = '# <<< IV Chat'

// ---------- Codex: ~/.codex/config.toml ----------

const tomlString = (s) => (/['\r\n]/.test(s) ? JSON.stringify(s) : `'${s}'`)

export function codexBlock({ command, args }) {
  return [
    BEGIN,
    `[mcp_servers.${SERVER}]`,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
    'env = { ELECTRON_RUN_AS_NODE = "1" }',
    END
  ].join('\n')
}

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const BLOCK = `${reEscape(BEGIN)}[\\s\\S]*?${reEscape(END)}`

export function codexHasOwn(text) {
  return text.includes(BEGIN)
}

// Appends "\n<block>\n" at the end; disconnecting removes exactly that, so the file is restored byte for byte.
export function codexConnect(text, launch) {
  const block = codexBlock(launch)
  if (codexHasOwn(text)) return text.replace(new RegExp(BLOCK), () => block)
  if (new RegExp(`^\\s*\\[mcp_servers\\.(${SERVER}|"${SERVER}")\\]`, 'm').test(text)) {
    throw new Error('Your Codex settings already have an "iv-chat" server that IV Chat did not add. Remove it first, then connect again.')
  }
  return `${text}\n${block}\n`
}

export function codexDisconnect(text) {
  const exact = new RegExp(`\\n${BLOCK}\\n`)
  if (exact.test(text)) return text.replace(exact, '')
  return text.replace(new RegExp(`${BLOCK}\\n?`), '')
}

// ---------- Claude Desktop: claude_desktop_config.json ----------

// Finds the top-level keys of a JSON object and where each value starts and ends, without reformatting.
function scanValueEnd(text, i) {
  const open = text[i]
  if (open === '"') {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') j++
      else if (text[j] === '"') return j + 1
    }
    throw new Error('unterminated string')
  }
  if (open === '{' || open === '[') {
    let depth = 0
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (c === '"') j = scanValueEnd(text, j) - 1
      else if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') {
        depth--
        if (depth === 0) return j + 1
      }
    }
    throw new Error('unbalanced')
  }
  const m = /^[^,}\]\s]+/.exec(text.slice(i))
  return i + (m ? m[0].length : 0)
}

function objectEntries(text, start) {
  const entries = []
  let i = start + 1
  const skip = () => {
    while (/\s/.test(text[i] || '')) i++
  }
  skip()
  if (text[i] === '}') return entries
  for (;;) {
    skip()
    const keyEnd = scanValueEnd(text, i)
    const key = JSON.parse(text.slice(i, keyEnd))
    i = keyEnd
    skip()
    i++ // the colon
    skip()
    const valueStart = i
    i = scanValueEnd(text, i)
    entries.push({ key, valueStart, valueEnd: i })
    skip()
    if (text[i] === ',') i++
    else break
  }
  return entries
}

// Returns the new file text plus the exact text inserted, which is what Disconnect removes.
export function claudeDesktopConnect(text, launch) {
  const entry = JSON.stringify({ command: launch.command, args: launch.args, env: { ELECTRON_RUN_AS_NODE: '1' } })
  const source = text.trim() ? text : '{}\n'
  JSON.parse(source) // refuse anything that isn't valid JSON
  const top = source.indexOf('{')
  const entries = objectEntries(source, top)
  const servers = entries.find((e) => e.key === 'mcpServers')
  let inserted
  let at
  if (servers) {
    if (source[servers.valueStart] !== '{') throw new Error('"mcpServers" in your Claude settings is not a list of servers')
    const inner = objectEntries(source, servers.valueStart)
    if (inner.some((e) => e.key === SERVER)) throw new Error('Your Claude settings already have an "iv-chat" server. Remove it first, then connect again.')
    at = servers.valueStart + 1
    inserted = `\n    "${SERVER}": ${entry}${inner.length ? ',' : '\n  '}`
  } else {
    at = top + 1
    inserted = `\n  "mcpServers": {\n    "${SERVER}": ${entry}\n  }${entries.length ? ',' : '\n'}`
  }
  const next = source.slice(0, at) + inserted + source.slice(at)
  if (JSON.parse(next).mcpServers?.[SERVER]?.command !== launch.command) throw new Error('Could not add IV Chat safely')
  return { text: next, inserted, created: !text.trim() }
}

export function claudeDesktopDisconnect(text, inserted) {
  if (!inserted || !text.includes(inserted)) {
    throw new Error('The IV Chat entry in your Claude settings was changed after it was added, so IV Chat left it alone. Remove "iv-chat" from mcpServers by hand.')
  }
  const next = text.replace(inserted, '')
  JSON.parse(next)
  return next
}

// ---------- file handling ----------

export function backup(file) {
  if (!fs.existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const copy = `${file}.iv-chat-backup-${stamp}`
  fs.copyFileSync(file, copy)
  return copy
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')

export function codexConfigPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')
}

export function claudeDesktopConfigPath() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const standard = path.join(roaming, 'Claude', 'claude_desktop_config.json')
  // The Microsoft Store version keeps its settings inside its package folder.
  const packages = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Packages')
  try {
    for (const dir of fs.readdirSync(packages)) {
      if (!/^Claude_/i.test(dir)) continue
      const store = path.join(packages, dir, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')
      if (fs.existsSync(path.dirname(store)) && !fs.existsSync(path.dirname(standard))) return store
    }
  } catch {
    /* no Store install */
  }
  return standard
}

export function connectCodex(launch, file = codexConfigPath()) {
  const before = read(file)
  const after = codexConnect(before, launch)
  const saved = backup(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, after)
  return { file, backup: saved, added: codexBlock(launch) }
}

export function disconnectCodex(file = codexConfigPath()) {
  const before = read(file)
  if (!codexHasOwn(before)) return { file, removed: false }
  const saved = backup(file)
  fs.writeFileSync(file, codexDisconnect(before))
  return { file, backup: saved, removed: true }
}

export function connectClaudeDesktop(launch, file = claudeDesktopConfigPath()) {
  const result = claudeDesktopConnect(read(file), launch)
  const saved = backup(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, result.text)
  return { file, backup: saved, inserted: result.inserted }
}

export function disconnectClaudeDesktop(inserted, file = claudeDesktopConfigPath()) {
  const next = claudeDesktopDisconnect(read(file), inserted)
  const saved = backup(file)
  fs.writeFileSync(file, next)
  return { file, backup: saved, removed: true }
}

export function status(file, check) {
  try {
    return check(read(file))
  } catch {
    return false
  }
}

export const codexConnected = (file = codexConfigPath()) => status(file, codexHasOwn)
export const claudeDesktopConnected = (file = claudeDesktopConfigPath()) =>
  status(file, (t) => Boolean(t.trim() && JSON.parse(t).mcpServers?.[SERVER]))

// ---------- Claude Code: its own CLI manages the settings ----------

function claudeCli(args) {
  return new Promise((resolve, reject) => {
    const attempt = (cmd, shell) =>
      execFile(cmd, shell ? args.map((a) => `"${a.replace(/"/g, '\\"')}"`) : args, { shell, windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
        // Claude Code's own installer puts claude.exe in ~/.local/bin, which often isn't on the PATH.
        const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe')
        if (err && err.code === 'ENOENT' && !shell && cmd === 'claude' && fs.existsSync(local)) return attempt(local, false)
        if (err && err.code === 'ENOENT' && !shell) return attempt('claude', true)
        if (err && /not recognized|not found|ENOENT/i.test(`${stderr} ${err.message}`)) {
          return reject(
            new Error(
              `IV Chat couldn't find Claude Code's "claude" command on this computer. In a terminal where it works, run: claude mcp add --scope user ${SERVER} -e ELECTRON_RUN_AS_NODE=1 -- ${args.slice(args.indexOf('--') + 1).map((a) => `"${a}"`).join(' ')}`
            )
          )
        }
        if (err) return reject(new Error((stderr || err.message).trim().split('\n')[0]))
        resolve(stdout)
      })
    attempt('claude', false)
  })
}

export function claudeCodeConnected() {
  return status(path.join(os.homedir(), '.claude.json'), (t) => Boolean(JSON.parse(t).mcpServers?.[SERVER]))
}

export async function connectClaudeCode(launch) {
  await claudeCli(['mcp', 'add', '--scope', 'user', SERVER, '-e', 'ELECTRON_RUN_AS_NODE=1', '--', launch.command, ...launch.args])
}

export async function disconnectClaudeCode() {
  await claudeCli(['mcp', 'remove', '--scope', 'user', SERVER])
}
