// Microphone, camera and speaker choices, ringing for Telegram calls, and who may use the microphone and camera.
// Devices are saved by name, because Windows gives every site (and IV Chat's own window) a different id for
// the same microphone; each place looks the name up among its own devices. An empty name means Windows' default.

// 'telegram' stands for IV Chat's own window (Telegram, voice messages and the Settings tests).
export const ACCESS_IDS = ['telegram', 'whatsapp', 'messenger', 'instagram', 'linkedin']
export const ACCESS_CHOICES = ['ask', 'allow', 'block']

export const MEDIA_DEFAULTS = {
  mic: '',
  camera: '',
  speaker: '',
  ring: true,
  access: Object.fromEntries(ACCESS_IDS.map((id) => [id, 'ask']))
}

const deviceName = (v) => (typeof v === 'string' ? v.slice(0, 200) : null)

// Only known keys with the right types get through, onto `base`.
export function cleanMedia(saved, base = MEDIA_DEFAULTS) {
  const next = { ...base, access: { ...base.access } }
  if (!saved || typeof saved !== 'object') return next
  for (const key of ['mic', 'camera', 'speaker']) {
    const v = deviceName(saved[key])
    if (v !== null) next[key] = v
  }
  if (typeof saved.ring === 'boolean') next.ring = saved.ring
  for (const id of ACCESS_IDS) {
    if (ACCESS_CHOICES.includes(saved.access?.[id])) next.access[id] = saved.access[id]
  }
  return next
}

// Whether a microphone or camera request is allowed: true, false, or null for "ask the person".
// `granted` is their answer earlier in this run, if they were asked.
export function accessDecision(choice, granted) {
  if (choice === 'allow') return true
  if (choice === 'block') return false
  return typeof granted === 'boolean' ? granted : null
}

// What a site is told when it only checks the permission (navigator.permissions.query) before asking.
// Electron can only answer yes or no, not "ask", and WhatsApp Web takes no as final: it shows its own
// "Allow microphone" help and never makes the request, so IV Chat's question never appears. So anything
// that isn't blocked counts as yes here; the request itself still asks when the choice is Ask.
export function checkAnswer(decision) {
  return decision !== false
}

// The device with this name among `devices` (from enumerateDevices), or null for Windows' default.
export function matchDevice(devices, kind, name) {
  if (!name) return null
  return (devices || []).find((d) => d.kind === kind && d.label === name) || null
}
