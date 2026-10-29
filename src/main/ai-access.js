// Which chats the person's AI may see, plus the limits on what it can do. Pure functions: unit tested.
//
// Chat ids are "<service>:<id>": Telegram uses its peer id, Messenger its conversation number, and
// WhatsApp the chat name (WhatsApp Web shows no stable id).

export const AI_DEFAULTS = { enabled: true, mode: 'chosen', allowed: [], excluded: [] }

export const chatKey = (service, id) => `${service}:${id}`

export function splitKey(key) {
  const i = String(key).indexOf(':')
  return i < 0 ? [null, null] : [key.slice(0, i), key.slice(i + 1)]
}

// "chosen": only chats the person switched on. "all": every chat except the ones they switched off.
export function aiCanSee(ai, key) {
  if (!ai?.enabled) return false
  if (ai.excluded?.includes(key)) return false
  return ai.mode === 'all' || Boolean(ai.allowed?.includes(key))
}

export function setChatAccess(ai, key, on) {
  const allowed = new Set(ai.allowed)
  const excluded = new Set(ai.excluded)
  if (on) {
    excluded.delete(key)
    if (ai.mode === 'chosen') allowed.add(key)
  } else {
    allowed.delete(key)
    if (ai.mode === 'all') excluded.add(key)
  }
  return { ...ai, allowed: [...allowed], excluded: [...excluded] }
}

export function cleanAi(raw) {
  const keys = (list) => (Array.isArray(list) ? list.filter((k) => typeof k === 'string' && k.length <= 300 && k.includes(':')).slice(0, 2000) : [])
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : AI_DEFAULTS.enabled,
    mode: raw?.mode === 'all' ? 'all' : 'chosen',
    allowed: keys(raw?.allowed),
    excluded: keys(raw?.excluded)
  }
}

// Sliding-window limits so a runaway AI loop can't hammer the accounts.
export class RateLimiter {
  constructor(limits, now = () => Date.now()) {
    this.limits = limits // { name: { max, windowMs } }
    this.hits = Object.fromEntries(Object.keys(limits).map((k) => [k, []]))
    this.now = now
  }

  take(name) {
    const { max, windowMs } = this.limits[name]
    const t = this.now()
    const list = this.hits[name].filter((x) => t - x < windowMs)
    this.hits[name] = list
    if (list.length >= max) return false
    list.push(t)
    return true
  }
}
