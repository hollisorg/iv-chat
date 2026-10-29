import { useState } from 'react'
import { formatRuns } from '../../../../main/tg-format.js'

// A message's text with Telegram's formatting: bold, italic, underline, strikethrough, code, quotes, spoilers,
// and clickable links, e-mail addresses and @usernames. Links open in your browser (index.js decides how).
function Run({ run }) {
  const [shown, setShown] = useState(false)
  const t = new Set(run.types)
  let node = run.text
  if (t.has('code')) node = <code className="tg-code">{node}</code>
  if (t.has('bold')) node = <strong>{node}</strong>
  if (t.has('italic')) node = <em>{node}</em>
  if (t.has('underline')) node = <u>{node}</u>
  if (t.has('strike')) node = <s>{node}</s>
  if (t.has('mention_name') || t.has('hashtag') || t.has('command')) node = <span className="tg-tag">{node}</span>
  if (run.href) {
    node = (
      <a className="tg-link" href={run.href} target="_blank" rel="noreferrer" title={run.href} onClick={(e) => e.stopPropagation()}>
        {node}
      </a>
    )
  }
  if (t.has('spoiler') && !shown) {
    node = (
      <span className="tg-spoiler" role="button" tabIndex={0} title="Show the hidden text" onClick={() => setShown(true)} onKeyDown={(e) => e.key === 'Enter' && setShown(true)}>
        {node}
      </span>
    )
  }
  return node
}

export default function RichText({ text, entities }) {
  const runs = formatRuns(text, entities)
  // Pre blocks and quotes are whole paragraphs; everything else flows inline.
  const out = []
  let block = null
  runs.forEach((run, i) => {
    const kind = run.types.includes('pre') ? 'pre' : run.types.includes('quote') ? 'quote' : null
    if (kind && block?.kind === kind) {
      block.items.push(<Run key={i} run={run} />)
      return
    }
    if (block) out.push(block)
    block = kind ? { kind, items: [<Run key={i} run={run} />] } : null
    if (!kind) out.push(<Run key={i} run={run} />)
  })
  if (block) out.push(block)
  return (
    <span className="bubble-text">
      {out.map((b, i) =>
        b && b.kind === 'pre' ? (
          <pre key={`b${i}`} className="tg-pre">
            {b.items}
          </pre>
        ) : b && b.kind === 'quote' ? (
          <blockquote key={`b${i}`} className="tg-quote">
            {b.items}
          </blockquote>
        ) : (
          b
        )
      )}
    </span>
  )
}
