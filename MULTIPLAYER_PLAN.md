# Multiplayer Plan — Congkak

Online multiplayer for a single-file React CDN app. Long-running, phased.
Target: casual 2-player, no anti-cheat, user owns the OVH VPS serving the static site.

## Status — decisions locked (2026-04-21, revised)

- **Branch**: `multiplayer` (pushed to origin). All dev lives here until merge-to-main.
- **Build**: accept the split. New `engine.js` ES module, shared by browser + Node server.
- **Architecture**: self-hosted WebSocket relay on OVH VPS, server-authoritative.
- **Transport path**: `wss://congkak.ubaidrac.xyz/ws` (behind Cloudflare, nginx reverse proxy to local Node process).
- **Beta env**: `https://congkak.ubaidrac.xyz/beta/` (path-based, not subdomain). Protected by HTTP Basic Auth.
- **Sim opener in MVP**: **Classic-feel independent moves, NOT commit-and-reveal.** Each player's click fires their own atomic move through the server. Fast player acts immediately without waiting for the other. Dropped the commit-and-reveal pattern — the insight: once you accept "no waiting," there's nothing a commit step adds beyond classic click-to-sow. And since both players physically share a screen anyway in our pass-and-play scenarios, anti-peek isn't a real concern.
- **Collision / bump mechanic dropped for MP.** Rule simplification: if both players happen to drop in the same hole on the same wall-clock instant, both drops land, no bump. Rationale: the bump was a local-play artifact (needed because both coroutines shared event-loop memory). Over a network, preserving it requires rollback netcode (weeks of work). Eliminating it gives clean, simple per-player atomic moves.
- **Tikam on contested holes**: resolved by server arrival order (first move processed wins). If P0 is about to tikam hole 4 and P1 just dropped a seed into the opposite hole, P0's tikam captures P1's seed. Matches physical play: whoever reaches the contested hole first.
- **Accounts + leaderboard**: phased after MVP. Phase 6 adds optional accounts (anon still works). Phase 7 adds leaderboard with persistent DB. MVP is fully anonymous room-code play.
- **Reconnect window**: 60s.
- **Rollback netcode / live-race**: explicitly rejected.

### Why we reverted reveal-mode on 2026-04-21

- Built the commit-and-reveal UI for local play (Phase 1.4b+c).
- User request: "fast player should be able to MOVE immediately, not just pick."
- Realization: "pick first, animate later" is only useful if (a) the game hides your pick from opponent, or (b) both reveals must be synchronized for drama. For local play, neither holds. For MP with the "classic feel" requirement, both hold but collide with the requirement.
- Decision: drop reveal mode. MP uses per-player atomic moves, no bumps. Simpler protocol, matches user's mental model of "click and go."
- Kept in engine.js: `opener_round` reducer + 7 unit tests (unused but complete; may be reused if we ever want a synchronized MP mode).

## TL;DR

- **Recommendation:** self-hosted WebSocket relay on the existing OVH VPS, server-authoritative for game state, client-owns-animation. Reject P2P/WebRTC for Phase 1 (NAT traversal + no STUN/TURN budget = flaky; offers nothing this game needs).
- **Mandatory prerequisite (Phase 1):** refactor the move engine into a pure reducer (`(state, action) -> {state, events}`), decoupled from animation. This is the single largest unlock and is behavior-preserving — everything else depends on it. Without this, every later phase pays double.
- **MVP shape:** alternating mode only, real-time only, room-code lobby, no accounts, graceful disconnect with 60s reconnect window. Simultaneous opener is explicitly deferred to Phase 6 (or dropped).
- **Hardest problem:** simultaneous opener under network latency. Treat it as a research spike, not a scope commitment.

---

## 1. Research

### 1.1 Architecture options

