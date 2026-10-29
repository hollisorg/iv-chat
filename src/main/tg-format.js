// Turns Telegram's message objects into the plain shapes IV Chat's window draws. Pure functions only, so they
// are unit-tested directly (test/tg-format.test.mjs) without a Telegram connection.
import { decodeWaveform, waveformBars } from './waveform.js'

export function dialogName(d) {
  return d.title || d.name || [d.entity?.firstName, d.entity?.lastName].filter(Boolean).join(' ') || 'Unknown'
}

export function personName(s) {
  if (!s) return ''
  return s.title || [s.firstName, s.lastName].filter(Boolean).join(' ') || s.username || ''
}

export function senderName(msg, me) {
  if (msg.out) return 'You'
  const s = msg.sender
  if (!s) return ''
  if (s.id && me && String(s.id) === String(me.id)) return 'You'
  return personName(s)
}

const num = (v) => Number(String(v ?? 0))

// What a message carries besides text, for showing it: a photo, video, GIF, round video, voice note,
// sticker or file. Link previews are separate (see linkPreview).
export function mediaInfo(msg) {
  const media = msg.media
  if (!media || media.className === 'MessageMediaWebPage') return null
  if (media.className === 'MessageMediaPhoto') {
    if (!media.photo || media.photo.className === 'PhotoEmpty') return { kind: 'other', label: 'Photo (expired)' }
    const sizes = (media.photo.sizes || []).filter((s) => s.w && s.h)
    const big = sizes[sizes.length - 1]
    return { kind: 'photo', w: big?.w || 0, h: big?.h || 0, spoiler: Boolean(media.spoiler) }
  }
  if (media.className === 'MessageMediaDocument' && media.document && media.document.className !== 'DocumentEmpty') {
    const d = media.document
    const attrs = d.attributes || []
    const has = (name) => attrs.find((a) => a.className === name)
    const audio = has('DocumentAttributeAudio')
    const video = has('DocumentAttributeVideo')
    const sticker = has('DocumentAttributeSticker')
    const mime = d.mimeType || ''
    let kind = 'file'
    if (sticker) kind = mime === 'application/x-tgsticker' ? 'sticker-animated' : mime === 'video/webm' ? 'sticker-video' : 'sticker'
    else if (has('DocumentAttributeAnimated') && (video || mime.startsWith('video/'))) kind = 'gif'
    else if (video?.roundMessage) kind = 'round'
    else if (audio?.voice) kind = 'voice'
    else if (audio) kind = 'audio'
    else if (video || (mime.startsWith('video/') && !has('DocumentAttributeFilename'))) kind = 'video'
    else if (mime === 'image/gif') kind = 'gif-file'
    return {
      kind,
      name: has('DocumentAttributeFilename')?.fileName || '',
      size: num(d.size),
      mime,
      duration: Number(audio?.duration || video?.duration || 0),
      w: video?.w || has('DocumentAttributeImageSize')?.w || 0,
      h: video?.h || has('DocumentAttributeImageSize')?.h || 0,
      emoji: sticker?.alt || '',
      // Voice messages carry their own loudness shape; the player draws it as bars.
      bars: audio ? waveformBars(decodeWaveform(audio.waveform), 44, Number(String(d.id ?? 1).slice(-9))) : undefined,
      preview: Boolean(d.thumbs?.length) || (kind === 'sticker' && mime === 'image/webp'),
      spoiler: Boolean(media.spoiler)
    }
  }
  const label = { MessageMediaGeo: 'Location', MessageMediaGeoLive: 'Live location', MessageMediaVenue: 'Place', MessageMediaContact: 'Contact', MessageMediaPoll: 'Poll', MessageMediaDice: 'Dice', MessageMediaGame: 'Game', MessageMediaInvoice: 'Invoice', MessageMediaStory: 'Story', MessageMediaGiveaway: 'Giveaway' }
  return { kind: 'other', label: label[media.className] || media.className?.replace(/^MessageMedia/, '') || 'Media' }
}

// A link preview card under a message: the page's site name, title, description and whether it has a picture.
export function linkPreview(msg) {
  const w = msg.media?.className === 'MessageMediaWebPage' ? msg.media.webpage : null
  if (!w || w.className !== 'WebPage') return null
  return {
    url: w.url || w.displayUrl || '',
    site: w.siteName || w.displayUrl || '',
    title: w.title || '',
    description: (w.description || '').slice(0, 400),
    photo: Boolean(w.photo && w.photo.className !== 'PhotoEmpty')
  }
}

// The reactions under a message: each emoji, how many people chose it, and whether one of them is you.
// Custom (premium) emoji reactions can't be drawn here, so they show as a star.
export function reactionList(msg) {
  return (msg.reactions?.results || []).map((r) => ({
    emoji: r.reaction?.className === 'ReactionEmoji' ? r.reaction.emoticon : '★',
    custom: r.reaction?.className !== 'ReactionEmoji',
    count: r.count || 0,
    mine: r.chosenOrder !== undefined && r.chosenOrder !== null
  }))
}

