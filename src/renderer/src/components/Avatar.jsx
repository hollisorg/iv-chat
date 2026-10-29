// A round initials badge for a chat, tinted by name so the same person always gets the same colour.
const TINTS = ['#f44859', '#f19dac', '#c9384a', '#e8735a', '#b85c7a', '#f0a07a']

export default function Avatar({ name, size = 38 }) {
  const words = String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/)
  const initials = ((words[0]?.[0] || '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase()
  let h = 0
  for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) >>> 0
  return (
    <span className="avatar" style={{ '--tint': TINTS[h % TINTS.length], width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {initials}
    </span>
  )
}
