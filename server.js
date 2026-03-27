const WebSocket = require('ws');
const express   = require('express');
const http      = require('http');
const path      = require('path');
const crypto    = require('crypto');

const app = express();
app.use(express.static(path.join(__dirname, 'WebGLBuild')));
app.use('/', express.static(__dirname)); // Host files in the root folder too

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const SERVER_START_TIME = Date.now().toString();

const MAX_SENDERS = 3;

// Inactivity thresholds (ms)
const INACTIVE_WARN_MS       = 60 * 1000;  // 1 minute  → show warning panel
const INACTIVE_DISCONNECT_MS = 120 * 1000; // 2 minutes → force disconnect

let userCounter = 1;
const sessions    = {};
const userDesigns = {};

// Reserved slots — incremented when a sender is assigned a userId,
// decremented ONLY when the inactivity timer fully expires and cleans up.
// This means a closed-tab user still holds their slot until their 2-min timer fires.
const reservedSlots = new Set(); // Set of userIds currently holding a slot

// { [userId]: { warnTimer, disconnectTimer } }
const inactivityTimers = {};

// ─── Inactivity helpers ───────────────────────────────────────────────────────

function clearInactivityTimers(userId) {
    if (inactivityTimers[userId]) {
        clearTimeout(inactivityTimers[userId].warnTimer);
        clearTimeout(inactivityTimers[userId].disconnectTimer);
        delete inactivityTimers[userId];
    }
}

function resetInactivityTimer(userId) {
    clearInactivityTimers(userId);

    const warnTimer = setTimeout(() => {
        console.log(`User ${userId} inactive for 1 min — sending warning`);
        sendToUser(userId, "INACTIVE_WARNING");
    }, INACTIVE_WARN_MS);

    const disconnectTimer = setTimeout(() => {
        console.log(`User ${userId} inactive for 2 min — slot released`);
        // Send to socket if still open (forces Unity auto-reload)
        sendToUser(userId, "INACTIVE_DISCONNECT");
        // Close socket if still open
        wss.clients.forEach(client => {
            if (client.role === "sender" && client.userId === userId && client.readyState === WebSocket.OPEN) {
                client.close();
            }
        });
        // Invalidate session token
        Object.keys(sessions).forEach(token => {
            if (sessions[token].userId === userId) {
                delete sessions[token];
                console.log(`Session for User ${userId} removed`);
            }
        });
        delete userDesigns[userId];
        // Release the reserved slot — only happens here
        reservedSlots.delete(userId);
        console.log(`Slot released for User ${userId} — reserved: ${reservedSlots.size}/${MAX_SENDERS}`);
        clearInactivityTimers(userId);
    }, INACTIVE_DISCONNECT_MS);

    inactivityTimers[userId] = { warnTimer, disconnectTimer };
}

// ─── WebSocket connections ────────────────────────────────────────────────────

