import test from 'node:test'
import assert from 'node:assert/strict'
import { countsAsUnread, folderRules, inFolder } from '../src/main/tg-format.js'

const peer = (id) => ({ id })
const rules = (f) => folderRules({ id: 2, title: { text: 'Work' }, ...f }, (p) => p.id)
const chat = (over) => ({ id: '1', kind: 'person', bot: false, contact: true, muted: false, unread: 0, unreadMark: false, archived: false, ...over })

test('folderRules reads the title and the chats named in a folder', () => {
  const r = rules({ includePeers: [peer('10')], pinnedPeers: [peer('11')], excludePeers: [peer('12')], emoticon: '💼' })
  assert.equal(r.title, 'Work')
  assert.equal(r.emoticon, '💼')
  assert.deepEqual(r.pinned, ['11'])
  assert.ok(r.include.has('10') && r.include.has('11'))
  assert.ok(r.exclude.has('12'))
  assert.equal(folderRules({ id: 3, title: 'Old style' }, (p) => p.id).title, 'Old style')
})

test('inFolder follows Telegram: named chats always, otherwise by kind and the exclusions', () => {
  const r = rules({ contacts: true, groups: true, excludeMuted: true, excludeRead: true, includePeers: [peer('5')], excludePeers: [peer('6')] })
  assert.ok(inFolder(r, chat({ id: '5', kind: 'channel', muted: true })), 'named chats are always in')
  assert.ok(!inFolder(r, chat({ id: '6', unread: 3 })), 'excluded chats are out')
  assert.ok(inFolder(r, chat({ unread: 2 })), 'an unread contact')
  assert.ok(!inFolder(r, chat({ unread: 0 })), 'read chats are left out')
  assert.ok(inFolder(r, chat({ unreadMark: true })), 'marked unread counts as unread')
  assert.ok(!inFolder(r, chat({ unread: 2, muted: true })), 'muted chats are left out')
  assert.ok(!inFolder(r, chat({ unread: 2, contact: false })), 'non-contacts are not in this folder')
  assert.ok(inFolder(r, chat({ kind: 'group', unread: 1 })), 'groups are')
  assert.ok(!inFolder(r, chat({ kind: 'channel', unread: 1 })), 'channels are not')
  assert.ok(!inFolder(r, chat({ bot: true, unread: 1 })), 'bots are not')
  assert.ok(!inFolder(rules({ contacts: true, excludeArchived: true }), chat({ archived: true })), 'archived can be left out')
})

test('countsAsUnread leaves out muted and archived chats', () => {
  assert.ok(countsAsUnread(chat({ unread: 1 })))
  assert.ok(countsAsUnread(chat({ unreadMark: true })))
  assert.ok(!countsAsUnread(chat({ unread: 1, muted: true })))
  assert.ok(!countsAsUnread(chat({ unread: 1, archived: true })))
  assert.ok(!countsAsUnread(chat({})))
})
