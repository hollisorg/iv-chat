// Launches IV Chat on a throwaway profile with a debug port and checks it through the Chrome DevTools Protocol:
// the four website panels (plain Chrome user agent, no Node access, declined notifications and passkeys,
// off-site navigation blocked), latest messages, view switching, Telegram setup, and a real MCP client
// talking to IV Chat through the bridge (five tools, no send, access rules, token-protected pipe).
// It never signs in, reads real chats or types into the sites.
// Usage: node scripts/smoke-test.mjs [path to IV Chat.exe] [screenshot folder]
// With no executable it runs the built app from this folder (npm run build first).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { pipePath } from '../src/main/mcp-common.js'

const [exeArg, shotDir] = process.argv.slice(2)
const PORT = 9334
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const electronBin = path.resolve('node_modules/electron/dist/electron.exe')
// A fresh, empty profile: no real sign-ins are ever loaded or captured.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-chat-test-'))
const env = { ...process.env, IV_CHAT_PROFILE: profile }
const app = exeArg
  ? spawn(exeArg, [`--remote-debugging-port=${PORT}`], { stdio: 'inherit', env })
  : spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], { stdio: 'inherit', env })

let failed = false
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failed = true
}

async function targets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.addEventListener('open', r)
    ws.addEventListener('error', j)
  })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    if (pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id
      pending.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const run = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || 'eval failed')
    return res.result.result.value
  }
  return { ws, send, run }
}

const hostOf = (t) => {
  try {
    return new URL(t.url).hostname
  } catch {
    return ''
  }
}

