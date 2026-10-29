// Shared by the IV Chat app and the MCP bridge: where the private pipe lives and where its token is kept.
// Both are derived from the profile folder, so a test profile never talks to the real app.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function pipePath(profileDir) {
  const tag = crypto.createHash('sha256').update(path.resolve(profileDir).toLowerCase()).digest('hex').slice(0, 16)
  return process.platform === 'win32' ? `\\\\.\\pipe\\iv-chat-mcp-${tag}` : path.join(profileDir, 'mcp.sock')
}

export const tokenFile = (profileDir) => path.join(profileDir, 'mcp-token.txt')

export function readToken(profileDir) {
  return fs.readFileSync(tokenFile(profileDir), 'utf8').trim()
}

// Created once per profile; the bridge needs it to be let in.
export function ensureToken(profileDir) {
  try {
    const t = readToken(profileDir)
    if (/^[0-9a-f]{64}$/.test(t)) return t
  } catch {
    /* first run */
  }
  const t = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(tokenFile(profileDir), t, { mode: 0o600 })
  return t
}

export function sameToken(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
