// The page header, same as IV Studio's: a heavy condensed title and a spaced kicker on the dark left,
// with the chat-bubble artwork fading in on the right.
export default function Hero({ title, accent, kicker }) {
  return (
    <header className="hero">
      <div className="hero-art" aria-hidden="true" />
      <div className="hero-text">
        <h1 className="hero-title">
          {title}
          {accent && <span className="accent"> {accent}</span>}
        </h1>
        {kicker && <p className="hero-kicker">{kicker}</p>}
      </div>
    </header>
  )
}
