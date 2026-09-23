# Notion Media Library

[![CI](https://github.com/jason7773/notion-media-library/actions/workflows/ci.yml/badge.svg)](https://github.com/jason7773/notion-media-library/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Live Demo](https://img.shields.io/badge/demo-online-brightgreen.svg)](https://notion-based-vedio-music-web.web.app/)

A deployable React media library backed by Notion data sources and Firebase.
The app reads music albums, FLAC tracks, movies, posters, subtitles, and
temporary Notion file URLs through a Firebase HTTP Function so the Notion token
never reaches the browser.

## Live Demo and Release Status

- **Live Demo: <https://notion-based-vedio-music-web.web.app/>**
- **Public source: <https://github.com/jason7773/notion-media-library>**

As of 2026-09-24, the public repository, MIT license, GitHub Actions CI, and Firebase Demo are online. The current release passed CI, 37 local tests, and a production build; the live Demo was also verified to load and play two albums and two videos.

The Demo requires no sign-in and reads separate public Notion data sources. It is not a mirror of the private library. Guest progress, preferences, wishlist entries, and issue reports stay in the browser; the private catalog, admin tools, and Firestore data still require an invited Google account.

Dependency audit status: the root/frontend `npm audit` reports zero known vulnerabilities. Functions still reports eight moderate findings, all in the transitive `uuid` chain below `firebase-admin`, with no critical or high findings. `firebase-functions` 7.2.5 does not yet support `firebase-admin` 14, so the project keeps a supported peer combination instead of forcing an incompatible major upgrade and will update when upstream support is available.

```text
Browser
   | Firebase Auth token / session cookie
   v
Firebase Hosting + React/Vite
   | /api
   v
Cloud Function -> Notion API -> Notion files
        |
        +-> Firestore (users and private activity)
```

The browser receives short-lived Notion file URLs for playback. Music and video
bytes are downloaded directly from Notion, while covers are resized to cached
WebP thumbnails by the Function. WebVTT subtitles are proxied by the Function so
the video player can load them consistently.

## Features

- Firebase Authentication gate with admin-approved Google sign-in.
- Admin bootstrap through `ADMIN_EMAILS`.
- Admin dashboard for users, invites, feature flags, video access, watch
  progress, watch events, and wishlist review.
- Music library with album/song search, genre/year filters, queue management,
  shuffle/repeat, Media Session support, keyboard-friendly playback, and FLAC
  metadata inspection.
- Video library with movie search, genre/year filters, series grouping, MP4
  playback, WebVTT subtitle tracks, watch progress resume/reset, watch event
  logging, issue reports, recently added rows, and user wishlist requests.
- Per-user video access control by all videos, selected videos, selected
  series, or a custom mix.
- Optional Google Analytics page and playback events through
  `VITE_GA_MEASUREMENT_ID`.
- Guest Demo uses the same music/video browsing and player UI, backed by
  separate Demo Music and Demo Video data sources.
- Demo catalog responses expose only controlled `/api/demo/**` asset paths,
  not raw temporary Notion media or cover URLs.
- Demo progress, preferences, wishlist, and issue reports stay in versioned
  browser storage and are clearly marked as local-only; no admin console is
  exposed to guests.

The public code repository contains no media library, Notion token, Firebase
project binding, or private user data. Use only media that you own or are
licensed to redistribute when creating a showcase.

## Stack

- React 19, Vite 8, Tailwind CSS 4.
- Firebase Hosting, Firebase Auth, Firestore, Cloud Functions v2.
- Firebase Admin SDK on the backend.
- Notion API data sources.
- `sharp` for cover/poster thumbnail generation.
- Node test runner for backend catalog/auth tests.

## Notion Music Setup

Create a music data source with these property names:

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `Name` | Title | Yes | Album title. |
| `Artist` | Text | Yes | Album artist. |
| `Year` | Number | No | Used for sorting/filtering. |
| `Genre` | Select | No | Used for filtering. |
| `Cover` | Files | No | First file is used as the album cover. |

Each row is an album page. Upload tracks directly into the album page in
playback order. Supported track blocks:

- Notion `audio` blocks.
- Notion `file` blocks whose names end with `.flac`.

## Notion Video Setup

Create a video data source and share it with the same Notion integration.

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `Name` | Title | Yes | Movie or video title. |
| `Year` | Number | No | Used for sorting/filtering. |
| `Genre` | Select or multi-select | No | First value is also exposed as `genre`. |
| `Series` | Select or text | No | Used for grouped movie collections. |
| `Series Order` | Number | No | Used to order videos inside a series. |
| `Cover` | Files | No | First file is used as the poster. |
| `Video` | Files | Yes | First file should be browser-playable, usually MP4. |
| `Vedio` | Files | Legacy | Still accepted as a misspelled fallback. |
| `Subtitles` | Files | No | `.vtt` files only. |
| `Audio Language` | Select or text | No | Display metadata. |
| `Runtime` | Number | No | Runtime in minutes. |
| `Status` | Select | No | Display metadata. |

Use MP4 or WebM for browser playback. Do not use MKV as the direct browser
source; keep MKV as the archival source and generate MP4/WebM or HLS/DASH for
the app. Subtitle files should be WebVTT (`.vtt`).

## Firebase Setup

Enable these Firebase services:

- Hosting
- Cloud Functions
- Authentication with admin-approved Google sign-in
- Firestore
- Secret Manager access for the Function runtime

Add the live Hosting domain, preview channel domains, and localhost to Firebase
Authentication authorized domains before testing Google login.

The normal UI exposes admin-approved Google sign-in. Password accounts can be
provisioned by the admin API, but there is no password sign-in screen. Guests
see the same library UI as private users, but only published items from the
separate Demo data sources. No anonymous Firebase account is created. Approved
Google accounts switch into the private library; other sign-ins stay in Demo.

## Environment Variables

Copy `.env.example` for local Vite development and fill in real values:

```dotenv
NOTION_TOKEN=ntn_replace_me
NOTION_DATA_SOURCE_ID=replace_with_music_data_source_id
NOTION_VIDEO_DATA_SOURCE_ID=replace_with_video_data_source_id
NOTION_DEMO_MUSIC_DATA_SOURCE_ID=
NOTION_DEMO_VIDEO_DATA_SOURCE_ID=
# Optional compatibility fallback for the former single Demo Media source.
NOTION_DEMO_DATA_SOURCE_ID=
ALLOWED_ORIGINS=http://localhost:5173
ADMIN_EMAILS=you@example.com

VITE_FIREBASE_API_KEY=replace_me
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project
VITE_FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=replace_me
VITE_FIREBASE_APP_ID=replace_me
VITE_GA_MEASUREMENT_ID=
```

For deployed Functions, store the Notion token as a secret:

```bash
firebase functions:secrets:set NOTION_TOKEN
```

The Firebase CLI prompts for non-secret function params such as
`NOTION_DATA_SOURCE_ID`, `NOTION_VIDEO_DATA_SOURCE_ID`, `ALLOWED_ORIGINS`, and
`ADMIN_EMAILS` during deployment. Local examples for those values also live in
`functions/.env.example`.

Set `ALLOWED_ORIGINS` to the exact Hosting and preview origins used by your
deployment. The default only permits localhost.

Upgrades may keep the former `NOTION_DEMO_DATA_SOURCE_ID` single-source Demo
Media schema. It is used only when the matching dedicated Demo Music or Demo
Video ID is empty; dedicated sources always take precedence.

## Local Development

Install Node.js 22 or later for both the frontend workspace and Functions.

```bash
npm install
npm --prefix functions install
npm test
npm run dev
```

Vite serves the React app and mounts local `/api` handlers from
`functions/server/*`, so local development uses the same route handlers as the
deployed HTTP Function.

Useful scripts:

```bash
npm run dev      # Start Vite with local API middleware
npm test         # Run node --test
npm run build    # Build the frontend into dist/
npm run preview  # Preview the production build locally
npm run deploy   # Build and deploy Firebase Hosting + Functions
```

## Deploy

Cloud Functions deployment may require a Firebase project with billing enabled.

```bash
npm install -g firebase-tools
firebase login
firebase use --add
npm install
npm --prefix functions install
firebase functions:secrets:set NOTION_TOKEN
npm run deploy
```

For risky Auth, Firestore, or access-control changes, deploy Functions first,
then deploy Hosting to a preview channel and validate sign-in/API behavior
before promoting to live. See [docs/architecture.md](docs/architecture.md) for
the trust boundaries and deployment profiles.

## API Routes

All content routes require an authenticated approved user in normal mode.
Demo routes are public and read-only; private content routes still require an
approved Firebase session. Music routes require `music`; video routes require
`video`.

```text
POST   /api/session
DELETE /api/session
GET    /api/me

GET    /api/demo/albums
GET    /api/demo/library
GET    /api/demo/playlist/:albumId
GET    /api/demo/track/:albumId/:blockId
GET    /api/demo/track-info/:albumId/:blockId
GET    /api/demo/cover/:albumId
GET    /api/demo/videos
GET    /api/demo/video/:pageId
GET    /api/demo/video-stream/:pageId
GET    /api/demo/video-cover/:pageId
GET    /api/demo/video-subtitle/:pageId/:subtitleIndex

GET    /api/albums
GET    /api/library
GET    /api/cover/:pageId?size=96|256|512
GET    /api/playlist/:pageId
GET    /api/track-info/:pageId/:blockId

GET    /api/videos
GET    /api/video/:pageId
GET    /api/video-cover/:pageId?size=96|256|512
GET    /api/video-subtitle/:pageId/:subtitleIndex

GET    /api/watch-progress/:videoId
PUT    /api/watch-progress/:videoId
DELETE /api/watch-progress/:videoId
POST   /api/watch-events

GET    /api/wishlist
POST   /api/wishlist
PATCH  /api/wishlist/:wishId
POST   /api/video-reports

GET    /api/admin/users
POST   /api/admin/users
PATCH  /api/admin/users/:uid
GET    /api/admin/watch-progress
GET    /api/admin/watch-events
GET    /api/admin/wishlist
PATCH  /api/admin/wishlist/:wishId
PATCH  /api/admin/wishlist:batch
GET    /api/admin/video-reports
PATCH  /api/admin/video-reports/:reportId
GET    /api/admin/audit-logs
```

`/api/library` intentionally omits temporary Notion file URLs. Selecting a song
requests that album's playlist first so playback uses fresh signed URLs.

`/api/track-info/:pageId/:blockId` reads FLAC STREAMINFO and Vorbis comments
for one selected track and returns sample rate, bit depth, channel count,
duration, file size, estimated bitrate, and embedded tags.

## Firestore Collections

The backend uses these collections:

- `users`: approved user profiles, roles, provider restrictions, feature flags,
  and content access.
- `invites`: pending Google-only invites for emails that do not have Firebase
  Auth users yet.
- `watchProgress`: latest per-user progress by video and retained for resume state.
- `watchEvents`: video playback events with basic request metadata.
- `watchEvents` are pruned to a 7-day retention window.
- `wishlist`: user-submitted video/content requests and admin review status.
- `videoReports`: user-submitted playback, subtitle, and metadata issue reports.
- `adminAuditLogs`: admin actions for wishlist, report, and user changes.

`watchProgress` is durable product state for resume playback and is not pruned
by the retention job. `watchEvents` are analytics/security records and are
pruned after 7 days from the write path.

## Backup and Recovery

Enable Firestore Point-in-Time Recovery or scheduled exports before running
destructive admin operations at scale. The app does not fabricate deleted user
progress; if `watchProgress` is removed and no Firebase-side backup/export
exists, the old resume state cannot be reconstructed safely.

The first signed-in email matching `ADMIN_EMAILS` is bootstrapped as an admin.
Admins can then add users and adjust access from the dashboard.

## Notes

- Notion file URLs expire. The app refreshes playlists and selected videos on
  demand instead of storing long-lived media URLs.
- Covers and posters are cached aggressively with a version query derived from
  Notion `last_edited_time`.
- Watch progress is also mirrored to `localStorage` for quicker resume behavior
  before Firestore responds.
- Keep `ALLOWED_ORIGINS` explicit for production so credentialed API routes are
  not exposed to arbitrary origins.

## Same-site Demo deployment

Create separate Demo Music and Demo Video data sources and share both with the
Notion integration. Copy the production music schema for Demo Music and the
production video schema for Demo Video, adding a required `Published` checkbox
to each. Use distinct IDs from both private data sources. A published music
album exposes the album and all supported audio blocks on its page; published
video rows expose the video, cover, and WebVTT subtitles. Each Demo source is
optional, and an unset source appears as an empty section in the shared UI.

Guests can browse and play without signing in. Local progress, preferences,
wishlist entries, and issue reports remain in versioned browser storage and do
not reach Firestore or an administrator. Only approved Google accounts switch
into the private catalog.

The Function has a default instance cap and an IP-based per-demo read limit to
reduce accidental cost spikes. Treat these as a baseline: monitor billing and
tune the limits for any public deployment. Demo content is changed in Notion,
so publishing or removing a row does not require another deployment.

This mode still uses Notion as the media source. Notion temporary file URLs are
refreshed on demand, and Firebase Functions, Firestore, Hosting, and network
transfer can still incur usage charges.

## License

The source code is released under the MIT License. Media, fonts, logos, and
sample data have their own rights and are not covered by the code license.
