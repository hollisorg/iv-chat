// The microphone, camera and speaker chosen in IV Chat's Settings, applied inside a website panel's own page.
// src/preload/panel.js runs this in the page (main world) before the site's scripts. Electron copies the
// function's source into the page, so it must stay self-contained: no imports and no outside variables.
//
// - A site asking for "a microphone" or "a camera" gets the chosen one. A site asking for a particular
//   device (from its own settings) keeps its choice.
// - Device names are hidden until the site's first microphone or camera permission, so the very first request
//   opens the default device and is then switched to the chosen one if it differs.
// - Audio and video players, and Web Audio, are sent to the chosen speaker where the browser allows it.
// `key` names the hidden setter IV Chat uses to pass new choices in; it only accepts names, and reveals nothing.
// `initial` is the choice at page load.
export function installDeviceChoice(key, initial) {
  const md = navigator.mediaDevices
  if (!md || typeof md.getUserMedia !== 'function') return
  let wanted
  const set = (w) => {
    wanted = { mic: String(w?.mic || ''), camera: String(w?.camera || ''), speaker: String(w?.speaker || '') }
  }
  set(initial)
  Object.defineProperty(window, key, { value: set, enumerable: false })

  const original = md.getUserMedia.bind(md)
  const enumerate = md.enumerateDevices.bind(md)
  const find = async (kind, name) => {
    if (!name) return null
    try {
      return (await enumerate()).find((d) => d.kind === kind && d.label === name) || null
    } catch {
      return null
    }
  }
  const unpicked = (c) => c === true || Boolean(c && typeof c === 'object' && !c.deviceId)
  const pick = (c, id) => (c === true ? { deviceId: { exact: id } } : { ...c, deviceId: { exact: id } })

  md.getUserMedia = async function getUserMedia(constraints) {
    const c = constraints && typeof constraints === 'object' ? constraints : {}
    const mic = unpicked(c.audio) ? await find('audioinput', wanted.mic) : null
    const cam = unpicked(c.video) ? await find('videoinput', wanted.camera) : null
    const chosen = (m, v) => {
      const next = { ...c }
      if (m) next.audio = pick(c.audio, m.deviceId)
      if (v) next.video = pick(c.video, v.deviceId)
      return next
    }
    if (mic || cam) {
      try {
        return await original(chosen(mic, cam))
      } catch {
        return original(constraints)
      }
    }
    const stream = await original(constraints)
    // The first permission just made the names visible: switch to the chosen devices if they differ.
    const lateMic = unpicked(c.audio) ? await find('audioinput', wanted.mic) : null
    const lateCam = unpicked(c.video) ? await find('videoinput', wanted.camera) : null
    const differs = (tracks, d) => d && tracks.some((t) => t.getSettings?.().deviceId !== d.deviceId)
    if (!differs(stream.getAudioTracks(), lateMic) && !differs(stream.getVideoTracks(), lateCam)) return stream
    try {
      const better = await original(chosen(lateMic, lateCam))
      stream.getTracks().forEach((t) => t.stop())
      return better
    } catch {
      return stream
    }
  }

  const speaker = async () => (await find('audiooutput', wanted.speaker))?.deviceId || null
  const route = (target) => {
    if (!wanted.speaker || typeof target.setSinkId !== 'function' || target.sinkId) return
    speaker()
      .then((id) => id && target.setSinkId(id))
      .catch(() => {})
  }
  const Media = window.HTMLMediaElement
  if (Media?.prototype?.play) {
    const play = Media.prototype.play
    Media.prototype.play = function playOnChosenSpeaker(...args) {
      route(this)
      return play.apply(this, args)
    }
  }
  const Ctx = window.AudioContext
  if (Ctx?.prototype?.setSinkId) {
    window.AudioContext = class AudioContext extends Ctx {
      constructor(...args) {
        super(...args)
        if (!args[0]?.sinkId) route(this)
      }
    }
  }
}
