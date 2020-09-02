import Y from 'yjs';
import syncProtocol from 'y-protocols/dist/sync.cjs';
import awarenessProtocol from 'y-protocols/dist/awareness.cjs';
import encoding from 'lib0/encoding.js';
import decoding from 'lib0/decoding.js';
import mutex from 'lib0/mutex.js';
import map from 'lib0/map.js';
// Y.Doc In-Mem Storage
const docs = new Map();
// Disable Y.Doc GC when taking Heap Snapshots in Node
const snapshotsEnabled = process.env.GC !== 'false' && process.env.GC !== '0';
// Close connections after 30s ping timeout
const pingTimeout = 30000;
// Enums
var SocketState;
(function (SocketState) {
    SocketState[SocketState["SocketStateConnecting"] = 0] = "SocketStateConnecting";
    SocketState[SocketState["SocketStateOpen"] = 1] = "SocketStateOpen";
    SocketState[SocketState["SocketStateClosing"] = 2] = "SocketStateClosing";
    SocketState[SocketState["SocketStateClosed"] = 3] = "SocketStateClosed";
})(SocketState || (SocketState = {}));
var MessageType;
(function (MessageType) {
    MessageType[MessageType["MessageTypeSync"] = 0] = "MessageTypeSync";
    MessageType[MessageType["MessageTypeAwareness"] = 1] = "MessageTypeAwareness";
    MessageType[MessageType["MessageTypeAuthentication"] = 2] = "MessageTypeAuthentication";
})(MessageType || (MessageType = {}));
// Update Handler
const docDidUpdate = (update, origin, doc) => {
    // console.log('doc-on-update')
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.MessageTypeSync);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    // console.log(this.connections)
    doc.connections.forEach((_, connection) => sendMessage(doc, connection, message));
};
// Y.Doc with Multiplayer state
class MultiplayerDoc extends Y.Doc {
    constructor(name) {
        super();
        this.name = name;
        // Set up Y.Doc
        this.gc = snapshotsEnabled;
        // Set up mutex
        this.mutex = mutex.createMutex();
        // Map of Connections to Set of client identifiers
        this.connections = new Map();
        // Initialize Awareness
        this.awareness = new awarenessProtocol.Awareness(this);
        // Mark this "client" as offline
        this.awareness.setLocalState(null);
        // Update state and broadcast changes after awareness updates
        this.awareness.on('update', ({ added, updated, removed }, connection) => {
            // List all modified clients
            const modifiedClients = added.concat(updated, removed);
            if (connection !== null) {
                // If the connection exists, get all client identifiers under it
                const clientIdentifiersForConnection = this.connections.get(connection);
                if (clientIdentifiersForConnection !== undefined) {
                    // Add new clients and remove removed ones
                    added.forEach((clientIdentifier) => {
                        clientIdentifiersForConnection.add(clientIdentifier);
                    });
                    removed.forEach((clientIdentifier) => {
                        clientIdentifiersForConnection.delete(clientIdentifier);
                    });
                }
            }
            // Broadcast the awareness udpate
            // -> Encode the update
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MessageType.MessageTypeAwareness);
            encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, modifiedClients));
            // -> Write the update to a buffer and send it out to our connections
            const message = encoding.toUint8Array(encoder);
            this.connections.forEach((_, connection) => sendMessage(this, connection, message));
        });
        this.on('update', docDidUpdate);
    }
}
// Receive Messages
const receiveMessage = (connection, doc, message) => {
    // console.log('message received')
    // Create encoder and decoder
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    // Get message type
    const messageType = decoding.readVarUint(decoder);
    // Process Sync messages
    if (messageType === MessageType.MessageTypeSync) {
        encoding.writeVarUint(encoder, MessageType.MessageTypeSync);
        // Apply sync update
        syncProtocol.readSyncMessage(decoder, encoder, doc, null);
        // Return sync message
        if (encoding.length(encoder) > 1) {
            sendMessage(doc, connection, encoding.toUint8Array(encoder));
        }
    }
    // Process Awareness messages
    if (messageType === MessageType.MessageTypeAwareness) {
        // Apply awareness update
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), connection);
    }
};
// Close Connection
const closeConnection = (doc, connection) => {
    // Make sure the doc is tied to this connection
    console.log('Connection Close Requested');
    if (doc.connections.has(connection)) {
        console.log('Closing Connection');
        // Get all clients represented by this connection
        const clientIdentifiers = doc.connections.get(connection);
        // Remove the connection from the doc
        doc.connections.delete(connection);
        // Remove the all client awareness states tied to this connection from the doc
        awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(clientIdentifiers), null);
        // Check if the document has any remaining connections
        // Note: Only perform this function after adding persistence
        // Otherwise, documents will be continually cleared
        /*if (doc.connections.size === 0) {
            // Note: This is where the doc should be written to Postgres or other persistent storage
            // After persisting, call doc.destroy()
            // See github.com/yjs/y-websocket/blob/master/bin/utils.js#L171

            // If the document has no remaining connections, remove the doc from in-mem storage
            docs.delete(doc.name)
        }*/
    }
    else {
        console.log('Connection to close not in doc');
    }
    // Close the WebSocket
    connection.close();
};
// Send Message
const sendMessage = (doc, connection, message) => {
    // Check the connection state
    if (connection.readyState !== SocketState.SocketStateConnecting && connection.readyState !== SocketState.SocketStateOpen) {
        // If the connection is not connecting or connected, close it
        console.log('Closing: [Send Message] Bad Connection State. Requesting close.');
        closeConnection(doc, connection);
    }
    // Send the message
    try {
        // Send, and if an error occurs, close the connection
        connection.send(message, (error) => {
            console.log('Closing: [Send Message] Error Returned');
            error !== null && closeConnection(doc, connection);
        });
    }
    catch (e) {
        // If an error is thrown, close the connection
        console.log('Closing: [Send Message] Error Thrown');
        closeConnection(doc, connection);
    }
};
export const initWebSocketConnection = (connection, req) => {
    console.log('Opening Connection');
    // Get the room name from the req's URL parameters
    const roomName = req.url.slice(1).split('?')[0];
    // Set the WebSocket type to arraybuffer
    // See developer.mozilla.org/en-US/docs/Web/API/WebSocket/binaryType
    connection.binaryType = 'arraybuffer';
    // Get the multiplayer doc for this connection by room name
    const doc = map.setIfUndefined(docs, roomName, () => {
        console.log('creating new doc');
        // If a multiplayer doc for this room doesn't exist, create it
        const doc = new MultiplayerDoc(roomName);
        docs.set(roomName, doc);
        return doc;
    });
    // Get the multiplayer doc for this connection by room name
    // let doc: MultiplayerDoc
    // if (docs.has(roomName)) {
    //     console.log(`doc found for room '${roomName}'`)
    //     doc = docs.get(roomName)
    //     console.log('→ doc retreived')
    // } else {
    //     console.log(`no doc found for room '${roomName}'`)
    //     doc = new MultiplayerDoc(roomName)
    //     docs.set(roomName, doc)
    //     console.log('doc created')
    // }
    // Add connection to doc
    doc.connections.set(connection, new Set());
    // Listen to messages from this connection
    connection.on('message', (message) => receiveMessage(connection, doc, new Uint8Array(message)));
    // Clean up if the connection closes
    connection.on('close', () => {
        console.log('Closing: [initWebSocketConnection] ws-onclose');
        closeConnection(doc, connection);
    });
    // Ping-pong to keep an eye on connection health
    // We send pings every 30s and expect a pong back
    // If we don't receive the pong, close the connection
    let pongReceived = true;
    const pingInterval = setInterval(() => {
        // If a pong has not been received within 30s, close the connection
        if (!pongReceived) {
            console.log('did not receive pong, closing');
            if (doc.connections.has(connection)) {
                console.log('Closing: [initWebSocketConnection] No pong');
                closeConnection(doc, connection);
            }
            clearInterval(pingInterval);
        }
        else if (doc.connections.has(connection)) {
            // We received a pong
            // Reset the pong flag, and re-send the ping
            pongReceived = false;
            try {
                console.log('ping');
                connection.ping();
            }
            catch (e) {
                // If we fail to send a ping, close the connection
                console.log('could not ping, closing');
                console.log('Closing: [initWebSocketConnection] Could not ping');
                closeConnection(doc, connection);
            }
        }
    }, pingTimeout);
    // If we receive a pong, update the pong flag
    connection.on('pong', () => {
        console.log('pong');
        pongReceived = true;
    });
    // Send the first Sync step
    // -> Create the sync message
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.MessageTypeSync);
    // -> Write the step and send it
    syncProtocol.writeSyncStep1(encoder, doc);
    sendMessage(doc, connection, encoding.toUint8Array(encoder));
    // If there are awareness listeners, broadcast the new connection's awareness state
    const awarenessStates = doc.awareness.getStates();
    if (awarenessStates.size > 0) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MessageType.MessageTypeAwareness);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys())));
        sendMessage(doc, connection, encoding.toUint8Array(encoder));
    }
};