| Option | What it is | Fit for this project |
|---|---|---|
| **Self-hosted WebSocket server (Node + `ws`)** on OVH | Single Node process behind nginx reverse proxy at `/ws`, Cloudflare passes WS through (enable "WebSockets" in CF dash). Rooms in memory, optional SQLite for persistence. | **Best fit.** You already own the VPS. ~200 LOC of server. Works through corporate NAT. Cloudflare proxy is fine for WSS if you enable it. |
| **WebRTC / PeerJS** (P2P) | Browsers talk directly after signaling handshake. Still need a signaling channel (small WS server or public PeerServer). Often needs TURN for symmetric NATs (non-free at scale). | **Poor fit.** No latency advantage for a turn-based game. Adds a class of connection failures (TURN-less clients). No benefit over WS for 2 peers. Keep in mind only if you later want 3+ peer spectator mesh. |
| **PartyKit** (Cloudflare Workers) | Managed WS rooms, edge-resident, generous free tier. ~50 LOC server. | Good fit *if* you want zero VPS ops and are OK with vendor lock-in. Rejects for now because OVH ownership is a stated constraint and self-host cost is effectively zero. |
| **Supabase / Firebase Realtime / Ably** | Managed pub/sub + presence. Supabase has auth and Postgres bundled; Ably is pure realtime. | Overkill. Imposes SDK weight on the single-file app, pushes you toward accounts/DB you don't need. Consider only if async ("send a link, resume in 3 days") becomes a requirement. |
| **Shared-link async** (correspondence chess model) | State lives on server; each move writes, opponent polls/SSE. | Orthogonal — could layer on top of any of the above. Worth doing later if users ask. Not MVP. |

### 1.2 Authority models

- **Client-authoritative.** Each client computes `next = reducer(state, action)` locally, then broadcasts the new state. Simple. Breaks the second a client drifts (bug, tampering, packet loss reordering), and there's no arbitrator when two clients disagree — which the simultaneous-opener mode *will* produce.
- **Server-authoritative.** Server holds canonical state. Clients send `{type: "play_move", hole: 3}`. Server runs reducer, broadcasts `{stateHash, events, seq}`. Clients apply and animate. Costs: server must ship the reducer (Node can import the same JS module the client uses). Wins: single source of truth, trivial reconnect (rehydrate from snapshot), natural spot to resolve simultaneous-mode races.
- **Hybrid (authoritative server + optimistic client).** Client plays the animation immediately on input, server confirms within ~50ms on LAN / ~150ms over Cloudflare. Rollback on mismatch. For this game the animation is long (~2s) so optimism is basically free — you won't ever need to rollback a turn-based move that the server accepts. Use this.

**Recommended:** server-authoritative with optimistic client animation. No rollback protocol needed for alternating mode (server latency << animation duration).

### 1.3 Syncing animation-driven engines

The current engine mixes game logic and animation in one `async` function (see `playMoveV2`, lines 2041–2238). Seeds are dropped into `board` state every 90ms alongside `setHand(...)`. This is not serializable across the network — you'd be paying for 7–50 `setBoard` round-trips per move.

**Standard fix** (well-known pattern, used by every networked board game): split into two layers.

- **Pure reducer.** Input: `(state, action)`. Output: `{state', events[]}` where `events` is a timeline like `[{t:0, kind:'pickup', from:3, count:7}, {t:260, kind:'drop', at:{type:'hole',idx:4}}, {t:350, kind:'drop', at:{type:'hole',idx:5}}, ..., {t:X, kind:'tikam', capturedFrom:[9,4], loot:8}, {t:Y, kind:'turnEnd', nextPlayer:1}]`. Deterministic, synchronous, testable.
- **Animator.** Consumes events, plays sounds, tweens hands, schedules `setTimeout` to fire the next event. Each peer runs its own animator off the same event list — no animation sync across the wire, only the event list.

Over the network: server sends `{action, events, newState, seq}` once. Each client's animator plays the 2-second sequence locally. Clients stay in perfect sync because the timeline is deterministic, not because the `setTimeout`s are synchronized.

