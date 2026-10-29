// Small pure helpers for WhatsApp Web's message markup. Shared by the panel reader and the tests.

// WhatsApp labels each text message "[8:11 AM, 10/29/2026] Sam Lee: ".
export function parsePrePlain(label) {
  const m = /^\[([^,\]]+),\s*([^\]]+)\]\s*(.*?):\s*$/.exec(String(label ?? ''))
  if (!m) return null
  return { time: m[1].trim(), date: m[2].trim(), from: m[3].trim() }
}

// WhatsApp sends on Enter, so a draft is always placed as one paragraph: line breaks become spaces.
export function flattenDraft(text) {
  return String(text ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// What to show for a message that has no text of its own.
export function mediaLabel(kinds) {
  const k = new Set(kinds)
  if (k.has('image-thumb')) return '[Photo]'
  if (k.has('video-thumb') || k.has('video-content')) return '[Video]'
  if (k.has('audio-play') || k.has('ptt-status') || k.has('audio-player')) return '[Voice message]'
  if (k.has('document-thumb') || k.has('document-message')) return '[File]'
  if (k.has('sticker')) return '[Sticker]'
  return '[Media]'
}
