import test from 'node:test'
import assert from 'node:assert/strict'
import { MEDIA_DEFAULTS, accessDecision, cleanMedia, matchDevice } from '../src/main/media-settings.js'
import { callEvent, callText, isMissedCall, serviceText } from '../src/main/tg-format.js'
import { installDeviceChoice } from '../src/main/device-choice.js'

test('cleanMedia keeps only known keys and choices, on top of the current settings', () => {
  assert.deepEqual(cleanMedia(null), MEDIA_DEFAULTS)
  const next = cleanMedia({ mic: 'USB Mic', ring: false, access: { whatsapp: 'allow', telegram: 'sometimes', other: 'allow' }, extra: 1 })
  assert.equal(next.mic, 'USB Mic')
  assert.equal(next.ring, false)
  assert.equal(next.access.whatsapp, 'allow')
  assert.equal(next.access.telegram, 'ask')
  assert.equal(next.access.other, undefined)
  assert.equal(next.extra, undefined)
  // A patch changes only what it names.
  const patched = cleanMedia({ access: { messenger: 'block' } }, next)
  assert.equal(patched.access.whatsapp, 'allow')
  assert.equal(patched.access.messenger, 'block')
  assert.equal(patched.mic, 'USB Mic')
  assert.equal(cleanMedia({ mic: 42 }, next).mic, 'USB Mic')
})

test('accessDecision: Allow and Block decide, Ask uses this run\'s answer or asks', () => {
  assert.equal(accessDecision('allow', false), true)
  assert.equal(accessDecision('block', true), false)
  assert.equal(accessDecision('ask', undefined), null)
  assert.equal(accessDecision('ask', true), true)
  assert.equal(accessDecision('ask', false), false)
})

test('matchDevice finds a device by name and kind, or gives Windows\' default', () => {
  const list = [
    { kind: 'audioinput', label: 'USB Mic', deviceId: 'a1' },
    { kind: 'audiooutput', label: 'USB Mic', deviceId: 'o1' }
  ]
  assert.equal(matchDevice(list, 'audioinput', 'USB Mic').deviceId, 'a1')
  assert.equal(matchDevice(list, 'audiooutput', 'USB Mic').deviceId, 'o1')
  assert.equal(matchDevice(list, 'audioinput', 'Gone'), null)
  assert.equal(matchDevice(list, 'audioinput', ''), null)
})

test('callEvent: a call to you rings; one you make, or a waiting one, shows nothing; anything else ends it', () => {
  const me = 100
  const req = { className: 'PhoneCallRequested', id: 7n, accessHash: 9n, adminId: 55, participantId: 100, video: true }
  assert.deepEqual(callEvent(req, me), { state: 'ringing', id: '7', accessHash: '9', callerId: '55', video: true })
  assert.equal(callEvent({ ...req, adminId: 100, participantId: 55 }, me), null)
  assert.equal(callEvent({ className: 'PhoneCallWaiting', id: 7n }, me), null)
  assert.deepEqual(callEvent({ className: 'PhoneCallDiscarded', id: 7n }, me), { state: 'ended', id: '7' })
  assert.deepEqual(callEvent({ className: 'PhoneCall', id: 7n }, me), { state: 'ended', id: '7' })
  assert.equal(callEvent(null, me), null)
})

test('callText words call lines as Telegram does', () => {
  const call = (out, reason, duration, video) => ({ out, action: { className: 'MessageActionPhoneCall', reason: reason && { className: reason }, duration, video } })
  assert.equal(callText(call(false, 'PhoneCallDiscardReasonMissed')), 'Missed call')
  assert.equal(callText(call(true, 'PhoneCallDiscardReasonMissed')), 'Cancelled call')
  assert.equal(callText(call(false, 'PhoneCallDiscardReasonBusy', 0, true)), 'Declined video call')
  assert.equal(callText(call(true, 'PhoneCallDiscardReasonHangup', 125)), 'Outgoing call · 2:05')
  assert.equal(callText(call(false, 'PhoneCallDiscardReasonHangup', 42, true)), 'Incoming video call · 0:42')
  assert.equal(serviceText(call(false, 'PhoneCallDiscardReasonMissed')), 'Missed call')
  assert.equal(isMissedCall(call(false, 'PhoneCallDiscardReasonMissed')), true)
  assert.equal(isMissedCall(call(true, 'PhoneCallDiscardReasonMissed')), false)
  assert.equal(isMissedCall(call(false, 'PhoneCallDiscardReasonBusy')), false)
})

// A pretend page for installDeviceChoice: two microphones, names visible or not.
function fakePage({ namesVisible = true } = {}) {
  const devices = [
    { kind: 'audioinput', label: 'Laptop Mic', deviceId: 'lap' },
    { kind: 'audioinput', label: 'USB Mic', deviceId: 'usb' }
  ]
  const calls = []
  const stopped = []
  const page = {
    calls,
    stopped,
    revealed: namesVisible,
    mediaDevices: {
      async enumerateDevices() {
        return devices.map((d) => ({ ...d, label: page.revealed ? d.label : '' }))
      },
      async getUserMedia(c) {
        calls.push(c)
        page.revealed = true
        const id = c?.audio?.deviceId?.exact || 'lap'
        const track = { getSettings: () => ({ deviceId: id }), stop: () => stopped.push(id) }
        return { getAudioTracks: () => [track], getVideoTracks: () => [], getTracks: () => [track] }
      }
    }
  }
  return page
}

async function withPage(page, fn) {
  const saved = { navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), window: globalThis.window }
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: page.mediaDevices }, configurable: true })
  globalThis.window = {}
  try {
    await fn()
  } finally {
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator)
    else delete globalThis.navigator
    globalThis.window = saved.window
  }
}

test('installDeviceChoice gives a site asking for "a microphone" the chosen one, and keeps a site\'s own pick', async () => {
  const page = fakePage()
  await withPage(page, async () => {
    installDeviceChoice('k', { mic: 'USB Mic' })
    const s = await page.mediaDevices.getUserMedia({ audio: true })
    assert.equal(s.getAudioTracks()[0].getSettings().deviceId, 'usb')
    await page.mediaDevices.getUserMedia({ audio: { deviceId: 'lap' } })
    assert.deepEqual(page.calls.at(-1), { audio: { deviceId: 'lap' } })
    // A new choice from IV Chat arrives through the hidden setter.
    window.k({ mic: '' })
    await page.mediaDevices.getUserMedia({ audio: true })
    assert.deepEqual(page.calls.at(-1), { audio: true })
  })
})

test('installDeviceChoice switches the first request, made before names were visible, to the chosen device', async () => {
  const page = fakePage({ namesVisible: false })
  await withPage(page, async () => {
    installDeviceChoice('k', { mic: 'USB Mic' })
    const s = await page.mediaDevices.getUserMedia({ audio: true })
    assert.equal(s.getAudioTracks()[0].getSettings().deviceId, 'usb')
    assert.deepEqual(page.stopped, ['lap'])
  })
})