This decomposition is also the cleanup every existing 2300-line file needs regardless of multiplayer.

---

## 2. Recommended architecture

**WebSocket relay on OVH VPS, server-authoritative, optimistic client animation, event-list sync.**

```
[browser A] <--- wss://congkak.ubaidrac.xyz/ws ---> [nginx /ws] --> [Node WS server on 127.0.0.1:8787]
[browser B] <--- wss://congkak.ubaidrac.xyz/ws ---> [nginx /ws] -/      (in-memory rooms)
```

**Why this:**

- Zero marginal cost; the VPS is already up.
- Cloudflare supports WSS passthrough with "WebSockets" toggle on.
- nginx `location /ws` → `proxy_pass http://127.0.0.1:8787` with `Upgrade` headers. Standard boilerplate.
- Same reducer module runs server-side (Node) and client-side (browser). Makes the server trivially correct.
- Room state fits in memory (a full Congkak game is <1KB). Persist to SQLite only if async games become a feature.
- Node server stays under 300 LOC including reconnect + heartbeat.

**Trade-offs accepted:**

- Single point of failure (one VPS). Acceptable for a casual game. Restart drops active games; reconnect window mitigates.
- No horizontal scale. Irrelevant at expected load (dozens of concurrent rooms tops).
- Need a build step (server wants CJS/ESM reducer; client is Babel-standalone browser script). See Phase 1 note below.

**Rejected alternatives and why:**

- PeerJS: adds TURN-server risk for ~0 benefit on turn-based play.
- PartyKit: fine product, but pulling in a Workers deploy when the VPS is already there adds ops surface, not removes it.
- Supabase/Firebase: SDK bloat, forces account system, locks you in. Reconsider only if async play becomes a hard requirement.

---

## 3. Phased plan

Each phase ships on its own. Don't start phase N+1 until N is live in prod.

### Phase 1 — Pure reducer refactor (prereq, no multiplayer yet)

**Goal:** extract `(state, action) -> {state', events}` with zero behavior change for single-device play. Animation code consumes events instead of being interleaved with logic.

**Why first:** unblocks every networking option, makes the code testable, fixes the known dead-code situation (`playMove` legacy at 1356–1483 per INDEX.md).

**File-level changes** (`Congkak.html`):

- **New section inside the `<script type="text/babel">` block (or, preferred, a new `<script>` tag loading `/congkak-engine.js` so Node can `require` the same file):**
  - `const GAME = { initial(sph), reducer(state, action), legalMoves(state, p), isTerminal(state) }`.
  - Serializable `state` = `{holes:number[14], rumah:number[2], turn:0|1, phase:'opener-sim'|'alternating', openerDone:[bool,bool], turnSeq:number}`.
  - `action` = `{type:'play_move', player, hole}` or `{type:'reset', seedsPerHole}`.
  - `events` = array of `{t, kind, ...payload}` entries the animator plays back.
- **Refactor `playMoveV2` (lines 2041–2238)** into a thin `animateEvents(events)` function. No game logic inside it — just DOM/sound/`setHand`/`setBoard` driven by `kind`.
- **Refactor `playMoveParallel` (2242–2262+)** similarly, but keep the concurrent coroutines + `waitForPath` collision detection inside the animator. The reducer at this phase still models simultaneous opener as two independent sequences; race resolution stays client-local for now.
- **Delete legacy dead code** `playMove` (1356–1483) and `lastRumahRef` (1488–1489) per INDEX.md.
- **Touched state:** `board`, `currentPlayer`, `phase`, `openerDoneRef`, `busyRef`, `hands`, `hand`, `flyingSeeds`, `rumahFlash`, `captureFlashes`, `activeHole`, `isAnimating`, `announce`, `lastAction`, `winner`. None change shape; they're now all driven off events.
- **No `useState`/`useRef` removed.** This is a behavior-preserving refactor. Resist rewriting the component.

