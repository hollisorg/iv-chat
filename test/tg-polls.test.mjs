import test from 'node:test'
import assert from 'node:assert/strict'
import { markupInfo, mediaInfo, messageText, pollInfo } from '../src/main/tg-format.js'

const opt = (n) => Buffer.from([n])
const pollMsg = (results) => ({
  media: {
    className: 'MessageMediaPoll',
    poll: { question: { text: 'Lunch?' }, answers: [{ text: { text: 'Pizza' }, option: opt(0) }, { text: { text: 'Tacos' }, option: opt(1) }], quiz: true, multipleChoice: false, publicVoters: false },
    results
  }
})

test('pollInfo gives each answer its votes, share, your choice and the right one', () => {
  const p = pollInfo(pollMsg({ totalVoters: 4, results: [{ option: opt(0), voters: 1, chosen: true }, { option: opt(1), voters: 3, correct: true }], solution: 'Tacos day' }))
  assert.equal(p.question, 'Lunch?')
  assert.deepEqual(p.answers.map((a) => [a.text, a.voters, a.percent, a.chosen, a.correct]), [
    ['Pizza', 1, 25, true, false],
    ['Tacos', 3, 75, false, true]
  ])
  assert.equal(p.total, 4)
  assert.ok(p.voted && p.quiz && p.anonymous)
  assert.equal(p.solution, 'Tacos day')
  assert.equal(p.answers[0].option, opt(0).toString('base64'))
})

test('a poll nobody has voted on, and how it reads in the chat list', () => {
  const p = pollInfo(pollMsg(undefined))
  assert.equal(p.total, 0)
  assert.ok(!p.voted)
  assert.deepEqual(p.answers.map((a) => a.percent), [0, 0])
  assert.equal(mediaInfo(pollMsg()), null)
  assert.equal(messageText(pollMsg()), '📊 Lunch?')
})

test('markupInfo reads inline buttons and bot keyboards', () => {
  const inline = markupInfo({
    replyMarkup: {
      className: 'ReplyInlineMarkup',
      rows: [{ buttons: [{ className: 'KeyboardButtonCallback', text: 'Yes', data: Buffer.from('y') }, { className: 'KeyboardButtonUrl', text: 'Site', url: 'https://iv.ai' }] }, { buttons: [{ className: 'KeyboardButtonBuy', text: 'Pay' }] }]
    }
  })
  assert.equal(inline.type, 'inline')
  assert.deepEqual(inline.rows[0], [
    { text: 'Yes', kind: 'callback', data: Buffer.from('y').toString('base64') },
    { text: 'Site', kind: 'url', url: 'https://iv.ai' }
  ])
  assert.equal(inline.rows[1][0].kind, 'other')
  const kb = markupInfo({ replyMarkup: { className: 'ReplyKeyboardMarkup', resize: true, singleUse: true, rows: [{ buttons: [{ className: 'KeyboardButton', text: 'Menu' }] }] } })
  assert.deepEqual([kb.type, kb.resize, kb.single, kb.rows[0][0].kind], ['keyboard', true, true, 'text'])
  assert.deepEqual(markupInfo({ replyMarkup: { className: 'ReplyKeyboardHide' } }), { type: 'hide' })
  assert.equal(markupInfo({}), null)
})
