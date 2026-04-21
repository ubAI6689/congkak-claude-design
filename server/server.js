// Congkak WebSocket relay — Phase 3: rooms + presence.
// Listens on 127.0.0.1:8787. Nginx reverse-proxies wss://congkak.ubaidrac.xyz/ws → here.
//
// Messages in (C→S):
//   {type: 'ping'}                           — health check
//   {type: 'create_room'}                    — creates a new room, joins as seat 0
//   {type: 'join_room', code}                — joins existing room at first empty seat
//   {type: 'rejoin_room', code, clientId}    — reconnect to held seat (60s window)
//   {type: 'leave_room'}                     — explicit leave (frees seat immediately)
//
// Messages out (S→C):
//   {type: 'hello', connId, t}
//   {type: 'pong', t, id}
//   {type: 'room_joined', code, seat, clientId, peers}   — success (covers create+join)
//   {type: 'room_error', reason}
//   {type: 'room_update', code, peers}                   — broadcast when seat state changes
//
// peers payload: [{seat, connected, clientId?}, ...] — always length 2, null seats omitted.
// Actually: [{seat:0, connected:true|false}, {seat:1, connected:true|false}]

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const engine = require('./engine.js');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
const RECONNECT_WINDOW_MS = 60_000;
const EMPTY_ROOM_GC_MS = 5 * 60_000;

const wss = new WebSocketServer({ host: HOST, port: PORT });

// rooms: Map<code, Room>
// Room = { code, players: [Player|null, Player|null], createdAt, lastActivity }
// Player = { ws, clientId, connected, disconnectedAt }
const rooms = new Map();

function rand6() {
  // 6-char uppercase alphanumeric (avoid 0/O/I/1 for clarity)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = rand6();
    if (!rooms.has(c)) return c;
  }
  throw new Error('could not allocate room code');
}

function peerSummary(room) {
  return [0, 1].map(seat => {
    const p = room.players[seat];
    return { seat, connected: !!(p && p.connected) };
  });
}

function broadcastRoom(room, msg) {
  const payload = JSON.stringify(msg);
  for (const p of room.players) {
    if (p && p.connected && p.ws.readyState === 1 /* OPEN */) {
      try { p.ws.send(payload); } catch {}
    }
  }
}

function sendRoomUpdate(room) {
  broadcastRoom(room, { type: 'room_update', code: room.code, peers: peerSummary(room) });
}

function findRoomByWs(ws) {
  for (const room of rooms.values()) {
    for (const p of room.players) {
      if (p && p.ws === ws) return room;
    }
  }
  return null;
}

function seatOfWs(room, ws) {
  for (let i = 0; i < 2; i++) if (room.players[i] && room.players[i].ws === ws) return i;
  return -1;
}

// Game state initializer. MVP: always 7 seeds per hole, start simultaneous.
// Phase 5+ will read these from a lobby config / room option.
function freshGameState() {
  return engine.initialState(7, 'simultaneous');
}

