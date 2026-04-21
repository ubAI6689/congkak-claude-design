// Congkak WebSocket relay — Phase 2 stub.
// Listens on 127.0.0.1:8787. Nginx reverse-proxies wss://congkak.ubaidrac.xyz/ws → here.
// Responds to {type:'ping'} with {type:'pong', t, id}. Any other message echoes back under
// {type:'echo', payload} for debugging. Phase 3+ will add rooms and the reducer.

const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';

const wss = new WebSocketServer({ host: HOST, port: PORT });

let connId = 0;
wss.on('connection', (ws, req) => {
  const id = ++connId;
  const from = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  log(`[${id}] connect from ${from}`);

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch (e) {
      return ws.send(JSON.stringify({ type: 'error', reason: 'bad-json' }));
    }
    if (msg && msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now(), id }));
      return;
    }
    // Fallback: echo
    ws.send(JSON.stringify({ type: 'echo', payload: msg }));
  });

  ws.on('close', (code) => {
    log(`[${id}] close code=${code}`);
  });

  ws.on('error', (err) => {
    log(`[${id}] error ${err.message}`);
  });

  // Greeting so clients can confirm the handshake landed.
  ws.send(JSON.stringify({ type: 'hello', id, t: Date.now() }));
});

wss.on('listening', () => {
  log(`listening on ws://${HOST}:${PORT}`);
});

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// Clean shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`got ${sig}, shutting down`);
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2000).unref();
  });
}
