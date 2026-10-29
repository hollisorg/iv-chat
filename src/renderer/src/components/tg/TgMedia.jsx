import { Component, useEffect, useRef, useState } from 'react'
import lottie from 'lottie-web/build/player/lottie_light'

// Everything a Telegram message can carry besides text, drawn the way Telegram Desktop does:
// photos open in a viewer, videos play right in the chat, GIFs and video stickers loop silently, round video
// messages play in a circle, animated stickers run as Lottie animations, and voice messages get a waveform
// player. Big files stream from Telegram as they play (ivtg://, see main/tg-media.js); nothing is saved
// unless the person presses Save.

export function formatSize(bytes) {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}

const fileExt = (name) => (name && name.includes('.') ? name.split('.').pop() : '')
const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export const clock = (sec) => {
  const s = Math.max(0, Math.round(sec || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}

const KIND_LABEL = { photo: 'Photo', video: 'Video', gif: 'GIF', 'gif-file': 'GIF', round: 'Video message', voice: 'Voice message', audio: 'Audio', file: 'File', sticker: 'Sticker', 'sticker-video': 'Sticker', 'sticker-animated': 'Sticker', other: 'Media' }

// GIFs, stickers and round videos start by themselves only up to this size; bigger ones wait for a click.
const AUTOPLAY_BYTES = 12 * 1024 * 1024
const MAX_PLAY_BYTES = 25 * 1024 * 1024

// If one message can't be drawn, show a note in its place instead of losing the whole window.
export class SafeMessage extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? <span className="media-label mono">Couldn't show this message here</span> : this.props.children
  }
}

// The small preview picture Telegram keeps for a photo, video, sticker or link (loaded once, kept in memory).
export function usePreview(dialogId, msgId, wanted) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    if (!wanted) return
    let live = true
    window.iv.telegram
      .preview(dialogId, msgId)
      .then((url) => live && setSrc(url))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [dialogId, msgId, wanted])
  return src
}

// The streamed full file's address, asked for only when it's needed.
async function fullUrl(dialogId, msgId) {
  return window.iv.telegram.mediaUrl(dialogId, msgId)
}

// True once the element has scrolled into view (so off-screen GIFs don't download).
function useVisible(ref) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  return visible
}

// Keeps a picture's real shape inside a bubble-sized box.
function boxStyle(info, maxW = 360, maxH = 380) {
  const w = info.w || 16
  const h = info.h || 9
  const scale = Math.min(maxW / w, maxH / h, 1.6)
  return { width: Math.max(140, Math.round(w * scale)), aspectRatio: `${w} / ${h}` }
}

function useSave(dialogId, msgId) {
  const [saving, setSaving] = useState(false)
  const save = async (e) => {
    e?.stopPropagation()
    setSaving(true)
    try {
      await window.iv.telegram.save(dialogId, msgId)
    } catch {
      /* the person can try again */
    } finally {
      setSaving(false)
    }
  }
  return [saving, save]
}

// ---------- photo viewer ----------

