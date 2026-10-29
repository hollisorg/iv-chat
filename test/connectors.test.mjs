import test from 'node:test'
import assert from 'node:assert/strict'
import { claudeDesktopConnect, claudeDesktopDisconnect, codexConnect, codexDisconnect } from '../src/main/connectors.js'

const launch = {
  command: 'C:\\Users\\Matt\\iv-chat\\node_modules\\electron\\dist\\electron.exe',
  args: ['C:\\Users\\Matt\\iv-chat\\out\\main\\bridge.js', '--profile', 'C:\\Users\\Matt\\AppData\\Roaming\\IV Chat']
}

const CODEX = `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "npx"\nargs = ["-y", "thing"]\n`

test('Codex: connect then disconnect restores the file byte for byte', () => {
  for (const original of [CODEX, CODEX.trimEnd(), '', '# only a comment']) {
    const added = codexConnect(original, launch)
    assert.ok(added.startsWith(original), 'everything before stays exactly as it was')
    assert.match(added, /\[mcp_servers\.iv-chat\]/)
    assert.match(added, /ELECTRON_RUN_AS_NODE = "1"/)
    assert.equal(codexDisconnect(added), original)
  }
})

test('Codex: Windows paths are literal TOML strings and reconnecting replaces in place', () => {
  const added = codexConnect(CODEX, launch)
  assert.ok(added.includes(`command = '${launch.command}'`))
  const again = codexConnect(added, { ...launch, args: ['x'] })
  assert.equal((again.match(/\[mcp_servers\.iv-chat\]/g) || []).length, 1)
  assert.match(again, /args = \['x'\]/)
  assert.equal(codexDisconnect(again), CODEX)
})

test('Codex: refuses to touch an iv-chat server someone else added', () => {
  assert.throws(() => codexConnect(`${CODEX}\n[mcp_servers.iv-chat]\ncommand = "x"\n`, launch), /did not add/)
})

const DESKTOP = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users"]
    }
  },
  "globalShortcut": "Ctrl+Space"
}
`

test('Claude Desktop: adds to existing mcpServers without reformatting, and removes cleanly', () => {
  const { text, inserted } = claudeDesktopConnect(DESKTOP, launch)
  const parsed = JSON.parse(text)
  assert.equal(parsed.mcpServers['iv-chat'].command, launch.command)
  assert.deepEqual(parsed.mcpServers['iv-chat'].env, { ELECTRON_RUN_AS_NODE: '1' })
  assert.ok(text.includes(DESKTOP.slice(DESKTOP.indexOf('"filesystem"'))), 'the other entries are untouched')
  assert.equal(claudeDesktopDisconnect(text, inserted), DESKTOP)
})

test('Claude Desktop: creates mcpServers when missing, and handles empty or missing files', () => {
  for (const original of ['{\n  "globalShortcut": "x"\n}\n', '{}', '']) {
    const { text, inserted } = claudeDesktopConnect(original, launch)
    assert.equal(JSON.parse(text).mcpServers['iv-chat'].args.length, 3)
    if (original) assert.equal(claudeDesktopDisconnect(text, inserted), original)
  }
  const emptyServers = claudeDesktopConnect('{ "mcpServers": {} }', launch)
  assert.ok(JSON.parse(emptyServers.text).mcpServers['iv-chat'])
  assert.equal(claudeDesktopDisconnect(emptyServers.text, emptyServers.inserted), '{ "mcpServers": {} }')
})

test('Claude Desktop: refuses broken JSON, an existing iv-chat entry, or an edited entry', () => {
  assert.throws(() => claudeDesktopConnect('{ "mcpServers": ', launch))
  const { text } = claudeDesktopConnect(DESKTOP, launch)
  assert.throws(() => claudeDesktopConnect(text, launch), /already have/)
  assert.throws(() => claudeDesktopDisconnect(text.replace('ELECTRON_RUN_AS_NODE', 'X'), 'not there'), /by hand/)
})
