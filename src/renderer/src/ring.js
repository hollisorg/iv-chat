// IV Chat's own sounds, made on the spot with Web Audio (no recordings): a short test tone for the speaker
// test, and the ring for incoming Telegram calls. Both play on the speaker chosen in Settings.
import { chosenDeviceId } from './devices'

async function context(speakerName) {
  const sinkId = await chosenDeviceId('audiooutput', speakerName)
  try {
    return new AudioContext(sinkId ? { sinkId } : {})
  } catch {
    return new AudioContext()
  }
}

// A soft bell-like note: a sine with a quick rise and a long fade.
function note(ctx, freq, at, length = 0.5, volume = 0.18) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0, at)
  gain.gain.linearRampToValueAtTime(volume, at + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length)
  osc.connect(gain).connect(ctx.destination)
  osc.start(at)
  osc.stop(at + length + 0.05)
}

export async function playTestTone(speakerName) {
  const ctx = await context(speakerName)
  const t = ctx.currentTime + 0.05
  note(ctx, 523.25, t)
  note(ctx, 659.25, t + 0.18)
  note(ctx, 783.99, t + 0.36, 0.8)
  setTimeout(() => ctx.close().catch(() => {}), 1600)
}

// Rings every few seconds until the returned stop() is called, and stops on its own after a minute.
export function startRing(speakerName) {
  let stopped = false
  let ctx = null
  let timer = null
  const stop = () => {
    stopped = true
    clearInterval(timer)
    ctx?.close().catch(() => {})
  }
  context(speakerName).then((c) => {
    ctx = c
    if (stopped) return stop()
    const ring = () => {
      const t = ctx.currentTime + 0.05
      ;[659.25, 783.99, 659.25, 987.77].forEach((f, i) => note(ctx, f, t + i * 0.16, 0.45, 0.16))
    }
    ring()
    timer = setInterval(ring, 2600)
    setTimeout(stop, 60000)
  })
  return stop
}
