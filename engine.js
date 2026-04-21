// Congkak game engine — pure, no DOM / no React / no side effects.
// Loadable as a classic browser script (attaches to window.CongkakEngine)
// AND as a Node CommonJS module (`require('./engine.js')`).
//
// Phase 1 scaffold: only the low-level helpers live here.
// Phase 2 will add the `reducer(state, action) -> {state, events}` core.
//
// STATE SHAPE (canonical; serializable, no refs, no DOM):
//   {
//     holes:    number[14],      // seeds in each pit; indices 0..6 = P0 (bottom), 7..13 = P1 (top)
//     rumah:    [number, number],// rumah[0] = P0 store, rumah[1] = P1 store
//     turn:     0 | 1,           // whose turn it is (only meaningful in 'alternating')
//     phase:    'opener-sim' | 'alternating',
//     openerDone: [boolean, boolean], // opener-sim: true once a player ends a move without rumah continuation
//     seq:      number,          // monotonic; bumped each reducer transition
//     seedsPerHole: number,      // round parameter (for reset)
//     winner:   null | { player: 0 | 1 | -1, scores: [number, number] },
//   }
//
// ACTION TYPES (Phase 2+ will implement reducers for these):
//   { type: 'reset', seedsPerHole, startStyle: 'simultaneous' | 'alternating' }
//   { type: 'play_move', player: 0 | 1, hole: 0..13 }             // alternating OR opener-sim local
//   { type: 'opener_both_pick', picks: [hole, hole] }             // multiplayer commit-and-reveal
//
// EVENT TYPES (animator replays these to drive UI; each has a `t` offset in ms):
//   { t, kind: 'pickup',      player, from }
//   { t, kind: 'drop',        player, at: {type:'hole',idx} | {type:'rumah',p} }
//   { t, kind: 'chainPickup', player, from, count }
//   { t, kind: 'bump',        player, at }  // opener-sim collision
//   { t, kind: 'tikam',       player, capturedFrom: [idx, idx], loot: number }
//   { t, kind: 'mati',        player }
//   { t, kind: 'anotherTurn', player }
//   { t, kind: 'turnEnd',     nextPlayer }
//   { t, kind: 'phaseChange', from, to }
//   { t, kind: 'roundEnd',    winner }

