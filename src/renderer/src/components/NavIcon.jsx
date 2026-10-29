// Small line-drawn marks for each place in the sidebar, used when it's collapsed to round buttons.
// Drawn in IV's own style (one stroke colour), with each service's colour only as a faint ring around it.
const PATHS = {
  updates: (
    <>
      <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  telegram: (
    <>
      <path d="M21 4 3 11l6 2.2L18 7l-7 7.3.4 5.7 3.2-4.3L19 19Z" />
    </>
  ),
  whatsapp: (
    <>
      <path d="M4 20l1.3-4A8 8 0 1 1 8 18.7Z" />
      <path d="M9.5 8.5c.3 2.6 2.4 5.2 5.4 6l1.2-1.4-1.9-1-0.9.8a4.6 4.6 0 0 1-2.2-2.2l.8-.9-1-1.9Z" />
    </>
  ),
  messenger: (
    <>
      <path d="M12 3.5c-4.8 0-8.5 3.4-8.5 7.9 0 2.5 1.1 4.6 3 6v3.1l2.9-1.6c.8.2 1.7.4 2.6.4 4.8 0 8.5-3.4 8.5-7.9S16.8 3.5 12 3.5Z" />
      <path d="m7.5 13.5 3-3.2 2.2 2 3.8-2.8-3 3.3-2.2-2Z" />
    </>
  ),
  instagram: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4.5" />
      <circle cx="12" cy="12" r="3.6" />
      <circle cx="16.9" cy="7.1" r="0.6" />
    </>
  ),
  linkedin: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M8.5 10.5v5.5M8.5 7.6v.1M11.8 16v-5.5M11.8 13c0-1.6 1-2.6 2.2-2.6s2 .8 2 2.4V16" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
    </>
  )
}

// The services' own colours, for the faint ring.
export const BRAND = {
  updates: '#f19dac',
  telegram: '#2aabee',
  whatsapp: '#25d366',
  messenger: '#a334fa',
  instagram: '#e1306c',
  linkedin: '#0a66c2',
  settings: '#f1ede5'
}

export default function NavIcon({ id, size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[id]}
    </svg>
  )
}
