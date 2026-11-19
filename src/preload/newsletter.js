// The IV Newsletter signup, preload side (source of truth: IVAI docs/newsletter/apps/newsletter-preload.js).
// contextBridge.exposeInMainWorld('<app>', { ..., newsletter: newsletterBridge(ipcRenderer) })
export const newsletterBridge = (ipcRenderer) => ({
  status: () => ipcRenderer.invoke('newsletter:status'),
  join: (input) => ipcRenderer.invoke('newsletter:join', input),
  closeCard: () => ipcRenderer.invoke('newsletter:close-card'),
  openPage: () => ipcRenderer.invoke('newsletter:open-page')
})