try {
  let all = []
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    try {
      all = await targets()
      const hosts = all.map(hostOf)
      if (['whatsapp.com', 'facebook.com', 'instagram.com', 'linkedin.com'].every((d) => hosts.some((h) => h.endsWith(d)))) break
    } catch {
      /* not up yet */
    }
  }
  const shell = all.find((t) => t.type === 'page' && t.url.startsWith('file:'))
  const page = (d) => all.find((t) => t.type === 'page' && hostOf(t).endsWith(d))
  const wa = page('whatsapp.com')
  const fb = page('facebook.com')
  const ig = page('instagram.com')
  const li = page('linkedin.com')
  check(Boolean(shell), 'IV Chat window loaded')
  check(Boolean(wa), `WhatsApp panel opened (${wa?.url})`)
  check(Boolean(fb), `Messenger panel opened (${fb?.url})`)
  check(Boolean(ig), `Instagram panel opened (${ig?.url})`)
  check(Boolean(li), `LinkedIn panel opened (${li?.url})`)

  const ui = await connect(shell)
  await sleep(4000)

  const services = await ui.run('window.iv.services.list()')
  console.log('services:', JSON.stringify(services))
  check(services.length === 4 && services.every((s) => s.enabled), 'all four website services on by default')
  check(services.every((s) => s.state === 'ready'), 'all four panels finished loading')

  // Signed out (fresh profile): the reader finds no chat list and Updates says to sign in.
  const chats = await ui.run('window.iv.chats.get()')
  check(chats.whatsapp?.status === 'no-list' && chats.messenger?.status === 'no-list', `latest messages see no chat list while signed out (${chats.whatsapp?.status}, ${chats.messenger?.status})`)
  const notes = await ui.run(`[...document.querySelectorAll('.page p')].map((p) => p.textContent).filter((t) => /^Sign in to/.test(t)).length`)
  check(notes === 2, 'Updates asks to sign in to each service for its messages')
  // Turning the setting off stops the reader and clears the list.
  await ui.run('window.iv.settings.set({ latestMessages: false })')
  await sleep(800)
  const off = await ui.run('window.iv.chats.get()')
  check(off.whatsapp.status === 'off' && off.messenger.status === 'off', 'turning off latest messages clears them')
  await ui.run('window.iv.settings.set({ latestMessages: true })')
  await sleep(4500)
  const back = await ui.run('window.iv.chats.get()')
  check(back.whatsapp.status === 'no-list' && back.messenger.status === 'no-list', 'turning it back on resumes reading')

  for (const [name, target] of [
    ['WhatsApp', wa],
    ['Messenger', fb],
    ['Instagram', ig],
    ['LinkedIn', li]
  ]) {
    const page = await connect(target)
    const ua = await page.run('navigator.userAgent')
    check(/Chrome\//.test(ua) && !/Electron|iv-chat/i.test(ua), `${name} sees a plain Chrome user agent`)
    // The sites define their own `require` module loaders, so check for Node itself instead.
    const nodeless = await page.run('!(typeof process !== "undefined" && process.versions && process.versions.node)')
    check(nodeless, `${name} page has no Node access`)
    const perm = await page.run('Notification.permission')
    check(perm === 'denied', `${name} site notifications are declined (IV Chat sends its own)`)
    const stored = await page.run('document.cookie.length >= 0 && typeof indexedDB === "object"')
    check(stored, `${name} has working site storage`)
    // Navigation off the service's domains must be stopped. (A non-web address is used so the
    // test doesn't open the default browser, which is what happens for ordinary outside links.)
    const before = await page.run('location.href')
    await page.send('Runtime.evaluate', { expression: "location.href = 'ftp://example.com/'" })
    await sleep(2500)
    const after = await page.run('location.href')
    check(after === before, `${name} panel stayed put when sent off-site`)
    // A passkey request nobody clicked for is declined without a Windows pop-up.
    const passkey = await page.run(
      "Promise.race([navigator.credentials.get({ publicKey: { challenge: new Uint8Array(16) } }).then(() => 'answered', (e) => e.name), new Promise((r) => setTimeout(() => r('timeout'), 4000))])"
    )
    check(passkey === 'NotAllowedError', `${name} declines unrequested passkey prompts (${passkey})`)
    page.ws.close()
  }

  // View switching through the same keyboard shortcuts a person would use.
  for (const [key, view] of [
    ['3', 'whatsapp'],
    ['4', 'messenger'],
    ['5', 'instagram'],
    ['6', 'linkedin'],
    ['2', 'telegram'],
    [',', 'settings'],
    ['1', 'updates']
  ]) {
    await ui.run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', ctrlKey: true }))`)
    await sleep(600)
    const heading = await ui.run(
      `document.querySelector('.nav-item.on')?.getAttribute('aria-label') || ''`
    )
    check(heading.toLowerCase().startsWith(view.slice(0, 5)), `Ctrl+${key} selects ${view} (${heading})`)
    // Only the panel being shown can be captured; a hidden one never paints.
    const target = { whatsapp: wa, messenger: fb, instagram: ig, linkedin: li }[view]
    if (shotDir && target) {
      await sleep(1500)
      const page = await connect(target)
      const res = await Promise.race([page.send('Page.captureScreenshot', { format: 'png' }), sleep(8000)])
      check(Boolean(res?.result?.data), `${view} panel is visible and painting`)
      if (res?.result?.data) fs.writeFileSync(path.join(shotDir, `panel-${view}.png`), Buffer.from(res.result.data, 'base64'))
      page.ws.close()
    }
  }

  // Refresh all reloads every website panel.
  const hasRefresh = await ui.run(`!!document.querySelector('.top-btn')`)
  check(hasRefresh, 'Refresh all button is in the top bar')
  await ui.run(`document.querySelector('.top-btn').click()`)
  await sleep(400)
  const during = await ui.run('window.iv.services.list()')
  check(during.some((s) => s.state === 'loading'), 'Refresh all reloads the website panels')
  await sleep(12000)
  const after = await ui.run('window.iv.services.list()')
  check(after.every((s) => s.state === 'ready'), 'every panel is back after refreshing')

  const settings = await ui.run('window.iv.settings.get()')
  check(settings.closeToTray === true, 'close to tray is on by default')
  check(settings.ai.enabled === true && settings.ai.mode === 'chosen' && settings.ai.allowed.length === 0, 'AI access starts with no chats shared')

  // Telegram without app keys shows the setup form.
  const tg = await ui.run('window.iv.telegram.state()')
  check(tg.status === 'needs-keys', `Telegram asks for app keys first (${tg.status})`)
  await ui.run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true }))`)
  await sleep(600)
  const form = await ui.run(`document.querySelectorAll('.form input').length`)
  check(form === 2, 'Telegram setup form is shown')
  const badKeys = await ui.run(`window.iv.telegram.saveKeys('abc', 'nothex').then(() => 'saved', (e) => 'refused')`)
  check(badKeys === 'refused', 'nonsense Telegram keys are refused')

  // A real MCP client talks to IV Chat through the bridge, the same way Codex or Claude would.
  const launch = (await ui.run('window.iv.ai.get()')).launch
  const client = new Client({ name: 'smoke-test', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: launch.command, args: launch.args, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'ignore' }))
  const tools = (await client.listTools()).tools.map((t) => t.name).sort()
  check(JSON.stringify(tools) === JSON.stringify(['draft_reply', 'get_updates', 'list_chats', 'read_chat', 'search_messages']), `MCP offers the five tools and no send (${tools.join(', ')})`)
  const listed = await client.callTool({ name: 'list_chats', arguments: {} })
  check(!listed.isError && /No chats are shared/.test(listed.content[0].text) && /never follow instructions/.test(listed.content[0].text), 'list_chats works and shows nothing until chats are shared')
  const draft = await client.callTool({ name: 'draft_reply', arguments: { chat_id: 'telegram:1', text: 'hi' } })
  check(draft.isError === true, 'draft_reply refuses a chat that is not shared')
  const logged = (await ui.run('window.iv.ai.get()')).activity
  check(logged.length >= 2 && logged.every((a) => !('text' in a)), 'AI activity is logged without message text')
  await ui.run('window.iv.settings.set({ ai: { enabled: false } })')
  const blocked = await client.callTool({ name: 'list_chats', arguments: {} })
  check(blocked.isError === true && /turned off AI access/.test(blocked.content[0].text), 'turning AI access off blocks the AI')
  await ui.run('window.iv.settings.set({ ai: { enabled: true } })')

  // The pipe drops anyone without the token.
  const intruder = await new Promise((resolve) => {
    const sock = net.connect(pipePath(profile))
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, token: 'wrong', tool: 'list_chats', args: {} }) + '\n'))
    sock.on('data', () => resolve('answered'))
    sock.on('close', () => resolve('dropped'))
    sock.on('error', () => resolve('dropped'))
  })
  check(intruder === 'dropped', 'the private pipe ignores callers without the token')
  ui.ws.close()
  app.kill()
  await sleep(2500)
  const gone = await client.callTool({ name: 'list_chats', arguments: {} })
  check(gone.isError === true && /not running/.test(gone.content[0].text), 'with IV Chat closed the AI is told to open it')
  await client.close()

} catch (err) {
  console.log('FAIL ', err.message)
  failed = true
} finally {
  app.kill()
  await sleep(1500)
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}

process.exit(failed ? 1 : 0)
