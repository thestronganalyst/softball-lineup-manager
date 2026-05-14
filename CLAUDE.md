# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

There is no build system, no package manager, and no test suite. The app is a single static `index.html` plus one Cloudflare Pages Function (`functions/api/data.js`).

- **Pure-static preview** (no cloud persistence): open `index.html` in a browser or use a static server. The app will fail to reach `/api/data`, show the save status as `offline`, and operate from localStorage only — fine for visual tweaks, not for testing the data round-trip.
- **Full local dev with R2 emulation**: `npx wrangler pages dev .` (uses `wrangler.toml`, emulates R2 locally). The function will serve `/api/data` against a local R2 emulator.
- **Production**: deployed to Cloudflare Pages. `main` → auto-deploy.

Reset to seeded defaults by clearing the `softball_v5` localStorage key in DevTools **and** deleting `data.json` from the R2 bucket.

## Architecture

Everything client-side lives in `index.html`: CSS in `<style>`, markup, then a single `<script>` block (~1150 lines, starting around line 698) that owns all behavior. There are no modules, no framework, no bundler. The only backend is `functions/api/data.js`, a ~30-line Pages Function that proxies a single JSON file in R2.

### State model

A single global `S` (initialized around `index.html:735`) is the source of truth. Its shape is documented in `index.html` near the STATE comment block:

```
S = { seasons:[{id,name}], teams:[{id,seasonId,name,roster,games}], activeSeasonId, activeTeamId }
player = {id, name, jersey, primaryPos, isSub, priorities:{posId:1|2|3}}
game   = {id, name, date, opponent, location, presentPlayers, battingOrder, lineup:{inn:{posId:pid|null}}}
```

`activeGameId` is a separate module-scoped variable (not persisted in `S`). Position ids come from the `FIELD_POS` and `BENCH_POS` constants — code everywhere assumes 9 field slots + 5 bench slots and 5 innings (`INNINGS=[1,2,3,4,5]`). Changing those constants ripples through validation, auto-populate, CSV export, and rendering.

### Persistence — cloud + offline cache

`persist()` and `loadStateCloud()`/`loadStateLocal()` (around `index.html:760-810`) implement a two-tier scheme:

- **Authoritative store**: R2 object `data.json`, accessed via `GET /api/data` and `PUT /api/data` — `POST` also writes (the Pages Function exposes both `onRequestPut` and `onRequestPost` as writers, e.g. for the `keepalive` unload PUT). The function does no auth itself — it relies on Cloudflare Access at the edge.
- **Offline cache**: `localStorage[softball_v5]` is written synchronously on every `persist()` and read as fallback when the cloud is unreachable.
- **Debounce**: `persist()` schedules a single PUT after `SAVE_DEBOUNCE_MS` (800ms) of idle. Rapid mutations (drag-drop, typing) collapse into one network write.
- **Flush on unload**: `beforeunload` fires a `keepalive: true` PUT so an unflushed timer doesn't lose the last edit.
- **Save status**: `setSaveStatus()` updates the colored dot in the header (`#saveStatus`) — `saving` / `saved` / `error` / `offline`.

**Concurrency caveat**: last-write-wins. Two users editing simultaneously will clobber each other. Acceptable for the current 1-4 user audience; revisit with ETag/If-Match on PUT if scope grows.

### Mutation → persist → render loop

The convention throughout is: mutate `S` directly, then call `persist()` (writes cache immediately + debounces a cloud PUT), then call a render function (`renderAll()` or a focused `renderX()`). No reactivity — if you mutate state without rendering, the UI goes stale.

Rendering writes HTML strings into known container ids (`rosterCards`, `fieldSlots`, `benchSlots`, `valBar`, etc.). Event handlers are wired via inline `onclick=` / `ondrop=` attributes, so the functions they reference (`savePlayer`, `dDrop`, `togglePresent`, …) must remain on the global scope. Don't refactor them into IIFEs/modules without rewriting the markup.

### Auto-populate + the bench rule

The core domain logic is the bench-consecutive rule and the auto-populate algorithm:

- **Rule**: a player on the bench in inning N cannot be on the bench in inning N+1. Enforced in three places that must stay in sync: `benchConsec()`, the drag-drop guard in `dDrop()`, and `renderVal()` which lists violations in the warning bar.
- **Auto-populate** (`autoInning`): greedy assignment. Each (player, position) pair is scored by `score()` — priority 1=100, 2=60, 3=30, no priority=5. Players who were benched the previous inning get a +200 boost (`mustPlay`). Field slots are filled in priority order, then leftovers fill bench slots. Intentionally greedy, not globally optimal.

### Pages and modals

Two top-level pages, switched by `setPage()` toggling `.active` on `.page` elements: **Roster** (player CRUD with position-priority grid) and **Lineup** (per-game inning planner with drag-and-drop). The Lineup page has a **By Position / By Player** view toggle (`setLineupView`, picking between `byPositionHTML` and `byPlayerHTML` around `index.html:1177-1217`): the by-position view is a positions×innings crosstab; the by-player view transposes to players×innings, with cells draggable to swap positions within an inning. Both views share the same drag-drop guards and validation. Modals are absolute-positioned `.overlay` divs shown/hidden via inline `style.display`; `closeModals()` clears them and an outer click on the overlay also closes.

### Auth (Cloudflare Access)

The app itself does no authentication. Cloudflare Access sits in front of the Pages project and gates both the static site and `/api/*` with an email allowlist (or SSO). The Pages Function receives `Cf-Access-Authenticated-User-Email` on every request if you ever need per-user logic, but currently all authenticated users share the same `data.json`.

### Import / export

`exportAll()` dumps the entire `S` object as JSON; `handleImport()` accepts that same shape and replaces `S` wholesale (validated only by checking for `.seasons` and `.teams` keys). After import, `persist()` will push the new state to the cloud. CSV exports (`exportCSVRoster`, `exportCSVGame`) are one-way and human-readable, not round-trippable.
