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
      // True when both players finished opener in the SAME round and the
      // opener→alternating transition is blocked on a tiebreaker resolution
      // (RPS). Cleared by resolve_tiebreaker action.
      awaitingTiebreaker: false,
      // Intra-round pause: set when a hand lands in its own rumah (anotherTurn)
      // while the other hand is still actively sowing. Shape:
      //   { tick, pausers: [bool, bool], frozen: [hand|null, hand|null],
      //     openerDoneSoFar: [bool, bool] }
      // Cleared by opener_resume. Null in the common case.
      pendingPause: null,
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
    if (action.type === 'opener_resume' && state.phase === 'opener-sim') {
      return openerResume(state, action.picks);
    }
    if (action.type === 'opener_solo' && state.phase === 'opener-sim') {
      return openerSolo(state, action.player, action.hole);
    }
    if (action.type === 'resolve_tiebreaker' && state.awaitingTiebreaker) {
      return resolveTiebreaker(state, action.winner);
    }
    return { state: state, events: [{ kind: 'invalid', reason: 'unknownAction' }] };
  }

  // ---------- Tiebreaker resolution ----------
  // After RPS decides who goes first, server applies this to transition to
  // alternating with the chosen winner. Falls back if winner has no moves.
  function resolveTiebreaker(state, winner) {
    if (winner !== 0 && winner !== 1) {
      return { state: state, events: [{ kind: 'invalid', reason: 'badWinner' }] };
    }
    var newTurn = winner;
    if (!playerHasMoves(state, newTurn) && playerHasMoves(state, 1 - newTurn)) {
      newTurn = 1 - newTurn;
    }
    return {
      state: Object.assign({}, state, {
        phase: 'alternating',
        turn: newTurn,
        awaitingTiebreaker: false,
        seq: state.seq + 1,
      }),
      events: [
        { kind: 'phaseChange', from: 'opener-sim', to: 'alternating' },
        { kind: 'turnEnd', nextPlayer: newTurn },
      ],
    };
  }

  // ---------- Opener-solo (multiplayer, per-player atomic move) ----------
  //
  // { type: 'opener_solo', player, hole } — one player's opener move, atomically.
  // Mirrors playMoveAlternating's sowing/chain/tikam rules, but:
  //   - No state.turn check (simultaneous phase has no turn ordering)
  //   - Updates state.openerDone[player] based on whether it ended in rumah
  //     continuation. Non-rumah ends set openerDone[player] = true.
  //   - When both openerDone flags are true, transitions phase to 'alternating'
  //     and picks the next player (opposite of the last to finish if possible).
  //
  // Unlike opener_round, there's no collision detection vs. the other player —
  // moves are serialized on the server, each atomic, so "simultaneous" is a
  // visual effect on the client (animations overlap in wall-clock time).

  function openerSolo(state, player, hole) {
    if (state.winner) return { state: state, events: [{ kind: 'invalid', reason: 'gameOver' }] };
    if (state.openerDone[player]) return { state: state, events: [{ kind: 'invalid', reason: 'alreadyDone' }] };
    if (!isOwnSide(hole, player)) return { state: state, events: [{ kind: 'invalid', reason: 'notOwnSide' }] };
    if (state.holes[hole] === 0) return { state: state, events: [{ kind: 'invalid', reason: 'emptyHole' }] };

    var b = cloneBoard(state);
    var events = [];
    var currentHole = hole;
    var resolvedInOwnRumah = false;
    var passedOwnRumah = false;

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
          currentHole = lastIdx;
          continue;
        }
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

    // Update openerDone flag for this player
    var newOpenerDone = state.openerDone.slice();
    if (!resolvedInOwnRumah) newOpenerDone[player] = true;

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
      // Both done with opener → switch to alternating.
      // The LAST to finish is `player` (this move); opponent goes first.
      newPhase = 'alternating';
      var other = 1 - player;
      newTurn = playerHasMoves(b, other) ? other : player;
      events.push({ kind: 'phaseChange', from: 'opener-sim', to: 'alternating' });
      events.push({ kind: 'turnEnd', nextPlayer: newTurn });
    }

    return {
      state: {
        holes: b.holes,
        rumah: b.rumah,
        turn: newTurn,
        phase: newPhase,
        openerDone: newOpenerDone,
        awaitingTiebreaker: false,
        seedsPerHole: state.seedsPerHole,
        winner: winner,
        seq: state.seq + 1,
      },
      events: events,
    };
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
    if (state.pendingPause) {
      return { state: state, events: [{ kind: 'invalid', reason: 'paused-use-resume' }] };
    }
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
      hands[p2] = freshHand(p2, picks[p2], count);
      events.push({ kind: 'pickup', player: p2, hole: picks[p2], count: count });
    }

    return runOpenerTicksAndFinalize(state, b, hands, 0, events, state.openerDone.slice(), picks);
  }

  // Resume action: state.pendingPause must be set. `picks[p]` is the pausing
  // player's new starting hole (or null for non-pausers). Frozen hands are
  // rebuilt from state.pendingPause.frozen and the round continues.
  function openerResume(state, picks) {
    if (!state.pendingPause) {
      return { state: state, events: [{ kind: 'invalid', reason: 'noPause' }] };
    }
    if (!picks || picks.length !== 2) {
      return { state: state, events: [{ kind: 'invalid', reason: 'badPicks' }] };
    }
    var pp = state.pendingPause;
    // Each pauser must supply a pick; each non-pauser must supply null.
    for (var p = 0; p < 2; p++) {
      var pick = picks[p];
      if (pp.pausers[p]) {
        if (pick == null) return { state: state, events: [{ kind: 'invalid', reason: 'missingPick' }] };
        if (!isOwnSide(pick, p)) return { state: state, events: [{ kind: 'invalid', reason: 'notOwnSide' }] };
        if (state.holes[pick] === 0) return { state: state, events: [{ kind: 'invalid', reason: 'emptyHole' }] };
      } else {
        if (pick != null) return { state: state, events: [{ kind: 'invalid', reason: 'notPauser' }] };
      }
    }

    var b = cloneBoard(state);
    var events = [];
    var hands = [null, null];

    for (var p2 = 0; p2 < 2; p2++) {
      if (pp.pausers[p2]) {
        // Pauser picks a new hole; start a fresh hand.
        var count = b.holes[picks[p2]];
        b.holes[picks[p2]] = 0;
        hands[p2] = freshHand(p2, picks[p2], count);
        events.push({ kind: 'pickup', player: p2, hole: picks[p2], count: count });
      } else if (pp.frozen[p2]) {
        // Unfreeze: rebuild the live hand from the snapshot.
        var f = pp.frozen[p2];
        hands[p2] = {
          player: p2,
          currentHole: f.currentHole,
          carrying: f.carrying,
          path: sowPath(f.currentHole, p2),
          pathIdx: f.pathIdx,
          passedOwnRumah: f.passedOwnRumah,
          done: false,
          result: null,
        };
        // No pickup event — this hand is mid-sow.
      }
      // else: neither pauser nor frozen → player is already done this round.
    }

    // Start ticking from the tick AFTER the pause.
    var clearedPauseState = Object.assign({}, state, { pendingPause: null });
    return runOpenerTicksAndFinalize(clearedPauseState, b, hands, pp.tick + 1, events, pp.openerDoneSoFar.slice(), /* picks only used for finalization heuristics */ null);
  }

  function freshHand(player, startHole, count) {
    return {
      player: player,
      currentHole: startHole,
      carrying: count,
      path: sowPath(startHole, player),
      pathIdx: 0,
      passedOwnRumah: false,
      done: false,
      result: null, // 'anotherTurn' | 'tikam' | 'noCaptureNotPassed' | 'noCaptureOppEmpty' | 'mati'
    };
  }

  // Freeze a live hand for the pendingPause snapshot. Strips `path` (recomputed
  // from currentHole on resume) and runtime flags; keeps what's needed to
  // render + resume.
  function freezeHand(hand) {
    return {
      player: hand.player,
      currentHole: hand.currentHole,
      carrying: hand.carrying,
      pathIdx: hand.pathIdx,
      passedOwnRumah: hand.passedOwnRumah,
    };
  }

  // Tick loop + finalization. Can return early with pendingPause if a hand
  // lands in its own rumah while the other is still carrying seeds. `picks`
  // (if non-null) is the ORIGINAL opener_round picks, used for the RPS
  // finalization's single-active check.
  function runOpenerTicksAndFinalize(state, b, hands, startTick, events, openerDoneSoFar, picks) {
    var MAX_TICKS = 500;
    var tick = startTick;
    var pauseTriggered = false;
    for (; tick < MAX_TICKS; tick++) {
      var anyActive = false;
      for (var q = 0; q < 2; q++) {
        if (hands[q] && !hands[q].done) { anyActive = true; break; }
      }
      if (!anyActive) break;

      var targets = [null, null];
      for (var r = 0; r < 2; r++) {
        if (hands[r] && !hands[r].done && hands[r].carrying > 0) {
          targets[r] = hands[r].path[hands[r].pathIdx];
        }
      }

      var collision = targets[0] && targets[1] && sameStop(targets[0], targets[1]);

      // Track who got anotherTurn this tick (for pause detection at tick end).
      var anotherThisTick = [false, false];

      for (var s = 0; s < 2; s++) {
        if (!targets[s]) continue;
        if (collision && s === 1) {
          events.push({ kind: 'bump', player: s, at: targets[s] });
          continue;
        }
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

        if (hands[s].carrying === 0) {
          analyzeEndOfSow(b, hands[s], events);
          if (hands[s].done && hands[s].doneTick == null) hands[s].doneTick = tick;
          if (hands[s].result === 'anotherTurn') anotherThisTick[s] = true;
        }
      }

      // Pause check (end of tick): did anyone end with anotherTurn while
      // another hand is still carrying seeds? If so, stop here and emit a
      // pendingPause. Players whose anotherTurn hand has no legal follow-up
      // pick (their own side is empty) are finalized normally instead of
      // pausing — we let openerDone flip for them via the usual path.
      if (anotherThisTick[0] || anotherThisTick[1]) {
        var anyStillActive = (hands[0] && !hands[0].done && hands[0].carrying > 0)
                           || (hands[1] && !hands[1].done && hands[1].carrying > 0);
        // Only consider the pause branch when another hand is still sowing;
        // otherwise the round is effectively ending and we fall through to
        // finalization (preserving anotherTurn → openerDone stays false).
        var pausers = [false, false];
        if (anyStillActive) {
          for (var u = 0; u < 2; u++) {
            if (anotherThisTick[u] && playerHasMoves(b, u)) pausers[u] = true;
            else if (anotherThisTick[u] && !playerHasMoves(b, u)) {
              // Dead-end pauser: can't pick new hole (own side empty). Flip
              // to openerDone so the round can close when the still-active
              // hand terminates.
              hands[u].result = 'anotherTurnDeadEnd';
            }
          }
        }
        if (anyStillActive && (pausers[0] || pausers[1])) {
          // Freeze the non-pausing active hand (if any).
          var frozen = [null, null];
          for (var v = 0; v < 2; v++) {
            if (!pausers[v] && hands[v] && !hands[v].done && hands[v].carrying > 0) {
              frozen[v] = freezeHand(hands[v]);
            }
          }
          events.push({ kind: 'openerPause', pausers: pausers.slice(), tick: tick });
          return {
            state: {
              holes: b.holes,
              rumah: b.rumah,
              turn: state.turn,
              phase: state.phase,
              openerDone: openerDoneSoFar.slice(),
              awaitingTiebreaker: false,
              pendingPause: {
                tick: tick,
                pausers: pausers,
                frozen: frozen,
                openerDoneSoFar: openerDoneSoFar.slice(),
              },
              seedsPerHole: state.seedsPerHole,
              winner: null,
              seq: state.seq + 1,
            },
            events: events,
          };
        }
        // Edge case: all anotherTurn-ers are dead-ends and no one else is
        // active. Fall through to finalization below (round ends).
      }
    }

    // Update openerDone flags based on each hand's result. anotherTurn
    // (legitimate) does NOT flip openerDone; anotherTurnDeadEnd does.
    var newOpenerDone = openerDoneSoFar.slice();
    for (var t = 0; t < 2; t++) {
      if (hands[t] && hands[t].result != null && hands[t].result !== 'anotherTurn') {
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
      var bothActiveThisRound = hands[0] != null && hands[1] != null;
      var tickSimultaneous = bothActiveThisRound
        && hands[0].doneTick != null && hands[1].doneTick != null
        && hands[0].doneTick === hands[1].doneTick;
      if (tickSimultaneous) {
        events.push({ kind: 'tiebreakerNeeded' });
        return {
          state: {
            holes: b.holes,
            rumah: b.rumah,
            turn: state.turn,
            phase: state.phase,
            openerDone: newOpenerDone,
            awaitingTiebreaker: true,
            pendingPause: null,
            seedsPerHole: state.seedsPerHole,
            winner: null,
            seq: state.seq + 1,
          },
          events: events,
        };
      }
      newPhase = 'alternating';
      if (bothActiveThisRound) {
        var earlier = hands[0].doneTick < hands[1].doneTick ? 0 : 1;
        newTurn = playerHasMoves(b, earlier) ? earlier : (1 - earlier);
      } else if (hands[0]) {
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
        awaitingTiebreaker: false,
        pendingPause: null,
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
        awaitingTiebreaker: state.awaitingTiebreaker || false,
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
