// The messaging services IV Chat embeds, plus the small pure rules around them.
// Nothing here touches Electron, so the rules are unit-tested directly (test/services.test.mjs).

export const SERVICES = {
  whatsapp: {
    id: 'whatsapp',
    name: 'WhatsApp',
    url: 'https://web.whatsapp.com/',
    partition: 'persist:whatsapp',
    // Hosts the panel may navigate to. Anything else opens in the default browser.
    hosts: ['whatsapp.com', 'whatsapp.net']
  },
  messenger: {
    id: 'messenger',
    name: 'Messenger',
    // messenger.com closed in April 2026; Facebook's own messages page replaced it.
    url: 'https://www.facebook.com/messages/',
    partition: 'persist:messenger',
    // Sign-in, security checks and the Accounts Center can move through these.
    hosts: ['facebook.com', 'messenger.com', 'fbcdn.net', 'meta.com', 'fb.com']
  },
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    url: 'https://www.instagram.com/direct/inbox/',
    partition: 'persist:instagram',
    hosts: ['instagram.com', 'cdninstagram.com', 'fbcdn.net', 'facebook.com', 'meta.com']
  },
  linkedin: {
    id: 'linkedin',
    name: 'LinkedIn',
    url: 'https://www.linkedin.com/messaging/',
    partition: 'persist:linkedin',
    hosts: ['linkedin.com', 'licdn.com']
  }
}

export const PANEL_IDS = Object.keys(SERVICES)

// Panels whose chat list IV Chat can read for Updates and the AI. Instagram and LinkedIn are plain panels for now.
export const READS_CHATS = ['whatsapp', 'messenger']

// Both sites put the unread count at the start of the tab title, e.g. "(3) WhatsApp".
export function parseUnread(title) {
  const m = /^\s*\((\d+)\+?\)/.exec(String(title ?? ''))
  return m ? Number(m[1]) : 0
}

export function hostAllowed(service, rawUrl) {
  return onHosts(service.hosts, rawUrl)
}

function onHosts(hosts, rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return hosts.some((h) => host === h || host.endsWith(`.${h}`))
}

// "Continue with Google / Apple / Microsoft" sign-in pages. They open as a pop-up window that has to stay in
// the panel's own session, so the finished sign-in can reach the site that opened it.
export const SIGN_IN_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com']

// Where a pop-up from a panel may load inside IV Chat: the service's own domains or a sign-in page. A blank
// pop-up is allowed too, because sign-in buttons often open an empty window first and then send it on.
export function popupAllowed(service, rawUrl) {
  if (!rawUrl || rawUrl === 'about:blank') return true
  return hostAllowed(service, rawUrl) || onHosts(SIGN_IN_HOSTS, rawUrl)
}

// Electron's default user agent names Electron and the app; the sites treat that as an unsupported browser.
// Strip those tokens so the panels present as the Chrome they actually are.
export function chromeUserAgent(electronUserAgent) {
  return String(electronUserAgent)
    .split(' ')
    .filter((token) => !/^(Electron|iv-chat|IV ?Chat)\//i.test(token))
    .join(' ')
}

// ---------- latest messages ----------

const LIMITS = { chats: 20, name: 120, preview: 300, time: 40 }
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

// Chat rows arrive from the panel's page, so they're treated as untrusted: only the known fields,
// as plain bounded strings, and no more than LIMITS.chats of them.
export function sanitizeChats(payload) {
  const status = ['ok', 'no-list', 'unreadable'].includes(payload?.status) ? payload.status : 'unreadable'
  const rows = Array.isArray(payload?.chats) ? payload.chats.slice(0, LIMITS.chats) : []
  const chats = rows
    .map((c) => ({
      // Messenger's conversation number, used as a stable chat id. WhatsApp shows none.
      id: /^[\w.-]{1,60}$/.test(String(c?.id ?? '')) ? String(c.id) : '',
      name: clip(c?.name, LIMITS.name),
      preview: clip(c?.preview, LIMITS.preview),
      time: clip(c?.time, LIMITS.time),
      unread: Number.isInteger(c?.unread) && c.unread > 0 ? Math.min(c.unread, 9999) : 0
    }))
    .filter((c) => c.name)
  return { status: status === 'ok' && rows.length && !chats.length ? 'unreadable' : status, chats }
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const UNITS = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 604800e3, month: 2592000e3, year: 31536000e3 }

// Turns the time label a site shows ("7:46 AM", "Yesterday", "Tuesday", "10/20/2026", "48 minutes ago",
// "a day ago") into an approximate moment, so chats from different services can be put in one order.
// Returns null when the label isn't recognised.
export function approxTime(label, now = new Date()) {
  const s = String(label ?? '').trim().toLowerCase()
  if (!s) return null
  let m = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/.exec(s)
  if (m) {
    let h = Number(m[1])
    if (m[3]) h = (h % 12) + (m[3] === 'pm' ? 12 : 0)
    const d = new Date(now)
    d.setHours(h, Number(m[2]), 0, 0)
    return d.getTime()
  }
  if (s === 'now' || s === 'just now') return now.getTime()
  if (s === 'today') return now.getTime()
  if (s === 'yesterday') return now.getTime() - UNITS.day
  const day = DAYS.indexOf(s)
  if (day >= 0) {
    const back = (now.getDay() - day + 7) % 7 || 7
    return now.getTime() - back * UNITS.day
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s)
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    return new Date(year, Number(m[1]) - 1, Number(m[2]), 12).getTime()
  }
  m = /^(a|an|\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/.exec(s)
  if (m) return now.getTime() - (/^\d+$/.test(m[1]) ? Number(m[1]) : 1) * UNITS[m[2]]
  m = /^(\d+)\s*(m|h|d|w|y)$/.exec(s)
  if (m) return now.getTime() - Number(m[1]) * { m: UNITS.minute, h: UNITS.hour, d: UNITS.day, w: UNITS.week, y: UNITS.year }[m[2]]
  return null
}

// One list across services, newest first. Chats whose time can't be read keep their place within
// their own service and go after the dated ones.
export function latestAcross(byService, now = new Date(), limit = 12) {
  const all = []
  for (const [service, chats] of Object.entries(byService)) {
    chats.forEach((c, order) => all.push({ ...c, service, at: typeof c.at === 'number' ? c.at : approxTime(c.time, now), order }))
  }
  all.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || a.order - b.order)
  return all.slice(0, limit)
}

export function totalUnread(states) {
  return Object.values(states).reduce((sum, s) => sum + (s.enabled ? s.unread : 0), 0)
}
