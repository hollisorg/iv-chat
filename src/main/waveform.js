// Telegram stores a voice message's waveform as 5-bit loudness values (0 to 31) packed into bytes.
// These helpers unpack it and shrink it to the number of bars the player draws. Pure, so they're unit tested.

export function decodeWaveform(bytes) {
  const data = bytes ? Uint8Array.from(bytes) : new Uint8Array()
  const count = Math.floor((data.length * 8) / 5)
  const out = []
  for (let i = 0; i < count; i++) {
    const bit = i * 5
    const byte = bit >> 3
    const pair = data[byte] | ((data[byte + 1] ?? 0) << 8)
    out.push((pair >> (bit & 7)) & 31)
  }
  return out
}

// Each bar is the loudest value in its slice, scaled to 0..1. With no waveform (music files), a gentle
// made-up shape is used so the player still looks like one.
export function waveformBars(values, bars = 44, seed = 1) {
  if (!values?.length) {
    let x = Math.abs(seed) % 2147483647 || 1
    return Array.from({ length: bars }, () => {
      x = (x * 16807) % 2147483647
      return 0.25 + (x / 2147483647) * 0.5
    })
  }
  const out = []
  for (let b = 0; b < bars; b++) {
    const start = Math.floor((b * values.length) / bars)
    const end = Math.max(start + 1, Math.floor(((b + 1) * values.length) / bars))
    let peak = 0
    for (let i = start; i < end && i < values.length; i++) peak = Math.max(peak, values[i])
    out.push(Math.max(0.08, peak / 31))
  }
  return out
}