export function PhotoViewer({ dialogId, msgId, preview, onClose }) {
  const [src, setSrc] = useState(null)
  const [saving, save] = useSave(dialogId, msgId)
  useEffect(() => {
    let live = true
    fullUrl(dialogId, msgId).then((u) => live && setSrc(u))
    const esc = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => {
      live = false
      window.removeEventListener('keydown', esc)
    }
  }, [dialogId, msgId, onClose])
  return (
    <div className="viewer" role="dialog" aria-label="Photo" onClick={onClose}>
      <img className="viewer-img" src={src || preview} alt="Photo" onClick={(e) => e.stopPropagation()} />
      <div className="viewer-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="btn btn-quiet" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

// ---------- the players ----------

function Photo({ dialogId, m, onOpen, inAlbum }) {
  const info = m.media
  const src = usePreview(dialogId, m.id, true)
  const [hidden, setHidden] = useState(info.spoiler)
  return (
    <button
      type="button"
      className={`media-photo${hidden ? ' is-spoiler' : ''}`}
      style={inAlbum ? undefined : boxStyle(info)}
      onClick={() => (hidden ? setHidden(false) : onOpen({ msgId: m.id, preview: src }))}
      title={hidden ? 'Show the photo' : 'Open the photo'}
    >
      {src ? <img src={src} alt="Photo" /> : <span className="media-wait mono">Loading photo…</span>}
      {hidden && <span className="media-spoiler mono">Spoiler · click to show</span>}
    </button>
  )
}

// A video that plays inside the chat. The first frame shows until it's clicked; then it streams and plays
// with the usual controls, including fullscreen.
function Video({ dialogId, m, inAlbum }) {
  const info = m.media
  const poster = usePreview(dialogId, m.id, info.preview)
  const [src, setSrc] = useState(null)
  const [saving, save] = useSave(dialogId, m.id)
  const videoRef = useRef(null)
  const start = async () => setSrc(await fullUrl(dialogId, m.id))
  useEffect(() => {
    if (src) videoRef.current?.play().catch(() => {})
  }, [src])
  // Starting any video or voice message pauses the others.
  useEffect(() => {
    const other = (e) => e.detail !== videoRef.current && videoRef.current?.pause()
    window.addEventListener('iv-audio-play', other)
    return () => window.removeEventListener('iv-audio-play', other)
  }, [])
  return (
    <div className="media-video" style={inAlbum ? undefined : boxStyle(info)}>
      {src ? (
        <video
          ref={videoRef}
          src={src}
          poster={poster || undefined}
          controls
          playsInline
          preload="auto"
          onPlay={(e) => window.dispatchEvent(new CustomEvent('iv-audio-play', { detail: e.currentTarget }))}
        />
      ) : (
        <button type="button" className="media-video-start" onClick={start} title="Play the video">
          {poster ? <img src={poster} alt="" /> : <span className="media-wait mono">Video</span>}
          <span className="media-play" aria-hidden="true">
            ▶
          </span>
          <span className="media-badge mono">
            {clock(info.duration)}
            {info.size ? ` · ${formatSize(info.size)}` : ''}
          </span>
        </button>
      )}
      <button type="button" className="media-save mono" onClick={save} disabled={saving} title="Save the video to your computer">
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}

// GIFs (which Telegram sends as short silent videos) and video stickers loop by themselves once visible.
function Loop({ dialogId, m, className, inAlbum }) {
  const info = m.media
  const ref = useRef(null)
  const visible = useVisible(ref)
  const poster = usePreview(dialogId, m.id, info.preview)
  const [src, setSrc] = useState(null)
  const [paused, setPaused] = useState(false)
  const auto = !info.size || info.size <= AUTOPLAY_BYTES
  useEffect(() => {
    if (visible && auto && !src) fullUrl(dialogId, m.id).then(setSrc)
  }, [visible, auto, src, dialogId, m.id])
  useEffect(() => {
    const v = ref.current?.querySelector('video')
    if (!v) return
    if (visible && !paused) v.play().catch(() => {})
    else v.pause()
  }, [visible, paused, src])
  const click = () => {
    if (!src) return fullUrl(dialogId, m.id).then(setSrc)
    setPaused((p) => !p)
  }
  const style = className === 'media-sticker' || inAlbum ? undefined : boxStyle(info, 320, 320)
  return (
    <div ref={ref} className={className} style={style} onClick={click} title={className === 'media-gif' ? (paused ? 'Play' : 'Pause') : undefined}>
      {src ? <video src={src} poster={poster || undefined} muted loop playsInline autoPlay /> : poster ? <img src={poster} alt={KIND_LABEL[info.kind]} /> : <span className="media-wait mono">{KIND_LABEL[info.kind]}</span>}
      {className === 'media-gif' && <span className="media-badge mono">GIF</span>}
    </div>
  )
}

// A round video message: plays silently on a loop like Telegram, and from the start with sound when clicked.
function Round({ dialogId, m }) {
  const info = m.media
  const ref = useRef(null)
  const visible = useVisible(ref)
  const poster = usePreview(dialogId, m.id, info.preview)
  const [src, setSrc] = useState(null)
  const [loud, setLoud] = useState(false)
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    if (visible && !src && (!info.size || info.size <= AUTOPLAY_BYTES)) fullUrl(dialogId, m.id).then(setSrc)
  }, [visible, src, info.size, dialogId, m.id])
  useEffect(() => {
    const other = (e) => {
      const v = ref.current?.querySelector('video')
      if (e.detail !== v && loud) {
        setLoud(false)
        if (v) v.muted = true
      }
    }
    window.addEventListener('iv-audio-play', other)
    return () => window.removeEventListener('iv-audio-play', other)
  }, [loud])
  const click = async () => {
    if (!src) setSrc(await fullUrl(dialogId, m.id))
    const v = ref.current?.querySelector('video')
    if (!v) return setLoud(true)
    if (loud && !v.paused) {
      v.pause()
      return
    }
    v.muted = false
    if (!loud) v.currentTime = 0
    setLoud(true)
    v.play().catch(() => {})
    window.dispatchEvent(new CustomEvent('iv-audio-play', { detail: v }))
  }
  return (
    <div ref={ref} className={`media-round${loud ? ' is-loud' : ''}`} onClick={click} title={loud ? 'Pause' : 'Play with sound'}>
      {src ? (
        <video
          src={src}
          poster={poster || undefined}
          muted={!loud}
          loop={!loud}
          autoPlay
          playsInline
          onTimeUpdate={(e) => loud && setProgress(e.currentTarget.currentTime / (e.currentTarget.duration || info.duration || 1))}
          onEnded={(e) => {
            setLoud(false)
            setProgress(0)
            e.currentTarget.muted = true
            e.currentTarget.loop = true
            e.currentTarget.play().catch(() => {})
          }}
        />
      ) : poster ? (
        <img src={poster} alt="Video message" />
      ) : null}
      {loud && (
        <svg className="media-round-ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="48" pathLength="1" style={{ strokeDashoffset: 1 - progress }} />
        </svg>
      )}
      <span className="media-badge mono">{loud ? clock(progress * info.duration) : `${clock(info.duration)} 🔇`}</span>
    </div>
  )
}

// Animated stickers are gzipped Lottie animations (.tgs); they're unpacked and played in the window.
function AnimatedSticker({ dialogId, m }) {
  const ref = useRef(null)
  const holder = useRef(null)
  const visible = useVisible(ref)
  const poster = usePreview(dialogId, m.id, m.media.preview)
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!visible || ready || failed) return
    let anim
    let live = true
    ;(async () => {
      try {
        const res = await fetch(await fullUrl(dialogId, m.id))
        const json = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).json()
        if (!live) return
        anim = lottie.loadAnimation({ container: holder.current, renderer: 'svg', loop: true, autoplay: true, animationData: json })
        setReady(true)
      } catch {
        if (live) setFailed(true)
      }
    })()
    return () => {
      live = false
      anim?.destroy()
      setReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, dialogId, m.id])
  return (
    <div ref={ref} className="media-sticker" title={m.media.emoji ? `Sticker ${m.media.emoji}` : 'Sticker'}>
      <div ref={holder} className="media-lottie" />
      {!ready && (poster ? <img src={poster} alt="Sticker" /> : <span className="media-sticker-emoji">{m.media.emoji || '🙂'}</span>)}
    </div>
  )
}

