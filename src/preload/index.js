import { contextBridge, ipcRenderer, webUtils } from 'electron'

const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('iv', {
  platform: process.platform,
  services: {
    list: () => ipcRenderer.invoke('services:list'),
    onChange: on('services:changed'),
    reload: (id) => ipcRenderer.invoke('panel:reload', id),
    signOut: (id) => ipcRenderer.invoke('panel:signOut', id)
  },
  chats: {
    get: () => ipcRenderer.invoke('chats:get'),
    onChange: on('chats:changed')
  },
  telegram: {
    state: () => ipcRenderer.invoke('telegram:state'),
    onState: on('telegram:state'),
    dialogs: () => ipcRenderer.invoke('telegram:dialogs'),
    onDialogs: on('telegram:dialogs'),
    onMessage: on('telegram:message'),
    onOpen: on('telegram:open'),
    onTyping: on('telegram:typing'),
    onStatus: on('telegram:status'),
    onFolders: on('telegram:folders'),
    saveKeys: (apiId, apiHash) => ipcRenderer.invoke('telegram:saveKeys', apiId, apiHash),
    signIn: () => ipcRenderer.invoke('telegram:signIn'),
    password: (pw) => ipcRenderer.invoke('telegram:password', pw),
    cancel: () => ipcRenderer.invoke('telegram:cancel'),
    signOut: () => ipcRenderer.invoke('telegram:signOut'),
    messages: (id, opts) => ipcRenderer.invoke('telegram:messages', id, opts),
    markRead: (id) => ipcRenderer.invoke('telegram:markRead', id),
    refresh: () => ipcRenderer.invoke('telegram:refresh'),
    send: (id, text, opts) => ipcRenderer.invoke('telegram:send', id, text, opts),
    edit: (id, msgId, text) => ipcRenderer.invoke('telegram:edit', id, msgId, text),
    remove: (id, msgIds, everyone) => ipcRenderer.invoke('telegram:delete', id, msgIds, everyone),
    forward: (fromId, msgIds, toId) => ipcRenderer.invoke('telegram:forward', fromId, msgIds, toId),
    pin: (id, msgId, unpin) => ipcRenderer.invoke('telegram:pin', id, msgId, unpin),
    chatInfo: (id) => ipcRenderer.invoke('telegram:chatInfo', id),
    pinned: (id) => ipcRenderer.invoke('telegram:pinned', id),
    avatar: (id) => ipcRenderer.invoke('telegram:avatar', id),
    folders: () => ipcRenderer.invoke('telegram:folders'),
    findChats: (query) => ipcRenderer.invoke('telegram:findChats', query),
    openFound: (id) => ipcRenderer.invoke('telegram:openFound', id),
    details: (id) => ipcRenderer.invoke('telegram:details', id),
    shared: (id, kind, beforeId) => ipcRenderer.invoke('telegram:shared', id, kind, beforeId),
    pinChat: (id, pinned) => ipcRenderer.invoke('telegram:pinChat', id, pinned),
    mute: (id, until) => ipcRenderer.invoke('telegram:mute', id, until),
    archive: (id, archived) => ipcRenderer.invoke('telegram:archive', id, archived),
    markUnread: (id, unread) => ipcRenderer.invoke('telegram:markUnread', id, unread),
    search: (id, query) => ipcRenderer.invoke('telegram:search', id, query),
    mediaUrl: (id, msgId) => ipcRenderer.invoke('telegram:mediaUrl', id, msgId),
    preview: (id, msgId) => ipcRenderer.invoke('telegram:preview', id, msgId),
    audio: (id, msgId) => ipcRenderer.invoke('telegram:audio', id, msgId),
    react: (id, msgId, emoji) => ipcRenderer.invoke('telegram:react', id, msgId, emoji),
    save: (id, msgId) => ipcRenderer.invoke('telegram:save', id, msgId),
    pickFile: () => ipcRenderer.invoke('telegram:pickFile'),
    sendVoice: (id, bytes, waveform, opts) => ipcRenderer.invoke('telegram:sendVoice', id, bytes, waveform, opts),
    stagePath: (filePath) => ipcRenderer.invoke('telegram:stagePath', filePath),
    stageBytes: (name, bytes) => ipcRenderer.invoke('telegram:stageBytes', name, bytes),
    // A dropped file's place on disk (Electron no longer puts it on the File object).
    pathFor: (file) => webUtils.getPathForFile(file),
    sendFile: (id, token, caption, opts) => ipcRenderer.invoke('telegram:sendFile', id, token, caption, opts)
  },
  draft: {
    engines: () => ipcRenderer.invoke('draft:engines'),
    telegram: (id, hint) => ipcRenderer.invoke('draft:telegram', id, hint),
    panel: (service, hint) => ipcRenderer.invoke('draft:panel', service, hint),
    cancel: () => ipcRenderer.invoke('draft:cancel')
  },
  ai: {
    get: () => ipcRenderer.invoke('ai:get'),
    setChat: (key, on) => ipcRenderer.invoke('ai:setChat', key, on),
    drafts: () => ipcRenderer.invoke('ai:drafts'),
    clearDraft: (key) => ipcRenderer.invoke('ai:clearDraft', key),
    onDraft: on('ai:draft'),
    onActivity: on('ai:activity'),
    connect: (target) => ipcRenderer.invoke('ai:connect', target),
    disconnect: (target) => ipcRenderer.invoke('ai:disconnect', target)
  },
  view: {
    set: (view) => ipcRenderer.send('view:set', view),
    setPanelBounds: (rect) => ipcRenderer.send('panel:bounds', rect),
    onSelect: on('view:select')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },
  app: {
    refreshAll: () => ipcRenderer.invoke('app:refreshAll'),
    copy: (text) => ipcRenderer.invoke('app:copy', text),
    update: () => ipcRenderer.invoke('update:state'),
    checkForUpdate: () => ipcRenderer.invoke('update:check'),
    installUpdate: () => ipcRenderer.invoke('update:install'),
    onUpdate: on('update:changed'),
    openLicenses: () => ipcRenderer.invoke('about:licenses')
  }
})