(function (global) {
  'use strict';

  // ---------- Board helpers ----------

  function makeInitialBoard(seedsPerHole) {
    return {
      holes: Array.from({ length: 14 }, function () { return seedsPerHole; }),
      rumah: [0, 0],
    };
  }

  // Given current player p (0 or 1) and a hole index h, return array of sowing positions (in order).
  // Positions are either {type: 'hole', idx} or {type: 'rumah', p}.
  // Clockwise ring (viewed from above, P0 at bottom, P0 rumah at screen-LEFT, P1 rumah at screen-RIGHT).
  // Bottom row 0..6 runs right→left (0=rightmost, 6=leftmost nearest P0 rumah).
  // Top row 7..13 runs left→right (7=leftmost nearest P0 rumah, 13=rightmost nearest P1 rumah).
  // Player 0 includes rumah0, skips rumah1. Player 1 includes rumah1, skips rumah0.
  var RING = [
    { type: 'hole', idx: 0 }, { type: 'hole', idx: 1 }, { type: 'hole', idx: 2 }, { type: 'hole', idx: 3 },
    { type: 'hole', idx: 4 }, { type: 'hole', idx: 5 }, { type: 'hole', idx: 6 },
    { type: 'rumah', p: 0 },
    { type: 'hole', idx: 7 }, { type: 'hole', idx: 8 }, { type: 'hole', idx: 9 }, { type: 'hole', idx: 10 },
    { type: 'hole', idx: 11 }, { type: 'hole', idx: 12 }, { type: 'hole', idx: 13 },
    { type: 'rumah', p: 1 },
  ];

  function sowPath(fromIdx, player) {
    var start = -1;
    for (var i = 0; i < RING.length; i++) {
      if (RING[i].type === 'hole' && RING[i].idx === fromIdx) { start = i; break; }
    }
    var path = [];
    for (var j = 1; j <= 100; j++) {
      var n = RING[(start + j) % RING.length];
      if (n.type === 'rumah' && n.p !== player) continue;
      path.push(n);
    }
    return path;
  }

  function isOwnSide(idx, player) {
    return player === 0 ? (idx >= 0 && idx <= 6) : (idx >= 7 && idx <= 13);
  }

  // bottom 0..6 opposite top 13..7 (i.e. 0<->13, 1<->12, 2<->11, 3<->10, 4<->9, 5<->8, 6<->7)
  function opposite(idx) {
    return 13 - idx;
  }

  function playerHasMoves(board, p) {
    var range = p === 0 ? [0, 1, 2, 3, 4, 5, 6] : [7, 8, 9, 10, 11, 12, 13];
    for (var i = 0; i < range.length; i++) {
      if (board.holes[range[i]] > 0) return true;
    }
    return false;
  }

  // ---------- State ----------

  // Produce an initial canonical state. `startStyle` is 'simultaneous' | 'alternating'.
  function initialState(seedsPerHole, startStyle) {
    return {
      holes: Array.from({ length: 14 }, function () { return seedsPerHole; }),
      rumah: [0, 0],
      turn: 0, // P0 first in alternating; ignored in opener-sim
      phase: startStyle === 'simultaneous' ? 'opener-sim' : 'alternating',
      openerDone: [false, false],
      seedsPerHole: seedsPerHole,
      winner: null,
      seq: 0,
    };
  }

  function cloneBoard(state) {
    return { holes: state.holes.slice(), rumah: state.rumah.slice() };
  }

  // ---------- Reducer ----------
  //
  // reducer(state, action) -> { state, events }
  //
  // Pure, deterministic, no side effects. Events describe WHAT happened;
  // timing is the animator's concern. Reducer validates and returns the same
  // state with a single { kind: 'invalid', reason } event on illegal moves.

  function reducer(state, action) {
    if (!action || typeof action !== 'object') {
      return { state: state, events: [{ kind: 'invalid', reason: 'badAction' }] };
    }
    if (action.type === 'reset') {
      return {
        state: initialState(action.seedsPerHole || state.seedsPerHole, action.startStyle || 'alternating'),
        events: [{ kind: 'reset' }],
      };
    }
    if (action.type === 'play_move' && state.phase === 'alternating') {
      return playMoveAlternating(state, action.player, action.hole);
    }
    if (action.type === 'opener_round' && state.phase === 'opener-sim') {
      return openerRound(state, action.picks);
    }
    return { state: state, events: [{ kind: 'invalid', reason: 'unknownAction' }] };
  }

  // ---------- Opener-sim (commit-and-reveal) ----------
  //
  // Action: { type: 'opener_round', picks: [holeA|null, holeB|null] }
  //   - picks[p] is the hole player p chose to sow this round, or null if
  //     player p is already done (openerDone[p] === true).
  //
  // Simulates both hands tick-by-tick. Each tick, both active hands try to
  // drop at their next path stop. Collision (both target same hole): lower
  // seat (player 0) drops; higher seat bumps (stays, emits a bump event,
  // retries same target next tick).
  //
  // A hand's sowing may internally chain (last seed lands in a non-empty
  // non-rumah hole → pick up, continue) within the same round. The round
  // ends for a hand when it terminates with one of: rumah continuation
  // (anotherTurn), tikam, noCapture, or mati.
  //
  // openerDone[p] becomes true unless the hand ended in anotherTurn.
  // When both openerDone are true, phase transitions to 'alternating'.

  function sameStop(a, b) {
    if (!a || !b) return false;
    if (a.type !== b.type) return false;
    if (a.type === 'hole') return a.idx === b.idx;
    return a.p === b.p;
  }

  function openerRound(state, picks) {
    if (!picks || picks.length !== 2) {
      return { state: state, events: [{ kind: 'invalid', reason: 'badPicks' }] };
    }
    if (state.winner) {
      return { state: state, events: [{ kind: 'invalid', reason: 'gameOver' }] };
    }
    // Validate picks
    for (var p = 0; p < 2; p++) {
      var pick = picks[p];
      if (state.openerDone[p]) {
        if (pick != null) return { state: state, events: [{ kind: 'invalid', reason: 'alreadyDone' }] };
      } else {
        if (pick == null) return { state: state, events: [{ kind: 'invalid', reason: 'missingPick' }] };
        if (!isOwnSide(pick, p)) return { state: state, events: [{ kind: 'invalid', reason: 'notOwnSide' }] };
        if (state.holes[pick] === 0) return { state: state, events: [{ kind: 'invalid', reason: 'emptyHole' }] };
      }
    }

    var b = cloneBoard(state);
    var events = [];

    // Per-hand state
    var hands = [null, null];
    for (var p2 = 0; p2 < 2; p2++) {
      if (picks[p2] == null) continue;
      var count = b.holes[picks[p2]];
      b.holes[picks[p2]] = 0;
      hands[p2] = {
        player: p2,
        currentHole: picks[p2],
        carrying: count,
        path: sowPath(picks[p2], p2),
        pathIdx: 0,
        passedOwnRumah: false,
        done: false,
        result: null, // 'anotherTurn' | 'tikam' | 'noCaptureNotPassed' | 'noCaptureOppEmpty' | 'mati'
      };
      events.push({ kind: 'pickup', player: p2, hole: picks[p2], count: count });
    }

    // Tick loop: both hands advance in lockstep until both done.
    // Bounded to prevent pathological infinite loops.
    var MAX_TICKS = 500;
    for (var tick = 0; tick < MAX_TICKS; tick++) {
      var anyActive = false;
      for (var q = 0; q < 2; q++) {
        if (hands[q] && !hands[q].done) { anyActive = true; break; }
      }
      if (!anyActive) break;

      // Compute each active hand's target this tick (next path stop)
      var targets = [null, null];
      for (var r = 0; r < 2; r++) {
        if (hands[r] && !hands[r].done && hands[r].carrying > 0) {
          targets[r] = hands[r].path[hands[r].pathIdx];
        }
      }

      // Collision: both targets point to same stop
      var collision = targets[0] && targets[1] && sameStop(targets[0], targets[1]);

      for (var s = 0; s < 2; s++) {
        if (!targets[s]) continue;
        if (collision && s === 1) {
          // Higher-seat bumps, lower-seat drops. Hand stays put, retries next tick.
          events.push({ kind: 'bump', player: s, at: targets[s] });
          continue;
        }
        // Drop
        var stop = targets[s];
        if (stop.type === 'hole') {
          b.holes[stop.idx] += 1;
        } else {
          b.rumah[stop.p] += 1;
          if (stop.p === s) hands[s].passedOwnRumah = true;
        }
        events.push({ kind: 'drop', player: s, at: stop });
        hands[s].carrying -= 1;
        hands[s].pathIdx += 1;

        // Terminal analysis if this was the last drop in hand
        if (hands[s].carrying === 0) {
          analyzeEndOfSow(b, hands[s], events);
          // If result was a chain, hand continues with a new pickup/path (not done)
        }
      }
    }

    // Update openerDone flags based on each hand's result
    var newOpenerDone = state.openerDone.slice();
    for (var t = 0; t < 2; t++) {
      if (hands[t] && hands[t].result !== 'anotherTurn') {
        newOpenerDone[t] = true;
      }
    }

    // End-of-round check
    var p0Has = playerHasMoves(b, 0);
    var p1Has = playerHasMoves(b, 1);
    var winner = null;
    var newPhase = state.phase;
    var newTurn = state.turn;

    if (!p0Has && !p1Has) {
      var w = b.rumah[0] === b.rumah[1] ? -1 : (b.rumah[0] > b.rumah[1] ? 0 : 1);
      winner = { player: w, scores: b.rumah.slice() };
      events.push({ kind: 'roundEnd', winner: w, scores: b.rumah.slice() });
    } else if (newOpenerDone[0] && newOpenerDone[1]) {
      // Both players finished opener → switch to alternating.
      // Starting turn: pick the player who was NOT active this round if possible
      // (so whoever finished "earlier" conceptually waits). If both were active,
      // default to the higher-seat (so P1 plays first in alternating, giving P0
      // who "went first" in opener a brief rest). Adjust if round-end detection
      // shows a single-active round.
      newPhase = 'alternating';
      var bothActive = picks[0] != null && picks[1] != null;
      if (bothActive) {
        newTurn = playerHasMoves(b, 1) ? 1 : 0;
      } else if (picks[0] != null) {
        newTurn = playerHasMoves(b, 1) ? 1 : 0;
      } else {
        newTurn = playerHasMoves(b, 0) ? 0 : 1;
      }
      events.push({ kind: 'phaseChange', from: 'opener-sim', to: 'alternating' });
      events.push({ kind: 'turnEnd', nextPlayer: newTurn });
    } else {
      events.push({ kind: 'openerRoundEnd', openerDone: newOpenerDone });
    }

    return {
      state: {
        holes: b.holes,
        rumah: b.rumah,
        turn: newTurn,
        phase: newPhase,
        openerDone: newOpenerDone,
        seedsPerHole: state.seedsPerHole,
        winner: winner,
        seq: state.seq + 1,
      },
      events: events,
    };
  }

  // Analyze the terminal stop of a hand that just dropped its last seed.
  // Mutates `b` on tikam (captures seeds), sets `hand.result` and `hand.done`.
  // On chain continuation, sets up the hand for its next sowing (not done).
  function analyzeEndOfSow(b, hand, events) {
    // Find the last drop stop from the hand's path (pathIdx points PAST the last drop)
    var lastStop = hand.path[hand.pathIdx - 1];
    var p = hand.player;

    if (lastStop.type === 'rumah' && lastStop.p === p) {
      events.push({ kind: 'anotherTurn', player: p });
      hand.result = 'anotherTurn';
      hand.done = true;
      return;
    }
    if (lastStop.type === 'hole') {
      var lastIdx = lastStop.idx;
      if (b.holes[lastIdx] > 1) {
        // Chain: pick up and continue from this hole
        var pickupCount = b.holes[lastIdx];
        b.holes[lastIdx] = 0;
        hand.currentHole = lastIdx;
        hand.carrying = pickupCount;
        hand.path = sowPath(lastIdx, p);
        hand.pathIdx = 0;
        events.push({ kind: 'pickup', player: p, hole: lastIdx, count: pickupCount });
        return;
      }
      // Landed in empty hole (now has exactly 1 from our drop)
      if (isOwnSide(lastIdx, p)) {
        var oppIdx = opposite(lastIdx);
        if (b.holes[oppIdx] > 0 && hand.passedOwnRumah) {
          var loot = b.holes[oppIdx] + b.holes[lastIdx];
          events.push({
            kind: 'tikam',
            player: p,
            landedHole: lastIdx,
            oppHole: oppIdx,
            oppCount: b.holes[oppIdx],
            landCount: b.holes[lastIdx],
            loot: loot,
          });
          b.holes[oppIdx] = 0;
          b.holes[lastIdx] = 0;
          b.rumah[p] += loot;
          hand.result = 'tikam';
        } else if (b.holes[oppIdx] > 0) {
          events.push({ kind: 'noCapture', player: p, reason: 'notPassedRumah' });
          hand.result = 'noCaptureNotPassed';
        } else {
          events.push({ kind: 'noCapture', player: p, reason: 'opponentEmpty' });
          hand.result = 'noCaptureOppEmpty';
        }
      } else {
        events.push({ kind: 'mati', player: p });
        hand.result = 'mati';
      }
      hand.done = true;
    }
  }

  // Alternating-mode single move. Mirrors playMoveV2's logic exactly
  // (including the chain-while-non-empty, tikam-requires-passed-rumah rule,
  // and "next player skipping if opponent has no moves" rule).
  function playMoveAlternating(state, player, startHole) {
    // Validate
    if (state.winner) {
      return { state: state, events: [{ kind: 'invalid', reason: 'gameOver' }] };
    }
    if (state.turn !== player) {
      return { state: state, events: [{ kind: 'invalid', reason: 'notYourTurn' }] };
    }
    if (!isOwnSide(startHole, player)) {
      return { state: state, events: [{ kind: 'invalid', reason: 'notOwnSide' }] };
    }
    if (state.holes[startHole] === 0) {
      return { state: state, events: [{ kind: 'invalid', reason: 'emptyHole' }] };
    }

    var b = cloneBoard(state);
    var events = [];
    var currentHole = startHole;
    var resolvedInOwnRumah = false;
    var passedOwnRumah = false;

    // Chain loop: keep sowing while the last seed lands in a non-empty hole.
    // Bounded to prevent infinite loops if logic is ever wrong.
    for (var chain = 0; chain < 40; chain++) {
      var count = b.holes[currentHole];
      b.holes[currentHole] = 0;
      events.push({ kind: 'pickup', player: player, hole: currentHole, count: count });

      var path = sowPath(currentHole, player);
      var lastStop = null;
      for (var i = 0; i < count; i++) {
        var stop = path[i];
        if (stop.type === 'hole') {
          b.holes[stop.idx] += 1;
        } else {
          b.rumah[stop.p] += 1;
          if (stop.p === player) passedOwnRumah = true;
        }
        events.push({ kind: 'drop', player: player, at: stop });
        lastStop = stop;
      }

      if (lastStop.type === 'rumah' && lastStop.p === player) {
        events.push({ kind: 'anotherTurn', player: player });
        resolvedInOwnRumah = true;
        break;
      }
      if (lastStop.type === 'hole') {
        var lastIdx = lastStop.idx;
        if (b.holes[lastIdx] > 1) {
          // Non-empty before our drop (now > 1) → chain continues
          currentHole = lastIdx;
          continue;
        }
        // Landed with exactly 1 seed → empty before drop
        if (isOwnSide(lastIdx, player)) {
          var oppIdx = opposite(lastIdx);
          if (b.holes[oppIdx] > 0 && passedOwnRumah) {
            var loot = b.holes[oppIdx] + b.holes[lastIdx];
            events.push({
              kind: 'tikam',
              player: player,
              landedHole: lastIdx,
              oppHole: oppIdx,
              oppCount: b.holes[oppIdx],
              landCount: b.holes[lastIdx],
              loot: loot,
            });
            b.holes[oppIdx] = 0;
            b.holes[lastIdx] = 0;
            b.rumah[player] += loot;
          } else if (b.holes[oppIdx] > 0 && !passedOwnRumah) {
            events.push({ kind: 'noCapture', player: player, reason: 'notPassedRumah' });
          } else {
            events.push({ kind: 'noCapture', player: player, reason: 'opponentEmpty' });
          }
        } else {
          events.push({ kind: 'mati', player: player });
        }
        break;
      }
    }

    // End-of-round check
    var p0Has = playerHasMoves(b, 0);
    var p1Has = playerHasMoves(b, 1);
    var winner = null;
    var nextPlayer;

    if (!p0Has && !p1Has) {
      var w = b.rumah[0] === b.rumah[1] ? -1 : (b.rumah[0] > b.rumah[1] ? 0 : 1);
      winner = { player: w, scores: b.rumah.slice() };
      events.push({ kind: 'roundEnd', winner: w, scores: b.rumah.slice() });
      nextPlayer = state.turn; // moot — game over
    } else {
      if (resolvedInOwnRumah) {
        nextPlayer = playerHasMoves(b, player) ? player : (1 - player);
      } else {
        nextPlayer = 1 - player;
        if (!playerHasMoves(b, nextPlayer)) {
          nextPlayer = playerHasMoves(b, player) ? player : nextPlayer;
        }
      }
      events.push({ kind: 'turnEnd', nextPlayer: nextPlayer });
    }

    return {
      state: {
        holes: b.holes,
        rumah: b.rumah,
        turn: nextPlayer,
        phase: state.phase,
        openerDone: state.openerDone.slice(),
        seedsPerHole: state.seedsPerHole,
        winner: winner,
        seq: state.seq + 1,
      },
      events: events,
    };
  }

  // ---------- Exports ----------

  var CongkakEngine = {
    makeInitialBoard: makeInitialBoard,
    sowPath: sowPath,
    isOwnSide: isOwnSide,
    opposite: opposite,
    playerHasMoves: playerHasMoves,
    initialState: initialState,
    reducer: reducer,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = CongkakEngine; // Node
  } else {
    global.CongkakEngine = CongkakEngine; // Browser
  }
})(typeof self !== 'undefined' ? self : this);