**Build decision to pin here:** keeping the app as a single `Congkak.html` is incompatible with Node importing the reducer. Two options:

- **A) Stay single-file.** Server duplicates the reducer. Maintenance hazard — every rule tweak has to land in both files. Acceptable only if you vow to never change the rules.
- **B) Minimal split.** `engine.js` (pure ES module, ~300 LOC) is loaded via `<script type="module" src="./engine.js">` in the HTML and `import` on the server. nginx serves it as a static file. No bundler, no npm, no Babel. **Recommended.** This is a 5-line change in the HTML and ~0 ops complexity.

**Rough scope:** 600–900 LOC touched (mostly relocations), ~150 LOC net added. 1–2 days of careful work plus testing.

**Acceptance:**

- `window.GAME.reducer(state, action)` is pure (no DOM, no `setTimeout`, no `Math.random` without a seed arg, no React).
- Single-device play — alternating and simultaneous — is pixel-identical to current `main`. Verify by eye plus a 20-game regression sanity check.
- Unit tests (even if run by opening a test HTML page) cover: ring path, tikam with/without `passedOwnRumah`, mati, another-turn, end-of-round.

### Phase 2 — Deploy a "stub" server; no gameplay wired yet

**Goal:** get WSS working through Cloudflare to the VPS. Prove the transport, not the protocol.

**Changes:**

- On OVH: new directory `/opt/congkak-server/`, `server.js` using `ws` package, listens on `127.0.0.1:8787`. Responds to `{"type":"ping"}` with `{"type":"pong", "t": Date.now()}`.
- `systemd` unit `congkak-server.service` for supervisor / restart-on-crash.
- nginx site config: new `location /ws { proxy_pass http://127.0.0.1:8787; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 3600s; }`.
- Cloudflare dash: confirm "WebSockets" is on for the zone.
- Client: a tiny `pingTest()` button in a dev-only panel that hits `wss://congkak.ubaidrac.xyz/ws`.

**Scope:** server ~80 LOC. nginx/systemd config ~30 lines. Client ~30 LOC. Half a day.

**Acceptance:** round-trip ping from deployed site succeeds from 3 networks (home, mobile, corporate-NAT).

### Phase 3 — Lobby + room code flow (still single-player gameplay)

**Goal:** two browsers can join a shared room and see a synced presence state. No game moves yet.

**Changes:**

- Server: in-memory `rooms: Map<code, {players: WebSocket[2], state: null, createdAt}>`. Messages: `create_room`, `join_room {code}`, `room_update {players, seat}`, `leave_room`. 6-char alphanumeric codes.
- Client: new UI state `mode: 'local' | 'online-lobby' | 'online-playing'`. "Play online" button on the start screen. Room code shown + copy-link button (`?room=ABC123`). Second browser with that link auto-joins.
- State for MP lives in a new `netRef` — keeps the existing `useState` slots untouched so local mode is unaffected.

**Touched files:** `Congkak.html` (topbar, new lobby modal, new `useEffect` for WS lifecycle), `engine.js` (unchanged), `server.js`.

**Scope:** ~300 LOC client, ~150 LOC server. 1 day.

**Acceptance:** two peers share a room, see each other's seat assignment, survive one peer closing their tab (server marks seat empty, broadcasts).

### Phase 4 — Online play MVP (classic-feel independent moves)

**Goal:** a full game playable online between two browsers. Feels like local classic mode.

**Protocol (unified for opener-sim and alternating):**

- C→S: `{type:'play_move', roomId, seq, move:{player, hole}}`
- S→C (both clients): `{type:'move_applied', seq, move, events, state, stateHash}`
- S→C (on join/reconnect): `{type:'state_snapshot', state, seq}`
- Heartbeat every 20s; disconnect after 45s silence.

**Server logic per move:**