const MEDIA_WORD = { photo: 'Photo', video: 'Video', gif: 'GIF', 'gif-file': 'GIF', round: 'Video message', voice: 'Voice message', audio: 'Audio', file: 'File', sticker: 'Sticker', 'sticker-animated': 'Sticker', 'sticker-video': 'Sticker' }

// One line of text standing for a message: its text, or what it carries.
export function messageText(msg) {
  if (msg.message) return msg.message
  const info = mediaInfo(msg)
  if (info) {
    const word = info.kind === 'other' ? info.label : MEDIA_WORD[info.kind] || 'Media'
    return `[${info.emoji ? `${info.emoji} ` : ''}${word}]`
  }
  if (msg.action) return serviceText(msg)
  return ''
}

// Messages like "Sam joined the group" or "Photo changed".
export function serviceText(msg) {
  const a = msg.action
  if (!a) return ''
  const map = {
    MessageActionChatAddUser: 'joined the group',
    MessageActionChatJoinedByLink: 'joined the group by link',
    MessageActionChatJoinedByRequest: 'joined the group',
    MessageActionChatDeleteUser: 'left the group',
    MessageActionChatEditTitle: `changed the group name to "${a.title || ''}"`,
    MessageActionChatEditPhoto: 'changed the group photo',
    MessageActionChatDeletePhoto: 'removed the group photo',
    MessageActionChatCreate: `created the group "${a.title || ''}"`,
    MessageActionChannelCreate: 'created the channel',
    MessageActionPinMessage: 'pinned a message',
    MessageActionPhoneCall: 'call',
    MessageActionHistoryClear: 'cleared the history',
    MessageActionContactSignUp: 'joined Telegram',
    MessageActionScreenshotTaken: 'took a screenshot'
  }
  return map[a.className] || 'updated the chat'
}

// Telegram's formatting and link ranges. Offsets and lengths are in UTF-16 units, the same as JavaScript
// strings, so the window can slice the text directly.
const ENTITY_TYPES = {
  MessageEntityUrl: 'url',
  MessageEntityTextUrl: 'text_url',
  MessageEntityEmail: 'email',
  MessageEntityPhone: 'phone',
  MessageEntityMention: 'mention',
  MessageEntityMentionName: 'mention_name',
  InputMessageEntityMentionName: 'mention_name',
  MessageEntityHashtag: 'hashtag',
  MessageEntityCashtag: 'hashtag',
  MessageEntityBotCommand: 'command',
  MessageEntityBold: 'bold',
  MessageEntityItalic: 'italic',
  MessageEntityUnderline: 'underline',
  MessageEntityStrike: 'strike',
  MessageEntityCode: 'code',
  MessageEntityPre: 'pre',
  MessageEntitySpoiler: 'spoiler',
  MessageEntityBlockquote: 'quote',
  MessageEntityCustomEmoji: 'custom_emoji'
}

export function entityList(msg) {
  const text = msg.message || ''
  const out = []
  for (const e of msg.entities || []) {
    const type = ENTITY_TYPES[e.className]
    if (!type || e.length <= 0 || e.offset < 0 || e.offset >= text.length) continue
    const item = { type, offset: e.offset, length: Math.min(e.length, text.length - e.offset) }
    if (type === 'text_url') item.url = e.url
    if (type === 'pre' && e.language) item.language = String(e.language)
    out.push(item)
  }
  return out
}

// The link a piece of text opens, or null. Only web, e-mail and Telegram's own t.me addresses.
export function entityHref(entity, text) {
  const s = String(text || '')
  switch (entity.type) {
    case 'url':
      return safeHref(/^[a-z][\w+.-]*:\/\//i.test(s) ? s : `https://${s}`)
    case 'text_url':
      return safeHref(entity.url)
    case 'email':
      return `mailto:${s}`
    case 'mention':
      return /^@\w{4,}$/.test(s) ? `https://t.me/${s.slice(1)}` : null
    default:
      return null
  }
}

export function safeHref(url) {
  try {
    const u = new URL(String(url))
    if (u.protocol === 'tg:') return url
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null
  } catch {
    return null
  }
}

// Where a URL with no entity sits in plain text (used for older or locally drafted messages).
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi
export function findUrls(text) {
  const out = []
  for (const m of String(text || '').matchAll(URL_RE)) out.push({ type: 'url', offset: m.index, length: m[0].length })
  return out
}

// Splits text into runs that share the same formatting, for drawing. Each run lists the entities covering it.
export function formatRuns(text, entities) {
  const s = String(text || '')
  const list = entities?.length ? entities : findUrls(s)
  const cuts = new Set([0, s.length])
  for (const e of list) {
    cuts.add(Math.max(0, e.offset))
    cuts.add(Math.min(s.length, e.offset + e.length))
  }
  const points = [...cuts].sort((a, b) => a - b)
  const runs = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (b <= a) continue
    const on = list.filter((e) => e.offset <= a && e.offset + e.length >= b)
    // A link's address comes from the whole linked text, not just this piece of it.
    let href = null
    for (const e of on) {
      href = entityHref(e, s.slice(e.offset, e.offset + e.length))
      if (href) break
    }
    runs.push({ text: s.slice(a, b), types: on.map((e) => e.type), href })
  }
  return runs
}