function handleCreateRoom(ws, state) {
  if (state.roomCode) return send(ws, { type: 'room_error', reason: 'already-in-room' });
  const code = newCode();
  const clientId = crypto.randomUUID();
  const player = { ws, clientId, connected: true, disconnectedAt: 0 };
  const room = {
    code,
    players: [player, null],
    gameState: freshGameState(),
    seq: 0,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  state.roomCode = code;
  state.seat = 0;
  state.clientId = clientId;
  send(ws, { type: 'room_joined', code, seat: 0, clientId, peers: peerSummary(room), gameState: room.gameState, seq: room.seq });
  log(`room ${code} created by seat 0`);
}

function handleJoinRoom(ws, state, msg) {
  if (state.roomCode) return send(ws, { type: 'room_error', reason: 'already-in-room' });
  const code = (msg.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) return send(ws, { type: 'room_error', reason: 'no-such-room' });
  const seat = [0, 1].find(s => !room.players[s] || (!room.players[s].connected && room.players[s].disconnectedAt + RECONNECT_WINDOW_MS < Date.now()));
  if (seat === undefined) return send(ws, { type: 'room_error', reason: 'room-full' });
  const clientId = crypto.randomUUID();
  room.players[seat] = { ws, clientId, connected: true, disconnectedAt: 0 };
  room.lastActivity = Date.now();
  state.roomCode = code;
  state.seat = seat;
  state.clientId = clientId;
  send(ws, { type: 'room_joined', code, seat, clientId, peers: peerSummary(room), gameState: room.gameState, seq: room.seq });
  sendRoomUpdate(room);
  log(`room ${code} joined by seat ${seat}`);
}

function handleRejoinRoom(ws, state, msg) {
  if (state.roomCode) return send(ws, { type: 'room_error', reason: 'already-in-room' });
  const code = (msg.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) return send(ws, { type: 'room_error', reason: 'no-such-room' });
  const seat = [0, 1].find(s => room.players[s] && room.players[s].clientId === msg.clientId);
  if (seat === undefined) return send(ws, { type: 'room_error', reason: 'no-such-client' });
  const p = room.players[seat];
  if (p.connected) return send(ws, { type: 'room_error', reason: 'already-connected' });
  if (p.disconnectedAt + RECONNECT_WINDOW_MS < Date.now()) {
    return send(ws, { type: 'room_error', reason: 'reconnect-window-expired' });
  }
  p.ws = ws;
  p.connected = true;
  p.disconnectedAt = 0;
  room.lastActivity = Date.now();
  state.roomCode = code;
  state.seat = seat;
  state.clientId = msg.clientId;
  send(ws, { type: 'room_joined', code, seat, clientId: msg.clientId, peers: peerSummary(room), gameState: room.gameState, seq: room.seq });
  sendRoomUpdate(room);
  log(`room ${code} rejoined by seat ${seat}`);
}

function handlePlayMove(ws, state, msg) {
  const room = state.roomCode && rooms.get(state.roomCode);
  if (!room) return send(ws, { type: 'move_rejected', reason: 'not-in-room' });
  if (state.seat !== msg.move?.player) return send(ws, { type: 'move_rejected', reason: 'seat-mismatch' });
  // Dispatch based on current phase
  let action;
  if (room.gameState.phase === 'opener-sim') {
    action = { type: 'opener_solo', player: msg.move.player, hole: msg.move.hole };
  } else {
    action = { type: 'play_move', player: msg.move.player, hole: msg.move.hole };
  }
  const result = engine.reducer(room.gameState, action);
  if (result.events.length === 1 && result.events[0].kind === 'invalid') {
    return send(ws, { type: 'move_rejected', reason: result.events[0].reason, seq: room.seq });
  }
  room.gameState = result.state;
  room.seq += 1;
  room.lastActivity = Date.now();
  const payload = {
    type: 'move_applied',
    seq: room.seq,
    move: msg.move,
    events: result.events,
    state: result.state,
  };
  broadcastRoom(room, payload);
  log(`room ${room.code} move: seat=${msg.move.player} hole=${msg.move.hole} seq=${room.seq}`);
}

function handleLeaveRoom(ws, state) {
  const room = state.roomCode && rooms.get(state.roomCode);
  if (!room) return;
  const seat = seatOfWs(room, ws);
  if (seat >= 0) {
    room.players[seat] = null;
  }
  state.roomCode = null;
  state.seat = null;
  state.clientId = null;
  sendRoomUpdate(room);
  log(`room ${room.code} seat ${seat} left`);
  maybeGCRoom(room);
}

function onDisconnect(ws, state) {
  const room = state.roomCode && rooms.get(state.roomCode);
  if (!room) return;
  const seat = seatOfWs(room, ws);
  if (seat >= 0) {
    const p = room.players[seat];
    p.connected = false;
    p.disconnectedAt = Date.now();
  }
  sendRoomUpdate(room);
  log(`room ${room.code} seat ${seat} disconnected (60s hold)`);
}

function maybeGCRoom(room) {
  // Drop room if no active connections AND no one within reconnect window
  const now = Date.now();
  const anyLive = room.players.some(p => p && (p.connected || p.disconnectedAt + RECONNECT_WINDOW_MS >= now));
  if (!anyLive) {
    rooms.delete(room.code);
    log(`room ${room.code} GC'd`);
  }
}

// Periodic GC: sweep expired reconnect-hold seats, drop empty rooms.
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    for (let i = 0; i < 2; i++) {
      const p = room.players[i];
      if (p && !p.connected && p.disconnectedAt + RECONNECT_WINDOW_MS < now) {
        room.players[i] = null;
        sendRoomUpdate(room);
        log(`room ${room.code} seat ${i} reconnect-expired, freed`);
      }
    }
    if (now - room.lastActivity > EMPTY_ROOM_GC_MS) maybeGCRoom(room);
  }
}, 10_000).unref();

function send(ws, msg) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
}

let connId = 0;
wss.on('connection', (ws, req) => {
  const id = ++connId;
  const from = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  log(`[${id}] connect from ${from}`);

  // Per-connection state. Tracks which room/seat this socket is currently owned by.
  const state = { connId: id, roomCode: null, seat: null, clientId: null };

  send(ws, { type: 'hello', connId: id, t: Date.now() });

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return send(ws, { type: 'error', reason: 'bad-json' }); }
    switch (msg.type) {
      case 'ping':         return send(ws, { type: 'pong', t: Date.now(), id });
      case 'create_room':  return handleCreateRoom(ws, state);
      case 'join_room':    return handleJoinRoom(ws, state, msg);
      case 'rejoin_room':  return handleRejoinRoom(ws, state, msg);
      case 'leave_room':   return handleLeaveRoom(ws, state);
      case 'play_move':    return handlePlayMove(ws, state, msg);
      default:             return send(ws, { type: 'echo', payload: msg });
    }
  });

  ws.on('close', (code) => {
    log(`[${id}] close code=${code}`);
    onDisconnect(ws, state);
  });

  ws.on('error', (err) => log(`[${id}] error ${err.message}`));
});

wss.on('listening', () => log(`listening on ws://${HOST}:${PORT}`));

function log(msg) { process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`); }

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`got ${sig}, shutting down`);
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2000).unref();
  });
}
