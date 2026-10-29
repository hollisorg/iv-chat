// The rail, in order. Shortcut keys match the main process (src/main/panels.js).
export const VIEWS = [
  { id: 'updates', label: 'Updates', key: '1' },
  { id: 'telegram', label: 'Telegram', key: '2' },
  { id: 'whatsapp', label: 'WhatsApp', key: '3', panel: true },
  { id: 'messenger', label: 'Messenger', key: '4', panel: true },
  { id: 'instagram', label: 'Instagram', key: '5', panel: true },
  { id: 'linkedin', label: 'LinkedIn', key: '6', panel: true }
]

export const SETTINGS = { id: 'settings', label: 'Settings', key: ',' }

export const ALL_VIEWS = [...VIEWS, SETTINGS]

export const NAMES = { whatsapp: 'WhatsApp', messenger: 'Messenger', telegram: 'Telegram', instagram: 'Instagram', linkedin: 'LinkedIn' }

// Panels whose chat lists IV Chat reads (matches READS_CHATS in src/main/services.js).
export const READS_CHATS = ['whatsapp', 'messenger']
