import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // index: the app. bridge: the MCP server Codex or Claude starts (runs as plain Node).
        input: {
          index: resolve('src/main/index.js'),
          bridge: resolve('src/main/bridge.js')
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        // index: the IV Chat window. panel: the website panels.
        input: {
          index: resolve('src/preload/index.js'),
          panel: resolve('src/preload/panel.js')
        }
      }
    }
  },
  renderer: {
    plugins: [react()]
  }
})
