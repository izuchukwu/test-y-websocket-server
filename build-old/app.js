import WebSocket from 'ws';
import http from 'http';
import { initWebSocketConnection } from './utils.js';
const port = process.env.PORT || 5000;
// Create WebSocket server and Node server
const webSocketServer = new WebSocket.Server({ noServer: true });
const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok!');
});
// Act on WebSocket connect
webSocketServer.on('connection', initWebSocketConnection);
// Respond to client-side upgrade-to-WebSocket requests
server.on('upgrade', (req, socket, head) => {
    // Note: This is where auth can be checked based on the req headers
    // See github.com/websockets/ws#client-authentication for how
    webSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, req);
    });
});
// Listen
server.listen(port);
console.log(`Listening on ${port} ✨`);
