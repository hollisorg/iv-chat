<p align="center">
  <img src="src/renderer/src/assets/chat-art.webp" alt="IV Chat: your chats in one place" width="100%">
</p>

<p align="center">
  <a href="https://github.com/hollisorg/iv-chat/releases/latest/download/IV-Chat-Setup.exe"><b>Download for Windows</b></a>
  &nbsp;·&nbsp;
  <a href="#install">Install</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/hollisorg/iv-chat/releases/latest">Release notes</a>
  &nbsp;·&nbsp;
  <a href="https://infinitevariance.ai">Infinite Variance</a>
</p>

# IV Chat

A free Infinite Variance desktop app that puts WhatsApp, Messenger, Instagram, LinkedIn and Telegram in
one window. Your own Codex or Claude can read the chats you choose, tell you what came in and draft
replies, but nothing is ever sent for you: a message only goes when you press Enter or Send.

## What it does

- **One window.** WhatsApp, Messenger, Instagram and LinkedIn run as their own websites inside IV Chat,
  each signed in separately. Telegram connects directly through Telegram's official API.
- **Updates.** One page with your unread counts and the latest messages from WhatsApp, Messenger and
  Telegram.
- **Telegram, built in, like Telegram Desktop.**
  - Clickable links with previews, and Telegram's formatting: bold, italic, code, quotes, spoilers.
  - Videos play right in the chat, starting while they download, with seeking. GIFs, video stickers and
    animated stickers loop by themselves; round video messages play in a circle; photos open in a viewer.
  - Reply, edit (or press Up in an empty box), delete, forward, copy and pin. Albums, date separators,
    read ticks, "typing…", online and last seen, a pinned-message bar, search in the chat and a jump to
    the latest messages.
  - Record and send voice messages, play them with a waveform player, react with emoji, and send pictures
    and files by picking, dropping or pasting them.
  - Real profile pictures for people, groups and channels.
  - Your chat list as in Telegram: your folders as tabs, pinned chats first, archived chats behind their own
    row, muted chats marked, and a right-click menu to pin, mute, mark read or unread, and archive.
  - Search your chats, people and public groups and channels in one box, or start a New chat.
  - A chat info panel with the about text, @username and member count, and the chat's shared photos and
    videos, files, links and voice messages.
  - Vote in polls (and take your vote back) and send your own, including quizzes and multiple-choice polls.
  - Bot buttons under messages and bot keyboards above the reply box.
  - Right-click Send to send without sound or to schedule a message, and a list of what's scheduled with
    Send now and Delete.
  - Translate a message into your language from its menu.
  - Select several messages to copy, forward or delete them together.
- **Room to work.** The sidebar collapses to a column of round logo buttons with their unread counts.
- **Draft reply.** A button above every chat writes a reply with the Codex app or Claude Code already on
  your PC. Add a few words about what you want to say if you like. The draft lands in the reply box for
  you to check, edit and send yourself.
- **Your AI, through MCP.** One click connects IV Chat to Codex, Claude Desktop or Claude Code. Your AI
  can list chats, read the ones you allow, search, catch up on what's new and leave drafts. There's no
  send tool.
- **Stays in the background.** Closing the window keeps IV Chat in the tray, with notifications for new
  messages. It updates itself.

## What stays private

- Your sign-ins stay on this computer. Telegram's session and app keys are stored encrypted with Windows'
  own protection.
- Your AI sees only the chats you allow (by default, only chats you pick one by one), and one switch in
  the top bar turns its access off everywhere. It's limited to 60 requests a minute and 20 drafts an hour.
- When you press Draft reply, that chat's recent messages and your reply preferences go to the AI you use
  (Codex or Claude), under that service's terms. Nothing else goes anywhere: IV Chat has no servers of its
  own.

## What you need

- Windows 10 or 11, 64-bit.
- For Telegram: your own free `api_id` and `api_hash` from [my.telegram.org](https://my.telegram.org)
  (IV Chat shows you where).
- For Draft reply and MCP (optional): the [Codex](https://openai.com/codex) app or
  [Claude Code](https://claude.com/claude-code), installed and signed in. Claude Desktop also works for
  MCP.

## Install

1. [Download `IV-Chat-Setup.exe`](https://github.com/hollisorg/iv-chat/releases/latest/download/IV-Chat-Setup.exe)
   (about 120 MB).
2. Run it. The installer isn't code-signed yet, so Windows may show **"Windows protected your PC"**.
   Click **More info → Run anyway**. It installs for your user only; no admin rights needed.
3. Open each service in the left bar and sign in. For Telegram, add your app keys, then scan the QR code
   with Telegram on your phone.
4. Optional: open **Settings → Your AI** to pick which chats your AI can see and connect it to Codex or
   Claude.

IV Chat checks for a new version when it opens and every six hours, downloads it in the background and
installs it when you click **Update** in the top bar or quit. Your settings are kept in
`%APPDATA%\IV Chat`.

## Develop

```bash
npm install
npm run dev      # run from source
npm test         # unit tests
npm run dist     # unsigned NSIS installer in dist/
```

`scripts/smoke-test.mjs` drives a packaged build on a throwaway profile (`IV_CHAT_PROFILE`).
`IV_CHAT_UPDATE_FEED` points a copy at a local update feed for testing; such a copy never installs on
quit.

## Licences

IV Chat is MIT-licensed (see [LICENSE](LICENSE)); the Infinite Variance artwork and icon are Infinite
Variance's own and aren't covered by the MIT licence. Third-party notices are in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).

IV Chat isn't affiliated with or endorsed by Meta, WhatsApp, Instagram, LinkedIn, Telegram, OpenAI or
Anthropic. Each service's own terms apply to your use of it.
