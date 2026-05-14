const logger = require('./logger');

let wss = null;
let WebSocketServer = null;

function init(httpServer) {
  try {
    const ws = require('ws');
    WebSocketServer = ws.WebSocketServer || ws.Server;
    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws) => {
      logger.log('[WS] Client connected');
      try { ws.send(JSON.stringify({ type: 'connected', count: getClientCount() })); } catch { /* ignore */ }
      ws.on('close', () => { logger.log('[WS] Client disconnected'); });
    });

    logger.log('[WS] WebSocket server initialized');
  } catch (err) {
    logger.error('[WS] Failed to initialize WebSocket server:', err.message);
    wss = null;
  }
}

function broadcast(data) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      try { client.send(msg); } catch { /* ignore */ }
    }
  }
}

function getClientCount() {
  return wss ? wss.clients.size : 0;
}

function close() {
  if (wss) {
    try { wss.close(); } catch { /* ignore */ }
    wss = null;
  }
}

module.exports = { init, broadcast, getClientCount, close };