```
on play_move:
  if move.player !== seatOf(sender): reject (seat mismatch)
  if state.phase === 'opener-sim':
    // free-phase: any non-done player can act on own side with seeds
    if state.openerDone[move.player]: reject
    if !isOwnSide(move.hole, move.player): reject
    if state.holes[move.hole] === 0: reject
    {state', events} = openerSoloReducer(state, move.player, move.hole)
  else:
    if state.turn !== move.player: reject
    {state', events} = reducer(state, {type:'play_move', ...move})
  room.state = state'; room.seq++
  broadcast move_applied
```

The server processes moves FCFS. Moves arriving "simultaneously" are serialized by arrival order. No live collision detection; no bumps. Each move is atomic with its full chain computed inside the reducer call.

**Engine additions needed:**

- New reducer action `opener_solo` that simulates ONE player's opener move (vs. `opener_round` which expects both). Mirrors alternating `play_move` internals but skips the `turn` check and updates `openerDone` for the acting player. Does NOT include collision detection against the other player (they're atomic, server-serialized).
- Transition to alternating happens when both `openerDone[0]` and `openerDone[1]` are true (same rule as before).

**Client changes:**

- Visual: opponent's animation plays when `move_applied` arrives. Can overlap with local animations — the concurrent-animator machinery from the (removed) reveal mode is the right shape for this. Keep it in mind to reintroduce.
- Seat awareness: only your side's holes are clickable. Opponent's cursor may or may not be shown (design choice; low-cost either way).

**Reconnect** (basic): client stores `{roomId, seat, clientId}` in sessionStorage. On reload, attempt `rejoin_room`. Server holds seat for 60s. On reconnect, `state_snapshot` restores.

**Scope:** ~400 LOC client, ~250 LOC server. 2–3 days.

**Acceptance:**

- Two browsers on different networks play a complete game through opener-sim and alternating phases.
- Fast player can commit their next move the instant they click; server processes it immediately and broadcasts; opponent sees the animation.
- Closing one tab for <60s and reopening resumes mid-game.
- Illegal moves (forged packets, wrong-seat, out-of-turn in alternating phase) are rejected without desync.

**Protocol (keep tiny):**

- C→S: `{type:'play_move', roomId, seq, move:{player, hole}}`
- S→C (both players): `{type:'move_applied', seq, move, events, state, stateHash}`
- S→C (on join/reconnect): `{type:'state_snapshot', state, seq, lastEvents?}`
- Heartbeat: ping every 20s, disconnect after 45s silence.

**Server logic** (uses the Phase 1 reducer):

```
on play_move:
  if msg.seq != room.seq + 1: reject (out of order)
  if move.player != seatOf(sender): reject
  if !legalMoves(room.state, move.player).includes(move.hole): reject
  {state', events} = reducer(room.state, move)
  room.state = state'; room.seq++
  broadcast move_applied
```

**Client changes:**

- When `mode === 'online-playing'`, the local `playMoveSafe` dispatcher sends `play_move` instead of running the reducer locally. On `move_applied`, the animator runs the returned events against local UI state.
- Optimistic animation: on click, run animation immediately; if server rejects (rare — only on illegal move due to client bug), snap to `state` from `state_snapshot`.
- Seat-awareness: local player only sees keyboard + pointer input for their side. Disable opponent's cursor rendering (`cursorHole[1-mySeat] = null`). The "rotate for P2" panel becomes "waiting for Player Two" when seat 2 is empty.

**Reconnect (basic):**

- Client stores `{roomId, seat, clientId}` in `sessionStorage`.
- On reload, attempt `rejoin_room {roomId, clientId}`. Server holds the seat open for 60s after disconnect. On success, send `state_snapshot` and resume.
- If reconnect window expires, server frees the seat and the other player gets `opponent_forfeited`.

**Touched state:** new `netState` slice (socket, roomId, seat, serverSeq, pendingMove). Existing `currentPlayer` etc. continue to mirror `state.turn` — no structural change.

**Scope:** ~400 LOC client, ~250 LOC server. 2–3 days.

**Acceptance:**

