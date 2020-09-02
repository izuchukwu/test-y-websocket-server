import WebSocket from 'ws'
import * as http from 'http'
import * as net from 'net'

import {initWebSocketConnection} from './utils.js'

const port = process.env.PORT || 5000

// Types
type Request = http.IncomingMessage
type Response = http.ServerResponse
type Socket = net.Socket

// Create WebSocket server and Node server
const webSocketServer = new WebSocket.Server({noServer: true})
const server = http.createServer((_req: Request, res: Response) => {
    res.writeHead(200, {'Content-Type': 'text/plain'})
    res.end('ok!')
})

// Act on WebSocket connect
webSocketServer.on('connection', initWebSocketConnection)

// Respond to client-side upgrade-to-WebSocket requests
server.on('upgrade', (req: Request, socket: Socket, head) => {
    // Note: This is where auth can be checked based on the req headers
    // See github.com/websockets/ws#client-authentication for how

    webSocketServer.handleUpgrade(req, socket, head, (webSocket: WebSocket) => {
        webSocketServer.emit('connection', webSocket, req)
    })
})

// Listen
server.listen(port)
console.log(`Listening on ${port} ✨`)
