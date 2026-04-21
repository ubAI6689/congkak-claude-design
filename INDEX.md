# Congkak.html — structure index

Single-file React app (React 18 UMD + Babel standalone via CDN). Use `Read` with `offset`/`limit` on the ranges below instead of reading the whole file.

Pure game helpers live in **`engine.js`** (classic script, attaches to `window.CongkakEngine`, also `require`-able in Node). As of Phase 1 commit 1, the helpers `makeInitialBoard`, `sowPath`, `isOwnSide`, `opposite`, `playerHasMoves` moved there. The line ranges below reflect the post-extraction file.

## High-level layout

| Range | Section |
|---|---|
| 1–12 | `<head>` — fonts, React/Babel CDNs |
| 13–805 | `<style>` — all CSS |
| 810–818 | `TWEAK_DEFAULTS` (editable in-place block) |
| 820–2291 | `<script type="text/babel">` — app code |
| 2289–2291 | Mount (`ReactDOM.createRoot`) |

## CSS (inside `<style>` at 13–805)

| Range | Block |
|---|---|
| 14–34 | `:root` OKLCH palette + shared tokens |
| 35–42 | base `html/body/#root` |
| 44–61 | `.stage` (grid + paper noise) |
| 63–100 | `.topbar`, `.wordmark`, `.btn` variants |
| 102–107 | `.arena` |
| 109–164 | `.board-wrap` + shake + `.board` wood + grain |
| 166–187 | `.grid` + `.rumah-slot` + `.middle-grid` |
| 189–250 | `.hole` + `.playable` / `.active` / `.capture-flash` |
| 252–291 | `.rumah` + `.mine` / `.win` |
| 293–308 | `.side-label` |
| 310–355 | `.seed`, `.seed.dropping`, `.seed-count` (hole + rumah variants) |
| 353–355 | `.seed-bed` container |
| 357–420 | `.player-panel` + `.avatar` / `.player-name` / `.player-score` |
| 422–434 | `.turn-dot` pulse |
| 436–449 | `footer.bottombar` |
| 451–500 | `.overlay` + `.modal` |
| 502–516 | `.celebration` + `.confetti` |
| 518–543 | `.flying-seed` + `flyToHouse` keyframes |
| 544–614 | `.hand`, `.hand.flipped`, `.hand.ghost`, `.hand-svg`, `.hand-seeds` |
| 615–617 | `.sowing` cursor override |
| 618–743 | `.tweaks-panel` + children (buttons, swatches, slider) |
| 745–773 | `.announce` |
| 775–791 | `.turn-banner` |
| 793–804 | `@media (max-width: 760px)` mobile layout |

## JS — top-level helpers (820–958)

| Range | Symbol |
|---|---|
| 821 | React destructure (`useState`, `useEffect`, `useRef`, `useCallback`, `useMemo`) |
| 823–831 | `getCtx()` — lazy AudioContext |
| 833–858 | `sfxDrop()` |
| 860–874 | `sfxCapture()` |
| 876–889 | `sfxRumah()` |
| 891–905 | `sfxWin()` |
| — | `makeInitialBoard`, `sowPath`, `isOwnSide`, `opposite`, `playerHasMoves` — moved to **`engine.js`**. Destructured from `window.CongkakEngine` near the top of the Babel script. |

## JS — components (961–1053)

| Range | Symbol |
|---|---|
| 961–985 | `SeedsInHole({ count, seeds })` — renders up to 28 seeds, then shows `×N` badge |
| 988–1003 | `generateSeedLayout(n, seedGen)` — spiral positions |
| 1006–1012 | `seedRandomFactory(base)` — deterministic PRNG per hole |
| 1014–1037 | `Hole` component |
| 1039–1053 | `Rumah` component |

## JS — `App` component (1056–2287)

### State (1057–1089)

| Line | State |
|---|---|
| 1057 | `tweaks` (from `window.TWEAK_DEFAULTS`) |
| 1058–1061 | `seedsPerHole`, `seedColor`, `seedSize`, `startStyle` |
| 1062 | `roundMoveCount` (unused?) |
| 1063 | `board` — `{holes[14], rumah[2]}` |
| 1064 | `currentPlayer` (0 = bottom, 1 = top) |
| 1065 | `activeHole` |
| 1066 | `captureFlashes` (Set) |
| 1067 | `isAnimating` |
| 1068 | `boardShake` |
| 1069 | `animKey` (forces seed re-layout on reset) |
| 1070 | `showRules` (true on first load) |
| 1071 | `showTweaks` |
| 1072 | `announce` |
| 1073 | `winner` |
| 1074 | `confetti` |
| 1075 | `lastAction` (footer status text) |
| 1076 | `rumahFlash` (Set) |
| 1077 | `hand` — single hand for alternating mode |
| 1078 | `hands` — per-player hands for simultaneous mode |
| 1079 | `flyingSeeds` |
| 1081 | `cursorHole` — `{0, 1}` keyboard cursor per player |
| 1082 | `boardWrapRef` |
| 1084 | `boardRef` — authoritative board in simultaneous mode |
| 1085 | `handAtRef` — current stop per hand (collision detection) |
| 1086 | `busyRef` — whether each coroutine is sowing |
| 1087–1088 | `phase` / `phaseRef` — `'opener-sim' \| 'alternating'` |
| 1089 | `abortRef` — bumped on reset to cancel in-flight coroutines |