- Two browsers on different networks play a complete alternating game including tikam, another-turn, end-of-round.
- Closing one tab for <60s and reopening resumes mid-game with the board intact.
- Illegal moves (forged client packet) are rejected without desync.

**Ship here.** This is a usable product. Don't keep going until it's been live for a week with friends.

### Phase 5 — Polish & quality-of-life (still shippable incrementally)

Pick off in any order:

- **Spectator mode.** Third+ connection to a room gets `state_snapshot` + `move_applied` but can't `play_move`. ~40 LOC.
- **Rematch button** in the winner overlay. Reuses the room, new `reset` action. ~50 LOC.
- **Tiny chat.** Server relays `{type:'chat', text}` with rate-limit (1 msg/sec). 5-message scrollback visible in a panel. Avoid if you don't want moderation headaches.
- **"Waiting for opponent" affordances.** Timer, copy-link reminder, maybe an emote-only reaction so players know the other peer is alive.
- **Connection-state banner.** Reconnecting / laggy / dropped.

### Phase 5 — Polish & quality-of-life (shippable incrementally)

Covered above (rematch, spectators, connection banner, etc.).

### Phase 6 — Accounts

**Goal:** optional login. Anon play still works.

- DB: SQLite on the VPS. `users(id, username, email?, password_hash, created_at)`.
- Auth: email + password, or magic-link (pick one). Session cookie signed by the Node server.
- Lobby UI: "Sign in" button in topbar. When signed in, your username shows on the player panel. When not, you play as "Guest".
- Room ownership: rooms created by logged-in users persist (can be resumed after reconnect even across sessions); guest-created rooms GC after 5 min idle.
- **Decision required before starting**: email+password vs magic-link. Magic-link simpler (no password reset flow) but requires outbound email (SendGrid/Postmark/self-hosted SMTP). Email+password means handling bcrypt, reset tokens, etc.

### Phase 7 — Leaderboard

**Goal:** persistent per-user stats + rankings.

- DB: add `games(id, player_a_id, player_b_id, winner_id, started_at, ended_at, final_scores)` and `user_stats(user_id, wins, losses, draws, rating)`.
- Rating: simple ELO or Glicko-2. MVP starts everyone at 1200, K-factor 32.
- Leaderboard page `/leaderboard` (public, path-based) with top 100 by rating, plus "your rank" if logged in.
- Games only counted if BOTH players were logged in (prevents alt-account farming).

### Phase 8 — Async / "send a link, play later" (optional, far future)

- Persist rooms to the same SQLite DB as accounts.
- Allow rooms with no currently-connected players; notify via email/webhook when the other player moves.
- Only worth doing if users actually ask. Skip by default.

---

## 4. Open decisions (pin before Phase 2)

User needs to answer these before networking code is written. Grouped by "must answer now" vs "can defer":

**Must answer before Phase 2:**

- **Online-only or also same-LAN P2P?** Recommendation: online-only. LAN adds PeerJS + mDNS complexity for near-zero audience.
- **Self-host on OVH or use a managed service?** Recommendation: OVH (see §2). Confirm.
- **Build step OK, or strict single-file?** (Re: Phase 1 build decision A vs B.) Recommendation: accept the minimal split (`engine.js` module). Confirm.
- **MVP authority model: server-authoritative confirmed?** If yes, reducer must be pure.

**Must answer before Phase 4:**

- **MVP is alternating-only?** Simultaneous opener deferred to Phase 6, possibly dropped. Confirm.
- **Accounts or anonymous?** Recommendation: anonymous, per-session `clientId` cookie, no login. Accounts needed only if persistent stats or async play land later.
- **Reconnect window length?** Recommendation: 60s. Long enough for flaky wifi, short enough that a rage-quit timer doesn't stall the room.

**Can defer until Phase 5:**