function StaticSticker({ dialogId, m }) {
  const src = usePreview(dialogId, m.id, true)
  return src ? <img className="media-sticker" src={src} alt={m.media.emoji ? `Sticker ${m.media.emoji}` : 'Sticker'} /> : <span className="media-sticker-emoji">{m.media.emoji || 'Sticker'}</span>
}

function GifFile({ dialogId, m }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    fullUrl(dialogId, m.id).then(setSrc)
  }, [dialogId, m.id])
  return src ? <img className="media-gif" style={boxStyle(m.media, 320, 320)} src={src} alt="GIF" /> : <span className="media-wait mono">GIF</span>
}

// ---------- voice and audio ----------

const SPEEDS = [1, 1.5, 2]

function AudioMessage({ dialogId, m }) {
  const info = m.media
  const [saving, onSave] = useSave(dialogId, m.id)
  const audioRef = useRef(null)
  const wantPlay = useRef(false)
  const wantSeek = useRef(null)
  const [src, setSrc] = useState(null)
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(info.duration || 0)
  const [speed, setSpeed] = useState(1)
  const [error, setError] = useState(null)
  const bars = info.bars?.length ? info.bars : Array.from({ length: 44 }, () => 0.4)
  const tooBig = info.size > MAX_PLAY_BYTES
  const label = info.kind === 'voice' ? 'Voice message' : info.name || 'Audio'

  // Starting another player pauses this one.
  useEffect(() => {
    const onOther = (e) => {
      if (e.detail !== audioRef.current) audioRef.current?.pause()
    }
    window.addEventListener('iv-audio-play', onOther)
    return () => window.removeEventListener('iv-audio-play', onOther)
  }, [])

  // Once the audio has arrived, jump to where the person clicked and start playing.
  useEffect(() => {
    const a = audioRef.current
    if (!a || !src) return
    a.playbackRate = speed
    if (wantSeek.current != null) {
      const go = () => {
        a.currentTime = wantSeek.current * (a.duration || length)
        wantSeek.current = null
      }
      if (a.readyState >= 1) go()
      else a.addEventListener('loadedmetadata', go, { once: true })
    }
    if (wantPlay.current) {
      wantPlay.current = false
      a.play().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  const load = async () => {
    if (src || loading) return
    setLoading(true)
    setError(null)
    try {
      setSrc(await window.iv.telegram.audio(dialogId, m.id))
    } catch (err) {
      wantPlay.current = false
      setError(clean(err))
    } finally {
      setLoading(false)
    }
  }

  const toggle = () => {
    const a = audioRef.current
    if (!src) {
      wantPlay.current = true
      return load()
    }
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }

  const seek = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    if (!src) {
      wantSeek.current = frac
      wantPlay.current = true
      return load()
    }
    const a = audioRef.current
    a.currentTime = frac * (a.duration || length)
    setTime(a.currentTime)
  }

  const nextSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
    setSpeed(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }

  const progress = length ? Math.min(1, time / length) : 0

  return (
    <div className={`voice${playing ? ' is-playing' : ''}`}>
      <button type="button" className="voice-play" onClick={toggle} disabled={tooBig} aria-label={playing ? `Pause ${label}` : `Play ${label}`}>
        {loading ? <span className="voice-spin" aria-hidden="true" /> : playing ? <span className="voice-pause" aria-hidden="true" /> : <span className="voice-tri" aria-hidden="true" />}
      </button>
      <div className="voice-main">
        <div
          className="voice-wave"
          role="slider"
          tabIndex={0}
          aria-label={`${label} position`}
          aria-valuemin={0}
          aria-valuemax={Math.round(length)}
          aria-valuenow={Math.round(time)}
          onClick={seek}
          onKeyDown={(e) => {
            const a = audioRef.current
            if (!a || !src) return
            if (e.key === 'ArrowRight') a.currentTime = Math.min(a.duration || length, a.currentTime + 3)
            if (e.key === 'ArrowLeft') a.currentTime = Math.max(0, a.currentTime - 3)
          }}
        >
          {bars.map((b, i) => (
            <span key={i} className={(i + 0.5) / bars.length <= progress ? 'on' : ''} style={{ height: `${Math.round(b * 100)}%` }} />
          ))}
        </div>
        <div className="voice-meta">
          <span className="mono">{clock(playing || time ? time : length)}</span>
          {info.kind === 'audio' && <span className="voice-name">{label}</span>}
          {tooBig && <span className="mono dim">Too large to play here</span>}
          {src && (
            <button type="button" className="voice-speed mono" onClick={nextSpeed} aria-label="Playback speed">
              {speed}×
            </button>
          )}
          {info.kind === 'audio' && (
            <button type="button" className="voice-speed mono" onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
        {error && <span className="media-label mono">{error}</span>}
      </div>
      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="auto"
          onPlay={(e) => {
            setPlaying(true)
            window.dispatchEvent(new CustomEvent('iv-audio-play', { detail: e.currentTarget }))
          }}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false)
            setTime(0)
          }}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setLength(e.currentTarget.duration)}
        />
      )}
    </div>
  )
}

