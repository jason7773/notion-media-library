# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A deployable React media library (music albums with FLAC tracks, movies with subtitles) backed by Notion data sources and Firebase. All Notion API access goes through a single Firebase HTTP Function so the Notion token never reaches the browser. The browser receives short-lived signed Notion file URLs for playback.

```
Notion data sources → Firebase HTTP Function (/api) → React + Vite frontend (Firebase Hosting)
```

## Commands

```bash
npm install          # frontend deps (functions/ has its own npm install)
npm run dev          # Vite dev server with local /api middleware
npm test             # node --test (runs test/*.test.js)
node --test test/catalog.test.js   # run a single test file
npm run build        # build frontend into dist/
npm run preview      # preview production build
npm run deploy       # build + firebase deploy (Hosting + Functions)
```

Frontend and Functions require Node 22. Local dev needs a local environment file copied from the example, with the Notion token, data source IDs, and Firebase client config.

## Architecture

### Backend — one HTTP Function, shared handler modules

- `functions/index.js` — the single Cloud Function `api` (us-central1). It is a hand-rolled router: a chain of `path.match(...)` regexes dispatching to handler functions. New API routes are added here **and** in `vite.config.js` (see below).
- `functions/server/handlers.js` — content routes: albums, library, playlist, covers (resized to WebP via `sharp`), videos, subtitles (proxied WebVTT), FLAC track-info.
- `functions/server/auth.js` — everything user/session/Firestore: session cookie auth, `/api/me`, admin user CRUD, watch progress/events, wishlist, video reports, audit logs. Exports the guard helpers `requireAuthenticatedUser`, `requireFeature`, `requireAdmin`, `filterVideosForUser`, `ensureVideoAllowed`.
- `functions/server/notion.js` — Notion API client with retry and in-memory TTL caches (`cache.js`).
- `functions/server/catalog.js` — pure mappers from Notion page/block JSON to app objects (`mapAlbum`, `mapVideo`, `mapTracks`, …). This is what most tests target.
- `functions/server/flac.js` — range-request FLAC STREAMINFO/Vorbis-comment parser.

### Local dev API mirrors production

`vite.config.js` mounts the same `functions/server/*` handlers as Express-style middleware under `/api`, so local dev and the deployed Function share route logic. **When adding a route, update both `functions/index.js` and `vite.config.js`** — they have drifted before (e.g. video-reports and audit-logs admin routes exist only in `functions/index.js`).

### Frontend — single-file app

`src/App.jsx` (~4,500 lines) contains the entire UI: auth gate, music library/player, video library/player, and admin dashboard. There is no component file structure; expect to navigate this one file. `src/firebase.js` holds Firebase client init.

### Auth and access-control model

- Google sign-in only; Firebase ID token is exchanged for a session cookie via `POST /api/session`.
- Users must exist in the Firestore `users` collection (admin-approved). First sign-in matching `ADMIN_EMAILS` is bootstrapped as admin.
- Per-user feature flags: music routes require the `music` flag, video routes the `video` flag.
- Per-user video access: all videos / selected videos / selected series / custom mix — enforced server-side by `filterVideosForUser` / `ensureVideoAllowed`.

### Key data behaviors

- Notion file URLs expire. `/api/library` deliberately omits media URLs; playing a song fetches that album's `/api/playlist/:pageId` for fresh signed URLs, and videos are re-fetched on select.
- Covers/posters are cached aggressively with a version query derived from Notion `last_edited_time`.
- `watchProgress` (Firestore) is durable resume state — never pruned. `watchEvents` are analytics records pruned after 7 days from the write path. Watch progress is also mirrored to `localStorage`.
- The Notion video property `Vedio` (misspelled) is an intentional legacy fallback for `Video` — do not "fix" it.

### Firestore collections

`users`, `invites`, `watchProgress`, `watchEvents`, `wishlist`, `videoReports`, `adminAuditLogs`. Composite indexes live in `firestore.indexes.json`.

## Configuration

- Frontend env vars are `VITE_*` prefixed (Firebase client config, optional `VITE_GA_MEASUREMENT_ID`).
- Backend: `NOTION_TOKEN` is a Functions secret (`firebase functions:secrets:set NOTION_TOKEN`); `NOTION_DATA_SOURCE_ID`, `NOTION_VIDEO_DATA_SOURCE_ID`, `ALLOWED_ORIGINS`, `ADMIN_EMAILS` are Functions string params (local examples in `functions/.env.example`).
- Set ALLOWED_ORIGINS to exact deployment origins. The public Demo uses a separate Notion data source and remains read-only without creating anonymous accounts.

## Deploy notes

- Requires a Firebase Blaze-plan project; Hosting rewrites `/api/**` to the `api` function.
- For risky Auth/Firestore/access-control changes: deploy Functions first, then Hosting to a preview channel, validate sign-in/API behavior, then promote to live.
