// WhatsApp assisted mode, seen from the main process: open a chat, read it, place a draft.
// Everything happens inside the person's own WhatsApp Web panel; nothing is ever sent.
import { flattenDraft } from './whatsapp-parse.js'

export function createWhatsApp(panels) {
  const ready = () => panels.states.whatsapp?.enabled && panels.states.whatsapp.state === 'ready' && panels.chats.whatsapp?.status === 'ok'

  function check() {
    if (!panels.states.whatsapp?.enabled) throw new Error('WhatsApp is turned off in IV Chat.')
    if (!ready()) throw new Error('WhatsApp is not signed in, or IV Chat cannot read it right now.')
  }

  return {
    ready,

    // Opening a chat in WhatsApp marks its messages as read, the same as clicking it yourself.
    async read(name, limit = 30) {
      check()
      return panels.whileDrawn('whatsapp', async () => {
        await panels.assist('whatsapp', 'open', { name })
        return panels.assist('whatsapp', 'read', { limit })
      })
    },

    // Text in the reply box can show "typing…" to the other person, as it would if the person typed it.
    async draft(name, text) {
      check()
      return panels.whileDrawn('whatsapp', async () => {
        await panels.assist('whatsapp', 'open', { name })
        await panels.assist('whatsapp', 'draft', { text: flattenDraft(text) })
        return { placed: flattenDraft(text) }
      })
    }
  }
}