// ---------- files and the dispatcher ----------

function FileCard({ dialogId, m }) {
  const info = m.media
  const src = usePreview(dialogId, m.id, info.preview)
  const [saving, save] = useSave(dialogId, m.id)
  return (
    <div className="media-file">
      {src ? <img className="media-file-thumb" src={src} alt="" /> : <span className="media-file-icon mono">{(fileExt(info.name) || KIND_LABEL[info.kind] || 'File').slice(0, 4)}</span>}
      <span className="media-file-main">
        <span className="media-file-name">{info.name || info.label || KIND_LABEL[info.kind] || 'Attachment'}</span>
        <span className="mono dim">{[KIND_LABEL[info.kind], formatSize(info.size)].filter(Boolean).join(' · ')}</span>
      </span>
      {info.kind !== 'other' && (
        <button type="button" className="btn btn-quiet" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
    </div>
  )
}

export function Media({ dialogId, m, onOpenPhoto, inAlbum }) {
  const kind = m.media.kind
  if (kind === 'voice' || kind === 'audio') return <AudioMessage dialogId={dialogId} m={m} />
  if (kind === 'photo') return <Photo dialogId={dialogId} m={m} onOpen={onOpenPhoto} inAlbum={inAlbum} />
  if (kind === 'video') return <Video dialogId={dialogId} m={m} inAlbum={inAlbum} />
  if (kind === 'gif') return <Loop dialogId={dialogId} m={m} className="media-gif" inAlbum={inAlbum} />
  if (kind === 'gif-file') return <GifFile dialogId={dialogId} m={m} />
  if (kind === 'round') return <Round dialogId={dialogId} m={m} />
  if (kind === 'sticker-video') return <Loop dialogId={dialogId} m={m} className="media-sticker" />
  if (kind === 'sticker-animated') return <AnimatedSticker dialogId={dialogId} m={m} />
  if (kind === 'sticker') return <StaticSticker dialogId={dialogId} m={m} />
  return <FileCard dialogId={dialogId} m={m} />
}

// A link preview card under a message.
export function LinkCard({ dialogId, m }) {
  const link = m.link
  const src = usePreview(dialogId, m.id, link.photo)
  return (
    <a className="link-card" href={link.url} target="_blank" rel="noreferrer" title={link.url} onClick={(e) => e.stopPropagation()}>
      <span className="link-card-text">
        {link.site && <span className="link-card-site mono">{link.site}</span>}
        {link.title && <span className="link-card-title">{link.title}</span>}
        {link.description && <span className="link-card-desc dim">{link.description}</span>}
      </span>
      {src && <img className="link-card-img" src={src} alt="" />}
    </a>
  )
}