- **Chat?** Risk: moderation. Recommendation: no chat v1. Emotes (fixed set of 6) if any social feature.
- **Spectators allowed?** Low cost to add. Default yes if we ship rematch.
- **Reconnect-same-game after the other player left?** Tied to "does server hold rooms after both peers leave?" Recommendation: no — empty rooms GC after 5min.

**Can defer indefinitely:**

- Ranked / ELO / matchmaking.
- Custom rule variants (`seedsPerHole = 9`, etc.) over the wire. The reducer already takes it as a parameter; only lobby UI is missing.
- Mobile-specific multiplayer UI (current app hides on portrait anyway).

---

## 5. Risks and open questions

In rough order of "most likely to eat weeks":

1. **Simultaneous opener over the network.** See Phase 6. Mitigation: default to dropping it for online play. If you won't drop it, budget a 1-week spike *before* committing to Phase 4's architecture — the collision-resolution approach you pick colors the protocol design.
2. **Reconnect semantics.** The state-machine is easy; the UI is hard. What does the player see during "opponent reconnecting... 45s left"? What if they reconnect mid-animation? Mitigation: the animator is event-driven after Phase 1, so a reconnecting client gets `{state, lastEvents}` and can fast-forward through any events it missed (play them with reduced `t` gaps). This works but needs deliberate UX.
3. **Cloudflare + WebSockets interaction.** Usually fine, but free-plan CF has a 100-second idle timeout on WS and will kill zombie connections. Mitigation: 20-second heartbeat. Verify in Phase 2.
4. **Babel-standalone in the browser vs. a Node reducer module.** ES module with plain JS (no JSX) for `engine.js` works in both environments without a bundler. Confirm in Phase 1 with a smoke test — importing a `.js` module from a Babel-standalone `<script>` tag requires `type="module"` on the module itself, not on the Babel script.
5. **Animation timing assumptions.** `MOVE_MS=220`, `SETTLE_MS=40`, drop `90ms` are currently interleaved with game logic. After refactor, they become animator-only concerns. If the user tweaks these later, nothing about the protocol changes — good property to preserve.
6. **Single-VPS SPoF.** Restart = lost in-flight games. Acceptable at casual scale. Mitigation: SQLite snapshot per move (sub-millisecond) makes restart-resume possible if it ever matters.
7. **Cheating / griefing.** Server-authoritative already blocks illegal moves. No anti-cheat concerns for a game with zero stakes. Grief vector: sitting idle to run down opponent's clock. Mitigation (future): optional per-move timer.
8. **Keyboard controls.** Currently P1=arrows, P2=A/D. Online, both players use arrows+Enter on their own keyboard. Trivial change but easy to forget.
9. **Edit-mode postMessage integration.** The app currently expects to be iframed in an editor and broadcasts tweak changes upstream. Multiplayer doesn't touch this, but be aware the same code path fires — ensure lobby/game UI doesn't trigger spurious `__edit_mode_set_keys` messages.

---

## Critical Files for Implementation

- `/Users/abu/Desktop/claude_playground/personal/congkak-claude-design/Congkak.html` — the entire app; Phase 1 refactor lives here. Key ranges: state slots 1057–1089, `playMoveV2` 2041–2238, `playMoveParallel` 2242+ , helpers `sowPath`/`isOwnSide`/`opposite`/`playerHasMoves` 923–958.
- `/Users/abu/Desktop/claude_playground/personal/congkak-claude-design/INDEX.md` — keep updated as the code splits; the line-range map is load-bearing for anyone (human or agent) touching this codebase.
- `/Users/abu/Desktop/claude_playground/personal/congkak-claude-design/engine.js` — **new file** to be created in Phase 1. Pure reducer module, shared by browser and Node server.
- `/opt/congkak-server/server.js` — **new file on OVH VPS** created in Phase 2. Node + `ws`, imports `engine.js`.
- `/etc/nginx/sites-available/congkak` (or equivalent) — **existing nginx config on OVH**, extend with `location /ws { ... }` block in Phase 2.
