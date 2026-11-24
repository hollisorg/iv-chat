// A picture the person's AI wants to put in a Telegram draft (MCP draft_reply with photo_path). It must be
// a real JPEG, PNG, WebP or GIF file on this computer, up to 10 MB. IV Chat copies it, so what the person
// sees in the reply box is exactly what would be sent, and the window only ever gets a token for it.
import fs from 'node:fs'
import path from 'node:path'

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }

// The picture type from the file's first bytes, or null. The name alone is not trusted.
export function pictureType(head) {
  const b = Buffer.from(head || [])
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif'
  return null
}

// Checks the file and returns { mime, size, name }, or throws a message the AI can pass on.
export function checkPicture(filePath) {
  const p = String(filePath || '')
  if (!p || !path.isAbsolute(p)) throw new Error('photo_path must be the full path of a picture on this computer.')
  if (/^\\\\/.test(p)) throw new Error('Pictures on network shares cannot be added. Copy it to this computer first.')
  let stat
  try {
    stat = fs.statSync(p)
  } catch {
    throw new Error(`There is no file at ${p}.`)
  }
  if (!stat.isFile()) throw new Error(`${p} is not a file.`)
  if (!stat.size) throw new Error('That picture file is empty.')
  if (stat.size > MAX_PHOTO_BYTES) throw new Error('Pictures in drafts can be up to 10 MB.')
  const fd = fs.openSync(p, 'r')
  const head = Buffer.alloc(16)
  try {
    fs.readSync(fd, head, 0, 16, 0)
  } finally {
    fs.closeSync(fd)
  }
  const mime = pictureType(head)
  if (!mime) throw new Error('Only JPEG, PNG, WebP and GIF pictures can be added to a draft.')
  return { mime, size: stat.size, name: path.basename(p) }
}

// Copies the picture into IV Chat's upload folder under a fresh name and returns the copy's path.
export function copyPicture(filePath, dir, id) {
  const { mime, size, name } = checkPicture(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const base = name.replace(/\.[^.]*$/, '').replace(/[^\w.-]/g, '_').slice(0, 60) || 'picture'
  const copy = path.join(dir, `ai-${id}-${base}.${EXT[mime]}`)
  fs.copyFileSync(filePath, copy)
  // The file could have changed between the check and the copy; check the copy too.
  if (checkPicture(copy).mime !== mime) {
    fs.rmSync(copy, { force: true })
    throw new Error('That picture changed while it was being added. Try again.')
  }
  return { path: copy, mime, size, name: `${base}.${EXT[mime]}` }
}
