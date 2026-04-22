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
    pendingNewRoundBy: null,  // null | 0 | 1 — seat that has requested a rematch
    openerPicks: [null, null], // lockstep: per-player committed pick for current opener round
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

function handleRequestNewRound(ws, state) {
  const room = state.roomCode && rooms.get(state.roomCode);
  if (!room) return;
  const seat = state.seat;
  if (seat == null) return;
  if (room.pendingNewRoundBy === seat) return; // duplicate request — ignore
  if (room.pendingNewRoundBy != null && room.pendingNewRoundBy !== seat) {
    // Mutual agreement — both requested
    return applyNewRound(room);
  }
  // First request: mark pending, notify both sides
  room.pendingNewRoundBy = seat;
  broadcastRoom(room, { type: 'new_round_requested', by: seat });
  log(`room ${room.code} new round requested by seat ${seat}`);
}

function handleRespondNewRound(ws, state, msg) {
  const room = state.roomCode && rooms.get(state.roomCode);
  if (!room) return;
  if (room.pendingNewRoundBy == null) return;
  const seat = state.seat;
  if (seat == null) return;
  // Requester can cancel their own pending request (treat as decline).
  if (seat === room.pendingNewRoundBy) {
    if (msg.accept) return; // can't self-accept
    room.pendingNewRoundBy = null;
    broadcastRoom(room, { type: 'new_round_declined', by: seat });
    log(`room ${room.code} new round cancelled by requester seat ${seat}`);
    return;
  }
  if (msg.accept) {
    return applyNewRound(room);
  }
  room.pendingNewRoundBy = null;
  broadcastRoom(room, { type: 'new_round_declined', by: seat });
  log(`room ${room.code} new round declined by seat ${seat}`);
}

function applyNewRound(room) {
  room.gameState = freshGameState();
  room.seq += 1;
  room.pendingNewRoundBy = null;
  room.openerPicks = [null, null];
  room.lastActivity = Date.now();
  broadcastRoom(room, {
    type: 'new_round_applied',
    gameState: room.gameState,
    seq: room.seq,
  });
  log(`room ${room.code} new round applied (seq=${room.seq})`);
}

function handlePlayMove(ws, state, msg) {
  const room = state.roomCode && rooms.get(state.roomCode);
  if (!room) return send(ws, { type: 'move_rejected', reason: 'not-in-room' });
  if (state.seat !== msg.move?.player) return send(ws, { type: 'move_rejected', reason: 'seat-mismatch' });
  // MP opener-sim uses commit_opener_pick (lockstep rounds), not play_move.
  if (room.gameState.phase === 'opener-sim') {
    return send(ws, { type: 'move_rejected', reason: 'use-commit-opener-pick' });
  }
  const action = { type: 'play_move', player: msg.move.player, hole: msg.move.hole };
  const result = engine.reducer(room.gameState, action);
  if (result.events.length === 1 && result.events[0].kind === 'invalid') {
    return send(ws, { type: 'move_rejected', reason: result.events[0].reason, seq: room.seq });
  }
  room.gameState = result.state;
  room.seq += 1;
  room.lastActivity = Date.now();
  broadcastRoom(room, {
    type: 'move_applied',
    seq: room.seq,
    move: msg.move,
    events: result.events,
    state: result.state,
  });
  log(`room ${room.code} move: seat=${msg.move.player} hole=${msg.move.hole} seq=${room.seq}`);
}

function handleCommitOpenerPick(ws, state, msg) {
  const room = state.roomCode && rooms.get(state.roomCode);
  if (!room) return;
  if (room.gameState.phase !== 'opener-sim') return send(ws, { type: 'move_rejected', reason: 'not-opener-phase' });
  const seat = state.seat;
  if (seat !== msg.player) return send(ws, { type: 'move_rejected', reason: 'seat-mismatch' });
  if (room.gameState.openerDone[seat]) return send(ws, { type: 'move_rejected', reason: 'already-done' });
  const hole = msg.hole;
  // Validate hole
  if (hole < 0 || hole > 13) return send(ws, { type: 'move_rejected', reason: 'bad-hole' });
  const isP0side = hole >= 0 && hole <= 6;
  if ((seat === 0) !== isP0side) return send(ws, { type: 'move_rejected', reason: 'not-own-side' });
  if (room.gameState.holes[hole] === 0) return send(ws, { type: 'move_rejected', reason: 'empty-hole' });

  room.openerPicks[seat] = hole;
  room.lastActivity = Date.now();
  broadcastRoom(room, { type: 'opener_picks_update', picks: room.openerPicks.slice() });

  // Check if all non-done players have committed
  const need = [0, 1].filter(p => !room.gameState.openerDone[p]);
  const allReady = need.every(p => room.openerPicks[p] != null);
  if (!allReady) return;

  // Fire the round
  const picks = [
    room.gameState.openerDone[0] ? null : room.openerPicks[0],
    room.gameState.openerDone[1] ? null : room.openerPicks[1],
  ];
  const result = engine.reducer(room.gameState, { type: 'opener_round', picks });
  if (result.events.length === 1 && result.events[0].kind === 'invalid') {
    // Reset picks and tell both sides — shouldn't normally happen
    room.openerPicks = [null, null];
    broadcastRoom(room, { type: 'move_rejected', reason: result.events[0].reason });
    broadcastRoom(room, { type: 'opener_picks_update', picks: [null, null] });
    return;
  }
  room.gameState = result.state;
  room.seq += 1;
  room.openerPicks = [null, null];
  room.lastActivity = Date.now();
  broadcastRoom(room, {
    type: 'opener_round_applied',
    seq: room.seq,
    picks,
    events: result.events,
    state: result.state,
  });
  broadcastRoom(room, { type: 'opener_picks_update', picks: [null, null] });
  log(`room ${room.code} opener_round applied seq=${room.seq} picks=${JSON.stringify(picks)} done=${JSON.stringify(result.state.openerDone)} phase=${result.state.phase}`);
}

function handleUncommitOpenerPick(ws, state) {
  const room = state.roomCode && rooms.get(state.roomCode);
  if (!room) return;
  if (room.gameState.phase !== 'opener-sim') return;
  const seat = state.seat;
  if (seat == null) return;
  if (room.openerPicks[seat] == null) return;
  room.openerPicks[seat] = null;
  broadcastRoom(room, { type: 'opener_picks_update', picks: room.openerPicks.slice() });
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
      case 'play_move':           return handlePlayMove(ws, state, msg);
      case 'commit_opener_pick':  return handleCommitOpenerPick(ws, state, msg);
      case 'uncommit_opener_pick':return handleUncommitOpenerPick(ws, state);
      case 'request_new_round':   return handleRequestNewRound(ws, state);
      case 'respond_new_round':   return handleRespondNewRound(ws, state, msg);
      default:                    return send(ws, { type: 'echo', payload: msg });
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