### Methods & effects

| Range | Symbol |
|---|---|
| 1092–1108 | `positionFor(stop)` — DOM-measured px coords |
| 1111–1120 | Effect: edit-mode postMessage wiring |
| 1123–1152 | Effects: persist `seedsPerHole / seedColor / seedSize / startStyle` to parent |
| 1154–1164 | Effect: announce turn change (alternating only) |
| 1167–1173 | `p0Row` / `p1Row` — visual L→R index order |
| 1175–1178 | `playableForPlayer(p)` |
| 1180–1188 | `canPlayerAct(p)` |
| 1190–1212 | `moveCursor(p, dir)` |
| 1214–1225 | `commitCursor(p)` |
| 1228 | `playMoveSafeRef` |
| 1230–1245 | Effect: auto-place / clear keyboard cursor |
| 1247–1293 | Effect: global keydown handler (P1=arrows+Enter, P2=A/D+Space) |
| 1295–1324 | `resetGame(sph?, styleOverride?)` |
| 1326–1329 | `changeSeeds(n)` |
| 1332–1335 | `announceText(txt, durationMs)` |
| 1338–1353 | `burstConfetti()` |
| 1356–1483 | **`playMove` (LEGACY — dead code, superseded by `playMoveV2`)** |
| 1488–1489 | `lastRumahRef` / `lastActionWasRumah` (legacy remnants) |
| 1497 | `sleep(ms)` |
| 1502–1534 | Render variables: ranges, active/playable flags, `SEED_PALETTES`, `stageStyle` |

### JSX render (1536–1838)

| Range | Element |
|---|---|
| 1538–1547 | `<header>` topbar — rules/tweaks/new-round buttons |
| 1549–1696 | `.board-wrap` + arena |
| 1551–1565 | Alternating-mode hand (single) |
| 1567–1580 | Simultaneous-mode hands (per player) |
| 1582–1600 | Ghost cursor hands (keyboard) |
| 1601–1615 | Flying seeds (capture animation) |
| 1617–1626 | Top player panel (rotated) |
| 1628–1638 | Bottom player panel |
| 1640–1694 | `.board` + grid (rumah-slot, middle-grid, rumah-slot) |
| 1698–1707 | `<footer>` status bar |
| 1710 | Announce layer |
| 1712–1725 | Confetti |
| 1728–1752 | Rules overlay modal |
| 1754–1778 | Winner overlay modal |
| 1781–1836 | Tweaks panel |

### Move engines (1841–2286)

| Range | Symbol |
|---|---|
| 1841–1848 | `playMoveSafe(startHole)` — dispatcher (routes to V2 or Parallel) |
| 1850 | Effect: keep `playMoveSafeRef` fresh |
| 1853–2050 | **`playMoveV2(startHole)`** — alternating-mode engine (hand animation, sowing loop, tikam rule, end-of-round, next-player logic). Tikam requires `passedOwnRumah`. |
| 2054–2262 | **`playMoveParallel(p, startHole)`** — simultaneous-opener engine (concurrent coroutines, `boardRef` authority, collision detection via `waitForPath`, transition to alternating) |
| 2087–2103 | `waitForPath(targetStop)` — collision wait w/ bump |
| 2265–2270 | `sameStop(a, b)` |
| 2273–2286 | `sfxBump()` |

## Key constants & rules

- **Board**: 14 holes + 2 rumah. P0 owns 0–6 (bottom), P1 owns 7–13 (top). Rumah[0] sits left; Rumah[1] sits right.
- **Sowing direction**: clockwise — bottom 0→6 → rumah[0] → top 7→13 → rumah[1] → back to 0.
- **Tikam (capture)**: last seed lands on empty hole on own side AND player has passed own rumah ≥ 1× this turn → capture opposite + last.
- **Another turn**: last seed in own rumah.
- **Mati**: last seed in empty opponent hole.
- **Animation timings**: `MOVE_MS=220`, `SETTLE_MS=40`, drop settle `90ms` (V2/Parallel).
- **Tweak defaults block**: `seedsPerHole`, `seedColor`, `seedSize`, `startStyle` at lines 812–817 (editable live via Tweaks panel).
- **Edit-mode integration**: postMessage to `window.parent` with `__edit_mode_available` / `__edit_mode_set_keys` — app expects to be iframed in an editor.

## Known dead/legacy code

- `playMove` (1356–1483) and `lastRumahRef` (1488–1489) are superseded by `playMoveV2`. Safe to delete in a cleanup pass.
