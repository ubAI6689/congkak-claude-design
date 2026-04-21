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
    // opener-sim actions land in Phase 1.5; stub for now
    return { state: state, events: [{ kind: 'invalid', reason: 'unknownAction' }] };
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
