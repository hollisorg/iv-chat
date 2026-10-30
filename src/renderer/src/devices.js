import { matchDevice } from '../../main/media-settings.js'

// The id, in IV Chat's own window, of the device saved by name in Settings > Calls and devices,
// or null for Windows' default (nothing chosen, names not visible yet, or the device is unplugged).
export async function chosenDeviceId(kind, name) {
  if (!name || !navigator.mediaDevices?.enumerateDevices) return null
  try {
    return matchDevice(await navigator.mediaDevices.enumerateDevices(), kind, name)?.deviceId || null
  } catch {
    return null
  }
}

// The saved choices, straight from the settings file.
export async function savedMedia() {
  try {
    return (await window.iv.settings.get())?.media || {}
  } catch {
    return {}
  }
}