// "online", "last seen 5 minutes ago" and the like, from a person's Telegram status.
export function statusText(status, now = Date.now()) {
  if (!status) return ''
  switch (status.className) {
    case 'UserStatusOnline':
      return 'online'
    case 'UserStatusRecently':
      return 'last seen recently'
    case 'UserStatusLastWeek':
      return 'last seen within a week'
    case 'UserStatusLastMonth':
      return 'last seen within a month'
    case 'UserStatusOffline': {
      const mins = Math.max(0, Math.round((now - status.wasOnline * 1000) / 60000))
      if (mins < 1) return 'last seen just now'
      if (mins < 60) return `last seen ${mins} minute${mins === 1 ? '' : 's'} ago`
      const hrs = Math.round(mins / 60)
      if (hrs < 24) return `last seen ${hrs} hour${hrs === 1 ? '' : 's'} ago`
      return `last seen ${new Date(status.wasOnline * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
    }
    default:
      return ''
  }
}

// What someone is doing right now in a chat, from Telegram's "typing" updates.
export function actionText(action) {
  const map = {
    SendMessageTypingAction: 'typing',
    SendMessageRecordAudioAction: 'recording a voice message',
    SendMessageUploadAudioAction: 'sending a voice message',
    SendMessageRecordVideoAction: 'recording a video',
    SendMessageUploadVideoAction: 'sending a video',
    SendMessageRecordRoundAction: 'recording a video message',
    SendMessageUploadRoundAction: 'sending a video message',
    SendMessageUploadPhotoAction: 'sending a photo',
    SendMessageUploadDocumentAction: 'sending a file',
    SendMessageChooseStickerAction: 'choosing a sticker'
  }
  return map[action?.className] || null
}

// ---------- chat folders ----------

// A Telegram folder ("dialog filter") reduced to the rules IV Chat needs. Peer ids are strings.
export function folderRules(filter, peerIdOf) {
  const ids = (list) => new Set((list || []).map((p) => { try { return String(peerIdOf(p)) } catch { return null } }).filter(Boolean))
  const title = typeof filter.title === 'string' ? filter.title : filter.title?.text || 'Folder'
  return {
    id: filter.id,
    title,
    emoticon: filter.emoticon || '',
    pinned: [...ids(filter.pinnedPeers)],
    include: ids([...(filter.pinnedPeers || []), ...(filter.includePeers || [])]),
    exclude: ids(filter.excludePeers),
    contacts: Boolean(filter.contacts),
    nonContacts: Boolean(filter.nonContacts),
    groups: Boolean(filter.groups),
    broadcasts: Boolean(filter.broadcasts),
    bots: Boolean(filter.bots),
    excludeMuted: Boolean(filter.excludeMuted),
    excludeRead: Boolean(filter.excludeRead),
    excludeArchived: Boolean(filter.excludeArchived)
  }
}

// Whether a chat belongs in a folder, the way Telegram decides: chats named in the folder always do;
// otherwise its kind has to be one the folder takes, and it mustn't be muted, read or archived if the folder
// leaves those out. `d` is { id, kind, bot, contact, muted, unread, unreadMark, archived }.
export function inFolder(rules, d) {
  if (rules.include.has(d.id)) return true
  if (rules.exclude.has(d.id)) return false
  let kindOk
  if (d.kind === 'person') kindOk = d.bot ? rules.bots : d.contact ? rules.contacts : rules.nonContacts
  else if (d.kind === 'group') kindOk = rules.groups
  else if (d.kind === 'channel') kindOk = rules.broadcasts
  else kindOk = false
  if (!kindOk) return false
  if (rules.excludeMuted && d.muted) return false
  if (rules.excludeRead && !d.unread && !d.unreadMark) return false
  if (rules.excludeArchived && d.archived) return false
  return true
}

// Whether a chat adds to the unread count on the tray, the sidebar and Updates. As in Telegram, muted and
// archived chats don't, and a chat marked unread does.
export function countsAsUnread(d) {
  return Boolean((d.unread > 0 || d.unreadMark) && !d.muted && !d.archived)
}