wss.on('connection', ws => {
    ws.role   = "unknown";
    ws.userId = null;

    console.log("New client connected");
    ws.send("SERVER_INSTANCE:" + SERVER_START_TIME);

    ws.on('message', message => {
        const text = message.toString();

        // ---- HEARTBEAT ----
        if (text === "HEARTBEAT") {
            if (ws.role === "sender" && ws.userId !== null) {
                resetInactivityTimer(ws.userId);
            }
            return;
        }

        // ---- SESSION RESTORE ----
        if (text.startsWith("SESSION:")) {
            const token = text.split(":")[1].trim();
            if (sessions[token]) {
                ws.userId = sessions[token].userId;
                ws.role   = sessions[token].role;
                console.log(`Session restored → User ${ws.userId} (${ws.role})`);
                ws.send(`SESSION_OK:${ws.userId}`);
                if (ws.role === "sender") {
                    // Slot is already reserved — just restart the timer
                    resetInactivityTimer(ws.userId);
                    const gameOnline = [...wss.clients].some(c => c.role === "receiver" && c.readyState === WebSocket.OPEN);
                    if (gameOnline) ws.send("GAME_CONNECTED");
                } else if (ws.role === "gyro") {
                    broadcast("receiver", `GYRO_CONNECTED:${ws.userId}`);
                    if (userDesigns[ws.userId])
                        broadcast("receiver", `WAU_DESIGN:${ws.userId},${userDesigns[ws.userId]}`);
                }
            } else {
                console.log("Session expired or not found");
                ws.send("SESSION_EXPIRED");
            }
            return;
        }

        // ---- NEW SESSION ----
        if (text.startsWith("NEW_SESSION:")) {
            const parts = text.split(":");
            const role  = parts[1].trim();
            const token = crypto.randomBytes(16).toString('hex');

            if (role === "sender") {
                // Check reserved slots — includes offline users still within their 2-min window
                if (reservedSlots.size >= MAX_SENDERS) {
                    console.log(`Server full (${reservedSlots.size}/${MAX_SENDERS} slots reserved) — rejecting new sender`);
                    ws.send("SERVER_FULL");
                    return;
                }

                ws.userId = userCounter++;
                ws.role   = "sender";
                sessions[token] = { userId: ws.userId, role: "sender" };
                reservedSlots.add(ws.userId); // Reserve the slot immediately
                console.log(`New sender → User ${ws.userId} | reserved: ${reservedSlots.size}/${MAX_SENDERS}`);
                ws.send(`YOUR_ID:${ws.userId}`);
                ws.send(`SESSION_TOKEN:${token}`);
                resetInactivityTimer(ws.userId);
                const gameOnline = [...wss.clients].some(c => c.role === "receiver" && c.readyState === WebSocket.OPEN);
                if (gameOnline) ws.send("GAME_CONNECTED");

            } else if (role === "gyro") {
                const linkedUserId = parts[2] ? parseInt(parts[2].trim()) : null;
                if (linkedUserId === null) {
                    console.warn("Gyro connected without userId — rejecting");
                    ws.send("ERROR:no_userid");
                    return;
                }
                ws.userId = linkedUserId;
                ws.role   = "gyro";
                sessions[token] = { userId: ws.userId, role: "gyro" };
                console.log(`New gyro → linked to User ${ws.userId}`);
                ws.send(`SESSION_TOKEN:${token}`);
                broadcast("receiver", `GYRO_CONNECTED:${ws.userId}`);
                if (userDesigns[ws.userId])
                    broadcast("receiver", `WAU_DESIGN:${ws.userId},${userDesigns[ws.userId]}`);
            }
            return;
        }

        // ---- LEGACY ROLE FALLBACK ----
        if (text.startsWith("ROLE:")) {
            const role = text.split(":")[1].trim();
            ws.role = role;
            if (role === "sender") {
                if (reservedSlots.size >= MAX_SENDERS) {
                    ws.send("SERVER_FULL");
                    return;
                }
                ws.userId = userCounter++;
                reservedSlots.add(ws.userId);
                console.log(`Sender connected → User ${ws.userId} | reserved: ${reservedSlots.size}/${MAX_SENDERS}`);
                ws.send(`YOUR_ID:${ws.userId}`);
                resetInactivityTimer(ws.userId);
                const gameOnline = [...wss.clients].some(c => c.role === "receiver" && c.readyState === WebSocket.OPEN);
                if (gameOnline) ws.send("GAME_CONNECTED");
            } else if (role === "gyro") {
                let linkedUserId = null;
                wss.clients.forEach(client => {
                    if (client.role === "sender" && client.userId !== null)
                        linkedUserId = client.userId;
                });
                ws.userId = linkedUserId;
                console.log(`Gyro connected → linked to User ${ws.userId}`);
                broadcast("receiver", `GYRO_CONNECTED:${ws.userId}`);
                if (userDesigns[ws.userId])
                    broadcast("receiver", `WAU_DESIGN:${ws.userId},${userDesigns[ws.userId]}`);
            } else if (role === "receiver") {
                console.log("Receiver connected");
                broadcast("sender", "GAME_CONNECTED");
            }
            return;
        }

        // ---- WAU DESIGN ----
        if (ws.role === "sender" && text.startsWith("WAU_DESIGN:")) {
            const pattern = text.substring(11).trim();
            userDesigns[ws.userId] = pattern;
            console.log(`User ${ws.userId} chose design: ${pattern}`);
            broadcast("receiver", `WAU_DESIGN:${ws.userId},${pattern}`);
            resetInactivityTimer(ws.userId);
            return;
        }

        // ---- GYRO ----
        if (ws.role === "gyro" && text.startsWith("GYRO_ORIENT:")) {
            const values = text.substring(12);
            broadcast("receiver", `GYRO_ORIENT:${ws.userId},${values}`);
            resetInactivityTimer(ws.userId);  // gyro movement = user is active
            return;
        }

        // ---- BIRD KILL (receiver → matching sender only) ----
        if (ws.role === "receiver" && text.startsWith("BIRD_KILL:")) {
            const body  = text.substring(10);
            const parts = body.split(",");
            if (parts.length === 2) {
                const targetUserId = parseInt(parts[0].trim());
                const count        = parseInt(parts[1].trim());
                console.log(`Bird kill update → User ${targetUserId}: ${count}`);
                sendToUser(targetUserId, `BIRD_KILL:${count}`);
            }
            return;
        }

        // ---- BUTTONS ----
        if (ws.role === "sender" && ws.userId !== null) {
            broadcast("receiver", `BUTTON:User ${ws.userId} pressed ${text}`);
            resetInactivityTimer(ws.userId);
        }
    });

    ws.on('close', () => {
        if (ws.role === "sender") {
            // Slot stays reserved — timer keeps running in background.
            // If they reopen and SESSION: succeeds, timer resets.
            // If 2-min timer fires, slot is released via reservedSlots.delete().
            console.log(`Sender User ${ws.userId} disconnected — slot still reserved (${reservedSlots.size}/${MAX_SENDERS})`);
        } else if (ws.role === "gyro") {
            console.log(`Gyro User ${ws.userId} disconnected`);
            broadcast("receiver", `GYRO_DISCONNECTED:${ws.userId}`);
        } else if (ws.role === "receiver") {
            console.log("Receiver disconnected");
            broadcast("sender", "GAME_DISCONNECTED");
        } else {
            console.log("Unknown client disconnected");
        }
    });

    ws.on('error', (err) => console.error("WS Error:", err.message));
});

function broadcast(targetRole, message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.role === targetRole)
            client.send(message);
    });
}

function sendToUser(userId, message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.role === "sender" && client.userId === userId)
            client.send(message);
    });
}

const PORT = process.env.PORT || 7070;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));