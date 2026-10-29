import { useEffect, useState } from 'react'

// A round initials badge for a chat, tinted by name so the same person always gets the same colour.
// With a picture (a Telegram profile photo) it shows that instead.
const TINTS = ['#f44859', '#f19dac', '#c9384a', '#e8735a', '#b85c7a', '#f0a07a']

export default function Avatar({ name, size = 38, src, saved }) {
  const box = { width: size, height: size }
  if (saved) {
    // Saved Messages gets Telegram's bookmark, as in its own apps.
    return (
      <span className="avatar is-saved" style={{ ...box, fontSize: size * 0.45 }} aria-hidden="true">
        <svg width={size * 0.46} height={size * 0.46} viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1Z" />
        </svg>
      </span>
    )
  }
  if (src) return <img className="avatar" style={box} src={src} alt="" aria-hidden="true" />
  const words = String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/)
  const initials = ((words[0]?.[0] || '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase()
  let h = 0
  for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) >>> 0
  return (
    <span className="avatar" style={{ '--tint': TINTS[h % TINTS.length], ...box, fontSize: size * 0.38 }} aria-hidden="true">
      {initials}
    </span>
  )
}

// Telegram profile pictures, asked for once per chat and shared by every place that shows that chat.
const pictures = new Map()

export function useTelegramPicture(chatId) {
  const [src, setSrc] = useState(() => (typeof pictures.get(chatId) === 'string' ? pictures.get(chatId) : null))
  useEffect(() => {
    if (!chatId) return
    let live = true
    let p = pictures.get(chatId)
    if (p === undefined) {
      p = window.iv.telegram.avatar(chatId).catch(() => null)
      pictures.set(chatId, p)
      p.then((url) => (url ? pictures.set(chatId, url) : pictures.delete(chatId)))
    }
    Promise.resolve(p).then((url) => live && setSrc(url || null))
    return () => {
      live = false
    }
  }, [chatId])
  return src
}

// A Telegram chat's avatar: its photo when it has one, the bookmark for Saved Messages, initials otherwise.
export function TelegramAvatar({ dialog, size }) {
  const src = useTelegramPicture(dialog?.kind === 'saved' ? null : dialog?.id)
  return <Avatar name={dialog?.name} size={size} src={src} saved={dialog?.kind === 'saved'} />
}
