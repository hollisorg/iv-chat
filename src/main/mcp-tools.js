// What the person's AI (Codex or Claude) can do through IV Chat's MCP. Read and draft only:
// there is deliberately no tool that sends. Every tool respects the AI access switch, the per-chat
// allow list and the rate limits, and every call is written to the in-memory activity log.
import { aiCanSee, chatKey, splitKey } from './ai-access.js'
import { approxTime } from './services.js'

const NAMES = { telegram: 'Telegram', whatsapp: 'WhatsApp', messenger: 'Messenger' }
const WEB = ['whatsapp', 'messenger']
const FRESH_MS = 12 * 3600e3

class ToolError extends Error {}

export function createTools({ telegram, whatsapp, getWebChats, getAi, limiter, log, onDraft, now = () => Date.now() }) {
  // Remembers what get_updates already reported, so each call returns only what's new since the last one.
  const seen = new Map()
  let telegramSince = null

  const webKey = (service, c) => chatKey(service, service === 'messenger' && c.id ? c.id : c.name)

  function allChats() {
    const out = []
    if (telegram.status === 'ready') {
      for (const d of telegram.dialogList()) {
        out.push({ chat_id: chatKey('telegram', d.id), service: 'telegram', name: d.name, unread: d.unread, last_message: d.preview, at: d.at })
      }
    }
    const web = getWebChats()
    for (const service of WEB) {
      if (web[service]?.status !== 'ok') continue
      for (const c of web[service].chats) {
        out.push({ chat_id: webKey(service, c), service, name: c.name, unread: c.unread, last_message: c.preview, time: c.time, at: approxTime(c.time, new Date(now())) })
      }
    }
    return out
  }

  const visible = () => allChats().filter((c) => aiCanSee(getAi(), c.chat_id))

  function find(chatId) {
    const chat = visible().find((c) => c.chat_id === chatId)
    if (!chat) throw new ToolError(`No chat "${chatId}" that your AI is allowed to see. Use list_chats for the ids. The person can allow more chats in IV Chat.`)
    return chat
  }

  const show = ({ at, ...c }) => ({ ...c, time: c.time || (at ? new Date(at).toISOString() : '') })

  const tools = {
    async list_chats({ service } = {}) {
      const chats = visible().filter((c) => !service || c.service === service)
      chats.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      return { chats: chats.map(show), note: chats.length ? undefined : 'No chats are shared with your AI yet. The person chooses them in IV Chat.' }
    },

    async get_updates() {
      const chats = visible()
      const fresh = []
      for (const c of chats) {
        const sig = `${c.last_message}|${c.time || c.at}`
        const before = seen.get(c.chat_id)
        seen.set(c.chat_id, sig)
        const first = before === undefined
        const changed = !first && before !== sig
        const recent = c.unread > 0 || (c.at && now() - c.at < FRESH_MS)
        if (changed || (first && recent)) fresh.push(show(c))
      }
      let messages = []
      if (telegram.status === 'ready') {
        const since = telegramSince ?? 0
        messages = telegram.updates
          .filter((m) => m.at > since && aiCanSee(getAi(), chatKey('telegram', m.chat_id)))
          .map((m) => ({ chat_id: chatKey('telegram', m.chat_id), from: m.from, text: m.text, time: new Date(m.at).toISOString() }))
        telegramSince = now()
      }
      return { chats_with_news: fresh, new_telegram_messages: messages }
    },

    async read_chat({ chat_id, limit = 30, before_id } = {}) {
      const chat = find(chat_id)
      const [service, id] = splitKey(chat_id)
      if (service === 'telegram') {
        return { chat: show(chat), messages: (await telegram.messages(id, { limit, beforeId: before_id })).map((m) => ({ ...m, at: undefined, time: new Date(m.at).toISOString() })) }
      }
      if (service === 'whatsapp' && whatsapp?.ready()) {
        const res = await whatsapp.read(chat.name, limit)
        return {
          chat: show(chat),
          messages: res.messages,
          drawn_height: res.height,
          note: 'Opening this chat in WhatsApp marks it as read for the person, as if they had opened it. Only messages WhatsApp has loaded on screen are included.'
        }
      }
      return {
        chat: show(chat),
        messages: [{ from: '', text: chat.last_message, time: chat.time }],
        note: `Only the latest ${NAMES[service]} message is available. Full ${NAMES[service]} conversations arrive in a later IV Chat update.`
      }
    },

    async search_messages({ query, chat_id } = {}) {
      if (!query || !String(query).trim()) throw new ToolError('Give some words to search for.')
      if (telegram.status !== 'ready') throw new ToolError('Search works on Telegram, which is not connected in IV Chat.')
      if (chat_id) {
        const [service, id] = splitKey(find(chat_id).chat_id)
        if (service !== 'telegram') throw new ToolError('Search works on Telegram chats for now.')
        return { results: (await telegram.search(query, id)).map((m) => ({ ...m, chat_id, at: undefined, time: new Date(m.at).toISOString() })) }
      }
      const results = (await telegram.search(query))
        .map((m) => ({ ...m, chat_id: chatKey('telegram', m.chat_id) }))
        .filter((m) => aiCanSee(getAi(), m.chat_id))
        .map((m) => ({ ...m, at: undefined, time: new Date(m.at).toISOString() }))
      return { results }
    },

    async draft_reply({ chat_id, text } = {}) {
      const body = String(text ?? '').trim()
      if (!body) throw new ToolError('The draft is empty.')
      if (body.length > 4000) throw new ToolError('Drafts are limited to 4000 characters.')
      const chat = find(chat_id)
      const [service, id] = splitKey(chat.chat_id)
      if (service === 'whatsapp') {
        if (!whatsapp?.ready()) throw new ToolError('WhatsApp is not signed in or not readable in IV Chat right now.')
        if (!limiter.take('drafts')) throw new ToolError('Draft limit reached (20 an hour). Wait a while before drafting more.')
        const { placed } = await whatsapp.draft(chat.name, body)
        onDraft(chat.chat_id, placed)
        return {
          status: 'draft placed',
          chat: chat.name,
          note: 'The draft is in the WhatsApp reply box in IV Chat, as one paragraph (WhatsApp sends on Enter, so line breaks became spaces). Nothing was sent; the person reviews it and presses Enter themselves. While a draft sits in the box, WhatsApp may show the person as typing to the other side, so only draft when the person asked for a reply.'
        }
      }
      if (service !== 'telegram') throw new ToolError(`Drafting into ${NAMES[service]} arrives in a later IV Chat update. Show the person the reply instead.`)
      if (!limiter.take('drafts')) throw new ToolError('Draft limit reached (20 an hour). Wait a while before drafting more.')
      await telegram.saveDraft(id, body)
      onDraft(chat.chat_id, body)
      return { status: 'draft placed', chat: chat.name, note: 'The draft is waiting in the reply box in IV Chat and in Telegram. Nothing was sent; the person decides whether to send it.' }
    }
  }

  // Shared checks and logging around every tool.
  return async function call(name, args) {
    const tool = tools[name]
    if (!tool) return { error: `Unknown tool ${name}` }
    const entry = { at: now(), tool: name, chat_id: args?.chat_id || '', ok: false }
    try {
      if (!getAi().enabled) throw new ToolError('The person has turned off AI access in IV Chat.')
      if (!limiter.take('calls')) throw new ToolError('Too many requests (60 a minute). Wait a moment and try again.')
      const result = await tool(args || {})
      entry.ok = true
      return result
    } catch (err) {
      entry.error = err instanceof ToolError ? err.message : 'Something went wrong in IV Chat'
      return { error: err instanceof ToolError ? err.message : `IV Chat could not do that: ${err?.message || err}` }
    } finally {
      log(entry)
    }
  }
}
