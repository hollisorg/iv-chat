import { Component } from 'react'

// Last line of defence: if a screen fails to draw, show a way back instead of an empty window.
export default class Crashed extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crashed">
        <p className="mono label">IV Chat</p>
        <h1 className="panel-title">Something went wrong.</h1>
        <p className="dim">Your chats and sign-ins are fine. Reload to carry on.</p>
        <p className="mono dim">{String(this.state.error?.message || this.state.error).slice(0, 200)}</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
