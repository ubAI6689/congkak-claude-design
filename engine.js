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

  // ---------- Exports ----------

  var CongkakEngine = {
    makeInitialBoard: makeInitialBoard,
    sowPath: sowPath,
    isOwnSide: isOwnSide,
    opposite: opposite,
    playerHasMoves: playerHasMoves,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = CongkakEngine; // Node
  } else {
    global.CongkakEngine = CongkakEngine; // Browser
  }
})(typeof self !== 'undefined' ? self : this);
