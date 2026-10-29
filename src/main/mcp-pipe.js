// IV Chat's side of the MCP link: a named pipe on this computer only. Each line in is
// {"id","token","tool","args"}; each line out is {"id","result"}. Wrong token: the connection is dropped.
import net from 'node:net'
import { ensureToken, pipePath, sameToken } from './mcp-common'

const MAX_LINE = 64 * 1024

export function startMcpPipe(profileDir, call) {
  const token = ensureToken(profileDir)
  const server = net.createServer((socket) => {
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('data', async (chunk) => {
      buf += chunk
      if (buf.length > MAX_LINE) return socket.destroy()
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let req
        try {
          req = JSON.parse(line)
        } catch {
          return socket.destroy()
        }
        if (!sameToken(req.token, token)) return socket.destroy()
        const result = await call(String(req.tool), req.args && typeof req.args === 'object' ? req.args : {})
        if (!socket.destroyed) socket.write(JSON.stringify({ id: req.id, result }) + '\n')
      }
    })
    socket.on('error', () => {})
  })
  server.on('error', () => {})
  server.listen(pipePath(profileDir))
  return server
}
