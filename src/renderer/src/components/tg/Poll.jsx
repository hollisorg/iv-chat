import { useState } from 'react'
import Icon from './Icon'

// A poll in a message, drawn like Telegram Desktop's: before you vote, the answers are buttons (or checkboxes
// for multiple answers); after, each shows its share of the votes, with your choice ticked and, in a quiz, the
// right answer marked. You can take your vote back unless it's a quiz or the poll has closed.
const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function PollCard({ dialogId, m, onChanged, onError }) {
  const p = m.poll
  const [picked, setPicked] = useState([])
  const [busy, setBusy] = useState(false)
  const showResults = p.voted || p.closed
  const vote = async (options) => {
    setBusy(true)
    try {
      await window.iv.telegram.vote(dialogId, m.id, options)
      setPicked([])
      await onChanged()
    } catch (err) {
      onError(/REVOTE_NOT_ALLOWED/.test(String(err)) ? "This poll doesn't let you change your vote." : clean(err))
    } finally {
      setBusy(false)
    }
  }
  const label = p.closed ? 'Final results' : p.quiz ? (p.anonymous ? 'Anonymous quiz' : 'Quiz') : p.anonymous ? 'Anonymous poll' : 'Poll'
  return (
    <div className={`poll${busy ? ' is-busy' : ''}`}>
      <span className="poll-question">{p.question}</span>
      <span className="mono dim poll-kind">
        {label}
        {p.multiple && !showResults ? ' · choose any' : ''}
      </span>
      <ul className="poll-answers">
        {p.answers.map((a) => {
          if (showResults) {
            const right = p.quiz && a.correct
            const wrong = p.quiz && a.chosen && !a.correct
            return (
              <li key={a.option} className={`poll-result${right ? ' is-right' : ''}${wrong ? ' is-wrong' : ''}`}>
                <span className="poll-percent mono">{a.percent}%</span>
                <span className="poll-text">
                  {a.text}
                  {a.chosen && <span className="poll-mine"> ✓</span>}
                </span>
                <span className="poll-bar" style={{ '--share': Math.max(0.02, a.percent / 100) }} />
              </li>
            )
          }
          if (p.multiple) {
            return (
              <li key={a.option}>
                <label className="poll-choice">
                  <input type="checkbox" checked={picked.includes(a.option)} onChange={(e) => setPicked((list) => (e.target.checked ? [...list, a.option] : list.filter((x) => x !== a.option)))} />
                  <span>{a.text}</span>
                </label>
              </li>
            )
          }
          return (
            <li key={a.option}>
              <button type="button" className="poll-option" disabled={busy} onClick={() => vote([a.option])}>
                {a.text}
              </button>
            </li>
          )
        })}
      </ul>
      <div className="poll-foot">
        <span className="mono dim">
          {p.total.toLocaleString()} vote{p.total === 1 ? '' : 's'}
        </span>
        {!showResults && p.multiple && (
          <button type="button" className="btn btn-quiet" disabled={!picked.length || busy} onClick={() => vote(picked)}>
            Vote
          </button>
        )}
        {p.voted && !p.closed && !p.quiz && (
          <button type="button" className="link" disabled={busy} onClick={() => vote([])}>
            Retract vote
          </button>
        )}
      </div>
      {p.quiz && showResults && p.solution && <p className="poll-solution dim small">💡 {p.solution}</p>}
    </div>
  )
}

// New poll: a question, 2 to 10 answers, and whether it's anonymous, takes several answers, or is a quiz.
export function PollDialog({ onSend, onClose }) {
  const [question, setQuestion] = useState('')
  const [answers, setAnswers] = useState(['', ''])
  const [anonymous, setAnonymous] = useState(true)
  const [multiple, setMultiple] = useState(false)
  const [quiz, setQuiz] = useState(false)
  const [correct, setCorrect] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const filled = answers.map((a) => a.trim()).filter(Boolean)
  const ready = question.trim() && filled.length >= 2 && (!quiz || answers[correct]?.trim())
  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      // The right answer's place among the answers that are actually filled in.
      const index = answers.slice(0, correct).filter((a) => a.trim()).length
      await onSend({ question: question.trim(), answers: filled, anonymous, multiple: multiple && !quiz, quiz, correct: index })
    } catch (err) {
      setError(clean(err))
      setBusy(false)
    }
  }
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal poll-dialog" role="dialog" aria-label="New poll" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h3 className="modal-title">New poll</h3>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a question" maxLength={300} autoFocus />
        <div className="poll-edit">
          {answers.map((a, i) => (
            <div key={i} className="poll-edit-row">
              {quiz && <input type="radio" name="correct" checked={correct === i} onChange={() => setCorrect(i)} title="The right answer" aria-label={`Answer ${i + 1} is right`} />}
              <input
                value={a}
                onChange={(e) => setAnswers((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
                placeholder={`Answer ${i + 1}`}
                maxLength={100}
              />
              {answers.length > 2 && (
                <button type="button" className="attach-remove" onClick={() => setAnswers((list) => list.filter((_, j) => j !== i))} aria-label={`Remove answer ${i + 1}`}>
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>
          ))}
          {answers.length < 10 && (
            <button type="button" className="link" onClick={() => setAnswers((list) => [...list, ''])}>
              + Add an answer
            </button>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
          <span>Anonymous voting</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={multiple && !quiz} disabled={quiz} onChange={(e) => setMultiple(e.target.checked)} />
          <span>People can choose more than one answer</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={quiz} onChange={(e) => setQuiz(e.target.checked)} />
          <span>Quiz: one answer is right (pick it with the circle)</span>
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row-actions">
          <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={send}>
            {busy ? 'Sending…' : 'Send poll'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
