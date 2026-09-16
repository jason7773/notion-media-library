import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import { auth, firebaseConfigError, googleProvider } from "./firebase.js";

const DEFAULT_FEATURE_FLAGS = {
  music: true,
  video: true,
  resumePlayback: true,
  beta: false,
};
const DEFAULT_CONTENT_ACCESS = {
  mode: "all",
  videoIds: [],
  series: [],
};
const WISH_TYPE_OPTIONS = [
  ["movie", "Movie"],
  ["feature", "Feature"],
];
const WISH_TYPE_LABELS = Object.fromEntries(WISH_TYPE_OPTIONS);
const WISH_STATUS_OPTIONS = ["new", "reviewing", "planned", "added", "rejected", "cancelled"];
const VIDEO_REPORT_TYPE_OPTIONS = [
  ["broken_video", "Broken video"],
  ["wrong_subtitle", "Wrong subtitle"],
  ["missing_subtitle", "Missing subtitle"],
  ["wrong_metadata", "Wrong metadata"],
  ["other", "Other"],
];
const VIDEO_REPORT_STATUS_OPTIONS = ["new", "reviewing", "fixed", "rejected"];
const AUDIT_TARGET_TYPES = ["wishlist", "videoReport", "user", "invite"];
const WATCH_PROGRESS_PREFIX = "notion-watch-progress";
const NIGHT_MODE_STORAGE_KEY = "notion-library-night-mode";
const MOVIE_PREFS_PREFIX = "notion-movie-prefs";
const WISH_STATUS_PREFIX = "notion-wish-status";
const DEFAULT_MOVIE_PREFS = {
  autoNext: false,
  playbackRate: 1,
  subtitleSize: "medium",
  subtitleTrack: "default",
};
const PLAYBACK_RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 2];
const SUBTITLE_SIZE_OPTIONS = [
  ["small", "Small"],
  ["medium", "Medium"],
  ["large", "Large"],
];
const DUAL_SUBTITLE_TRACK = "dual";
const DIRECT_VIDEO_REFRESH_AFTER_SECONDS = 45 * 60;
const PLAYBACK_STALL_RECOVERY_MS = 8000;
const PLAYBACK_RECOVERY_COOLDOWN_MS = 3000;
const GA_MEASUREMENT_ID = (import.meta.env.VITE_GA_MEASUREMENT_ID || "").trim();
const subtitleTextCache = new Map();

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) {
    return "0:00";
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "Unknown size";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = units[0];
  for (const candidate of units) {
    unit = candidate;
    if (value < 1024 || candidate === units.at(-1)) {
      break;
    }
    value /= 1024;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) {
    return "Unknown runtime";
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function progressStorageKey(uid, videoId) {
  return `${WATCH_PROGRESS_PREFIX}:${uid}:${videoId}`;
}

function readLocalVideoProgress(uid, videoId) {
  if (!uid || !videoId) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(progressStorageKey(uid, videoId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocalVideoProgress(uid, videoId, progress) {
  if (!uid || !videoId) {
    return null;
  }
  const durationSeconds = Number(progress.durationSeconds || 0);
  const positionSeconds = Number(progress.positionSeconds || 0);
  const percent =
    durationSeconds > 0 ? Math.max(0, Math.min(100, (positionSeconds / durationSeconds) * 100)) : 0;
  const nextProgress = {
    ...progress,
    completed: Boolean(progress.completed) || percent >= 92,
    durationSeconds,
    percent,
    positionSeconds,
    savedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(progressStorageKey(uid, videoId), JSON.stringify(nextProgress));
  } catch {
    return nextProgress;
  }
  return nextProgress;
}

function userScopedKey(prefix, uid) {
  return `${prefix}:${uid || "anonymous"}`;
}

function readMoviePrefs(uid) {
  try {
    const raw = window.localStorage.getItem(userScopedKey(MOVIE_PREFS_PREFIX, uid));
    return raw ? { ...DEFAULT_MOVIE_PREFS, ...JSON.parse(raw) } : DEFAULT_MOVIE_PREFS;
  } catch {
    return DEFAULT_MOVIE_PREFS;
  }
}

function writeMoviePrefs(uid, prefs) {
  try {
    window.localStorage.setItem(userScopedKey(MOVIE_PREFS_PREFIX, uid), JSON.stringify(prefs));
  } catch {
    // Ignore localStorage failures and keep the in-memory preferences.
  }
}

function readSeenWishStatuses(uid) {
  try {
    return JSON.parse(window.localStorage.getItem(userScopedKey(WISH_STATUS_PREFIX, uid)) || "{}");
  } catch {
    return {};
  }
}

function writeSeenWishStatuses(uid, wishes) {
  try {
    const statuses = Object.fromEntries(wishes.map((wish) => [wish.id, wish.status || "new"]));
    window.localStorage.setItem(userScopedKey(WISH_STATUS_PREFIX, uid), JSON.stringify(statuses));
  } catch {
    // Ignore localStorage failures; notification badges are best effort.
  }
}

function countChangedWishes(uid, wishes) {
  const seen = readSeenWishStatuses(uid);
  return wishes.filter((wish) => {
    const status = wish.status || "new";
    const previous = seen[wish.id];
    return previous && previous !== status && ["planned", "added", "rejected"].includes(status);
  }).length;
}

function progressTimestamp(progress) {
  return Date.parse(progress?.lastWatchedAt || progress?.updatedAt || progress?.savedAt || 0) || 0;
}

function newestProgress(...items) {
  return items
    .filter(Boolean)
    .sort((a, b) => progressTimestamp(b) - progressTimestamp(a))[0] || null;
}

function formatDateTime(value) {
  if (!value) {
    return "No timestamp";
  }
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) {
    return "No timestamp";
  }
  return date.toLocaleString();
}

function formatDateKey(value) {
  if (!value) {
    return "Unknown";
  }
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toISOString().slice(0, 10);
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item) || "Unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

function uniqueCount(items, keyFn) {
  return new Set(items.map(keyFn).filter(Boolean)).size;
}

function summarizeWatchData(events, progress) {
  const bySession = new Map();
  const byIp = new Map();
  for (const event of events) {
    const sessionKey = event.sessionId || event.id;
    const session = bySession.get(sessionKey) || {
      email: event.email || "Unknown",
      eventCount: 0,
      ipAddress: event.ipAddress || "",
      sessionId: sessionKey,
      videos: new Set(),
    };
    session.eventCount += 1;
    session.videos.add(event.videoId || event.title);
    if (!session.ipAddress && event.ipAddress) {
      session.ipAddress = event.ipAddress;
    }
    bySession.set(sessionKey, session);

    const ipKey = event.ipAddress || "Unknown";
    const ip = byIp.get(ipKey) || {
      eventCount: 0,
      ipAddress: ipKey,
      sessions: new Set(),
      users: new Set(),
    };
    ip.eventCount += 1;
    ip.sessions.add(sessionKey);
    ip.users.add(event.email || event.uid || "Unknown");
    byIp.set(ipKey, ip);
  }

  const anomalyRows = [
    ...[...bySession.values()]
      .filter((item) => item.eventCount >= 20 || item.videos.size >= 5)
      .map((item) => ({
        label: item.email,
        detail: `${item.eventCount} events / ${item.videos.size} videos / ${item.ipAddress || "No IP"}`,
      })),
    ...[...byIp.values()]
      .filter((item) => item.eventCount >= 30 || item.users.size >= 2 || item.sessions.size >= 5)
      .map((item) => ({
        label: item.ipAddress,
        detail: `${item.eventCount} events / ${item.users.size} users / ${item.sessions.size} sessions`,
      })),
  ].slice(0, 8);

  return {
    anomalyRows,
    cards: [
      ["Events", events.length],
      ["Users", uniqueCount(events, (item) => item.uid || item.email)],
      ["IPs", uniqueCount(events, (item) => item.ipAddress)],
      ["Completed", progress.filter((item) => item.completed).length],
    ],
    byDate: countBy(events, (item) => formatDateKey(item.createdAt)).slice(0, 10).reverse(),
    byIp: countBy(events, (item) => item.ipAddress).slice(0, 8),
    byUser: countBy(events, (item) => item.email).slice(0, 8),
    byVideo: countBy(events, (item) => item.title || item.videoId).slice(0, 8),
  };
}

function initAnalytics() {
  if (!GA_MEASUREMENT_ID || typeof window === "undefined") {
    return;
  }
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() {
    window.dataLayer.push(arguments);
  };
  if (!document.querySelector(`script[data-ga-id="${GA_MEASUREMENT_ID}"]`)) {
    const script = document.createElement("script");
    script.async = true;
    script.dataset.gaId = GA_MEASUREMENT_ID;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_MEASUREMENT_ID)}`;
    document.head.appendChild(script);
  }
  if (!window.__notionLibraryGaConfigured) {
    window.gtag("js", new Date());
    window.gtag("config", GA_MEASUREMENT_ID, { send_page_view: false });
    window.__notionLibraryGaConfigured = true;
  }
}

function trackPageView(path, title) {
  if (!GA_MEASUREMENT_ID || typeof window === "undefined" || !window.gtag) {
    return;
  }
  window.gtag("event", "page_view", {
    page_location: `${window.location.origin}${path}`,
    page_path: path,
    page_title: title,
  });
}

function trackAnalyticsEvent(name, params = {}) {
  if (!GA_MEASUREMENT_ID || typeof window === "undefined" || !window.gtag) {
    return;
  }
  window.gtag("event", name, sanitizeAnalyticsParams(params));
}

function sanitizeAnalyticsParams(params = {}) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [
        key,
        typeof value === "string" ? value.slice(0, 100) : value,
      ]),
  );
}

function videoAnalyticsParams(video, extras = {}) {
  return {
    content_type: "video",
    series: video?.series || "standalone",
    video_id: video?.id || "",
    ...extras,
  };
}

function musicAnalyticsParams(track, extras = {}) {
  return {
    album_id: track?.album?.id || "",
    content_type: "music",
    track_id: track?.id || "",
    ...extras,
  };
}

function subtitleAnalyticsValue(subtitle) {
  return subtitle?.srclang || subtitle?.label || subtitle?.name || "off";
}

function formatSampleRate(sampleRate) {
  return sampleRate ? `${(sampleRate / 1000).toFixed(sampleRate % 1000 ? 1 : 0)} kHz` : "Unknown";
}

function subtitleLanguageKey(subtitle = {}) {
  const value = `${subtitle.srclang || ""} ${subtitle.label || ""} ${subtitle.name || ""}`.toLowerCase();
  if (/(zh|chinese|hant|hans|tw|cn|hk|chs|cht|sc|tc)/i.test(value) || /\p{Script=Han}/u.test(value)) {
    return "zh";
  }
  if (/(^|[^a-z])(en|eng|english)([^a-z]|$)/i.test(value)) {
    return "en";
  }
  return "";
}

function findDualSubtitlePair(subtitles = []) {
  const zhIndex = subtitles.findIndex((subtitle) => subtitleLanguageKey(subtitle) === "zh");
  const enIndex = subtitles.findIndex((subtitle) => subtitleLanguageKey(subtitle) === "en");
  if (zhIndex < 0 || enIndex < 0 || zhIndex === enIndex) {
    return null;
  }
  return {
    primary: { ...subtitles[zhIndex], index: zhIndex },
    secondary: { ...subtitles[enIndex], index: enIndex },
  };
}

function parseVttTimestamp(value) {
  const parts = value.trim().replace(",", ".").split(":");
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![hours, minutes, seconds].every(Number.isFinite)) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function stripVttText(text) {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function parseWebVtt(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .flatMap((block) => {
      const lines = block
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean);
      if (!lines.length || /^WEBVTT\b/i.test(lines[0]) || /^(NOTE|STYLE|REGION)\b/i.test(lines[0])) {
        return [];
      }

      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) {
        return [];
      }
      const [startRaw, rest] = lines[timingIndex].split("-->");
      const endRaw = rest?.trim().split(/\s+/)[0];
      const start = parseVttTimestamp(startRaw);
      const end = parseVttTimestamp(endRaw || "");
      const cueText = stripVttText(lines.slice(timingIndex + 1).join("\n"));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !cueText) {
        return [];
      }
      return [{ end, start, text: cueText }];
    });
}

function activeCueText(cues, currentTime) {
  return cues.find((cue) => currentTime >= cue.start && currentTime <= cue.end)?.text || "";
}

function formatVttTimestamp(value) {
  const safeValue = Math.max(0, Number(value) || 0);
  const hours = Math.floor(safeValue / 3600);
  const minutes = Math.floor((safeValue % 3600) / 60);
  const seconds = Math.floor(safeValue % 60);
  const milliseconds = Math.round((safeValue - Math.floor(safeValue)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function buildMergedWebVtt(primaryCues, secondaryCues) {
  const boundaries = [...primaryCues, ...secondaryCues]
    .flatMap((cue) => [cue.start, cue.end])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const uniqueBoundaries = boundaries.filter((value, index) => index === 0 || Math.abs(value - boundaries[index - 1]) > 0.001);
  const lines = ["WEBVTT", ""];

  for (let index = 0; index < uniqueBoundaries.length - 1; index += 1) {
    const start = uniqueBoundaries[index];
    const end = uniqueBoundaries[index + 1];
    if (end - start < 0.05) {
      continue;
    }
    const sampleTime = start + Math.min(0.02, (end - start) / 2);
    const primary = activeCueText(primaryCues, sampleTime);
    const secondary = activeCueText(secondaryCues, sampleTime);
    const text = [primary, secondary].filter(Boolean).join("\n");
    if (!text) {
      continue;
    }
    lines.push(`${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}`);
    lines.push(text);
    lines.push("");
  }

  return lines.join("\n");
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options?.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || "Request failed.");
  }
  return body;
}

async function fetchText(url, options) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options?.headers || {}),
    },
  });
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(body || "Request failed.");
  }
  return body;
}

function Icon({ children, className = "h-5 w-5", viewBox = "0 0 24 24" }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox={viewBox}
    >
      {children}
    </svg>
  );
}

function MusicIcon({ className }) {
  return (
    <Icon className={className}>
      <path d="M9 18V5l10-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="16" cy="16" r="3" />
    </Icon>
  );
}

function FilmIcon({ className }) {
  return (
    <Icon className={className}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 3v18" />
      <path d="M16 3v18" />
      <path d="M4 8h4" />
      <path d="M4 16h4" />
      <path d="M16 8h4" />
      <path d="M16 16h4" />
    </Icon>
  );
}

function PlayIcon({ className = "h-4 w-4 fill-current" }) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 fill-current" viewBox="0 0 24 24">
      <path d="M7 5h4v14H7zm6 0h4v14h-4z" />
    </svg>
  );
}

function PreviousIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 fill-current" viewBox="0 0 24 24">
      <path d="M6 5h2v14H6zm3 7 10 7V5z" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 fill-current" viewBox="0 0 24 24">
      <path d="M16 5h2v14h-2zM5 5v14l10-7z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <Icon className="h-4 w-4">
      <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 5v4h4" />
      <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
    </Icon>
  );
}

function SearchIcon() {
  return (
    <Icon className="h-4 w-4">
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </Icon>
  );
}

function HomeIcon() {
  return (
    <Icon className="h-4 w-4">
      <path d="m4 11 8-7 8 7" />
      <path d="M6 10v9h12v-9" />
    </Icon>
  );
}

function ShuffleIcon() {
  return (
    <Icon className="h-4 w-4">
      <path d="M16 3h5v5" />
      <path d="m4 20 6.5-6.5" />
      <path d="m15 8 6-5" />
      <path d="M4 4h2.5l11 11H21" />
      <path d="M16 20h5v-5" />
    </Icon>
  );
}

function RepeatIcon() {
  return (
    <Icon className="h-4 w-4">
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11V9a3 3 0 0 1 3-3h15" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v2a3 3 0 0 1-3 3H3" />
    </Icon>
  );
}

function QueueIcon() {
  return (
    <Icon className="h-4 w-4">
      <path d="M4 6h11" />
      <path d="M4 12h11" />
      <path d="M4 18h7" />
      <path d="m17 15 4 3-4 3z" />
    </Icon>
  );
}

function MoveUpIcon() {
  return (
    <Icon className="h-3.5 w-3.5">
      <path d="m18 15-6-6-6 6" />
    </Icon>
  );
}

function MoveDownIcon() {
  return (
    <Icon className="h-3.5 w-3.5">
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

function createPlayOrder(trackCount, startIndex = 0, shuffle = false) {
  const indices = Array.from({ length: trackCount }, (_, index) => index);
  if (!shuffle) {
    return indices;
  }

  const remaining = indices.filter((index) => index !== startIndex);
  for (let index = remaining.length - 1; index > 0; index -= 1) {
    const replacement = Math.floor(Math.random() * (index + 1));
    [remaining[index], remaining[replacement]] = [remaining[replacement], remaining[index]];
  }
  return startIndex >= 0 && startIndex < trackCount ? [startIndex, ...remaining] : remaining;
}

function createAlbumQueue(album, tracks, startIndex = 0, shuffle = false) {
  const order = createPlayOrder(tracks.length, startIndex, shuffle);
  return {
    cursor: shuffle ? 0 : startIndex,
    queue: order.map((index) => ({ ...tracks[index], album })),
  };
}

function summarizeTracks(tracks) {
  return tracks.map(({ url, ...track }) => track);
}

const coverSizes = {
  large: "h-44 w-44 rounded-[1.75rem] sm:h-52 sm:w-52",
  small: "h-12 w-12 rounded-2xl",
  mini: "h-12 w-12 rounded-2xl",
  card: "aspect-square w-full rounded-[1.25rem]",
};

const coverWidths = {
  large: 512,
  small: 96,
  mini: 96,
  card: 256,
};

function getCoverUrl(album, size = "large") {
  if (!album?.cover) {
    return null;
  }
  const params = new URLSearchParams({
    size: String(coverWidths[size]),
    v: album.coverVersion || "1",
  });
  return `/api/cover/${encodeURIComponent(album.id)}?${params.toString()}`;
}

function Cover({ album, size = "large" }) {
  const coverUrl = getCoverUrl(album, size);
  const [failed, setFailed] = useState(false);
  const classes = `${coverSizes[size]} relative shrink-0 overflow-hidden bg-gradient-to-br from-[#efd4c0] to-[#c78364] text-[#fff9f2] shadow-[0_16px_36px_rgba(105,73,55,0.16)]`;
  const iconSize = size === "large" ? "h-16 w-16" : "h-6 w-6";

  useEffect(() => {
    setFailed(false);
  }, [coverUrl]);

  if (coverUrl && !failed) {
    return (
      <div className={classes}>
        <MusicIcon className={`absolute top-1/2 left-1/2 ${iconSize} -translate-x-1/2 -translate-y-1/2 opacity-70`} />
        <img
          alt=""
          className="relative z-10 h-full w-full object-cover"
          decoding="async"
          fetchPriority={size === "large" || size === "small" || size === "mini" ? "high" : "auto"}
          loading={size === "card" ? "lazy" : "eager"}
          onError={() => setFailed(true)}
          src={coverUrl}
        />
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      className={`${classes} grid place-items-center`}
    >
      <MusicIcon className={size === "large" ? "h-16 w-16" : "h-6 w-6"} />
    </div>
  );
}

function getVideoCoverUrl(video, size = "large") {
  if (!video?.cover) {
    return null;
  }
  const params = new URLSearchParams({
    size: String(coverWidths[size]),
    v: video.coverVersion || "1",
  });
  return `/api/video-cover/${encodeURIComponent(video.id)}?${params.toString()}`;
}

function MoviePoster({ video, size = "large" }) {
  const coverUrl = getVideoCoverUrl(video, size);
  const [failed, setFailed] = useState(false);
  const classes = `${coverSizes[size]} relative shrink-0 overflow-hidden bg-gradient-to-br from-[#8fb3aa] to-[#b8795d] text-[#fff9f2] shadow-[0_16px_36px_rgba(74,88,84,0.16)]`;
  const iconSize = size === "large" ? "h-16 w-16" : "h-6 w-6";

  useEffect(() => {
    setFailed(false);
  }, [coverUrl]);

  if (coverUrl && !failed) {
    return (
      <div className={classes}>
        <FilmIcon className={`absolute top-1/2 left-1/2 ${iconSize} -translate-x-1/2 -translate-y-1/2 opacity-70`} />
        <img
          alt=""
          className="relative z-10 h-full w-full object-cover"
          decoding="async"
          fetchPriority={size === "large" || size === "small" || size === "mini" ? "high" : "auto"}
          loading={size === "card" ? "lazy" : "eager"}
          onError={() => setFailed(true)}
          src={coverUrl}
        />
      </div>
    );
  }

  return (
    <div aria-hidden="true" className={`${classes} grid place-items-center`}>
      <FilmIcon className={size === "large" ? "h-16 w-16" : "h-6 w-6"} />
    </div>
  );
}

function MovieSidebar({
  genres,
  genre,
  loading,
  onGenre,
  onHome,
  onMode,
  onQuery,
  onSelect,
  query,
  selectedVideo,
  totalVideos,
  videos,
  year,
  years,
  onYear,
}) {
  return (
    <aside className="border-b border-[#dbe3dc] bg-[#fbfaf6]/90 px-4 py-4 backdrop-blur md:row-start-1 md:overflow-hidden md:border-r md:border-b-0 md:px-5 md:py-6">
      <button className="flex w-full items-center gap-3 px-1 pb-4 text-left md:pb-7" onClick={onHome} type="button">
        <span className="grid h-10 w-10 place-items-center rounded-2xl bg-[#4f7f78] text-sm font-black tracking-wide text-[#fffaf4] shadow-[0_9px_22px_rgba(69,110,104,0.2)]">
          NV
        </span>
        <div>
          <strong className="block font-serif text-lg tracking-tight text-[#334742]">
            Notion Video
          </strong>
          <small className="mt-0.5 block text-xs font-semibold tracking-wide text-[#81928d]">
            MP4 with subtitles
          </small>
        </div>
      </button>

      <button
        className="mb-3 flex w-full items-center gap-2 rounded-2xl bg-[#e4eee9] px-3 py-2 text-left text-sm font-bold text-[#4d756f] transition hover:bg-[#d8e7e0]"
        onClick={onHome}
        type="button"
      >
        <HomeIcon />
        Movie home
      </button>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <button
          className="rounded-xl border border-[#d9e2dc] bg-[#fffdf9] px-3 py-2 text-xs font-extrabold tracking-wide text-[#687c77] transition hover:bg-[#eef5f1]"
          onClick={() => onMode("music")}
          type="button"
        >
          Music
        </button>
        <button
          className="rounded-xl bg-[#4f7f78] px-3 py-2 text-xs font-extrabold tracking-wide text-[#fffaf4]"
          type="button"
        >
          Movies
        </button>
      </div>

      <div className="hidden justify-between px-2 pb-3 text-[10px] font-extrabold tracking-[0.2em] text-[#7c938d] uppercase md:flex">
        <span>Movies</span>
        <span>{videos.length} / {totalVideos}</span>
      </div>

      <div className="mb-3 space-y-2">
        <label className="flex items-center gap-2 rounded-2xl border border-[#d9e2dc] bg-[#fffdf9] px-3 py-2 text-[#6e958d]">
          <SearchIcon />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm text-[#405c56] outline-none placeholder:text-[#a6bab4]"
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search movies"
            type="search"
            value={query}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <select className="rounded-xl border border-[#d9e2dc] bg-[#fffdf9] px-2 py-2 text-xs text-[#596f6a]" onChange={(event) => onGenre(event.target.value)} value={genre}>
            <option value="">All genres</option>
            {genres.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select className="rounded-xl border border-[#d9e2dc] bg-[#fffdf9] px-2 py-2 text-xs text-[#596f6a]" onChange={(event) => onYear(event.target.value)} value={year}>
            <option value="">All years</option>
            {years.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 md:block md:max-h-[calc(100vh-172px)] md:overflow-y-auto md:pb-0">
        {loading && <p className="px-2 text-sm text-[#7f958f]">Loading movies...</p>}
        {!loading && videos.length === 0 && (
          <p className="px-2 text-sm leading-6 text-[#7f958f]">
            No movies found. Finish uploading the MP4 in Notion.
          </p>
        )}
        {videos.map((video) => {
          const active = selectedVideo?.id === video.id;
          return (
            <button
              className={`flex min-w-48 items-center gap-3 rounded-[1.25rem] px-2.5 py-2 text-left transition md:mb-1 md:w-full md:min-w-0 ${
                active
                  ? "bg-[#dcebe5] text-[#304c47] shadow-[inset_0_0_0_1px_rgba(92,131,123,0.22)]"
                  : "text-[#415f59] hover:bg-[#edf5f1]"
              }`}
              key={video.id}
              onClick={() => onSelect(video)}
              type="button"
            >
              <MoviePoster size="small" video={video} />
              <span className="min-w-0">
                <strong className="block truncate text-sm">{video.title}</strong>
                <small className="mt-1 block truncate text-xs text-[#7f958f]">
                  {video.year || "No year"}{video.genre ? ` / ${video.genre}` : ""}
                </small>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function Sidebar({
  albums,
  totalAlbums,
  selectedAlbum,
  onSelect,
  onHome,
  onMode,
  loading,
  query,
  onQuery,
  genre,
  onGenre,
  genres,
  year,
  onYear,
  years,
}) {
  return (
    <aside className="border-b border-[#eaded2] bg-[#fffaf5]/90 px-4 py-4 backdrop-blur md:row-start-1 md:overflow-hidden md:border-r md:border-b-0 md:px-5 md:py-6">
      <button className="flex w-full items-center gap-3 px-1 pb-4 text-left md:pb-7" onClick={onHome} type="button">
        <span className="grid h-10 w-10 place-items-center rounded-2xl bg-[#bf795c] text-sm font-black tracking-wide text-[#fffaf4] shadow-[0_9px_22px_rgba(167,102,76,0.2)]">
          NM
        </span>
        <div>
          <strong className="block font-serif text-lg tracking-tight text-[#4d3a33]">
            Notion Music
          </strong>
          <small className="mt-0.5 block text-xs font-semibold tracking-wide text-[#aa8879]">
            A gentle collection
          </small>
        </div>
      </button>

      <button
        className="mb-3 flex w-full items-center gap-2 rounded-2xl bg-[#f5e5d8] px-3 py-2 text-left text-sm font-bold text-[#8a5745] transition hover:bg-[#efd9ca]"
        onClick={onHome}
        type="button"
      >
        <HomeIcon />
        Library home
      </button>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <button
          className="rounded-xl bg-[#bf795c] px-3 py-2 text-xs font-extrabold tracking-wide text-[#fffaf4]"
          type="button"
        >
          Music
        </button>
        <button
          className="rounded-xl border border-[#ead8ca] bg-[#fffdf9] px-3 py-2 text-xs font-extrabold tracking-wide text-[#9a6f60] transition hover:bg-[#f8eee6]"
          onClick={() => onMode("movies")}
          type="button"
        >
          Movies
        </button>
      </div>

      <div className="hidden justify-between px-2 pb-3 text-[10px] font-extrabold tracking-[0.2em] text-[#b58b78] uppercase md:flex">
        <span>Albums</span>
        <span>{albums.length} / {totalAlbums}</span>
      </div>

      <div className="mb-3 space-y-2">
        <label className="flex items-center gap-2 rounded-2xl border border-[#ead8ca] bg-[#fffdf9] px-3 py-2 text-[#b17b67]">
          <SearchIcon />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm text-[#684b40] outline-none placeholder:text-[#c5a89a]"
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search songs, albums, artists"
            type="search"
            value={query}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <select className="rounded-xl border border-[#ead8ca] bg-[#fffdf9] px-2 py-2 text-xs text-[#89695c]" onChange={(event) => onGenre(event.target.value)} value={genre}>
            <option value="">All genres</option>
            {genres.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select className="rounded-xl border border-[#ead8ca] bg-[#fffdf9] px-2 py-2 text-xs text-[#89695c]" onChange={(event) => onYear(event.target.value)} value={year}>
            <option value="">All years</option>
            {years.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 md:block md:max-h-[calc(100vh-172px)] md:overflow-y-auto md:pb-0">
        {loading && <p className="px-2 text-sm text-[#a78475]">Loading albums...</p>}
        {!loading && albums.length === 0 && (
          <p className="px-2 text-sm leading-6 text-[#a78475]">
            No albums found. Add your first album in Notion.
          </p>
        )}
        {albums.map((album) => {
          const active = selectedAlbum?.id === album.id;
          return (
            <button
              className={`flex min-w-48 items-center gap-3 rounded-[1.25rem] px-2.5 py-2 text-left transition md:mb-1 md:w-full md:min-w-0 ${
                active
                  ? "bg-[#f3e1d3] text-[#633f32] shadow-[inset_0_0_0_1px_rgba(207,159,132,0.22)]"
                  : "text-[#6e554b] hover:bg-[#faeee4]"
              }`}
              key={album.id}
              onClick={() => onSelect(album)}
              type="button"
            >
              <Cover album={album} size="small" />
              <span className="min-w-0">
                <strong className="block truncate text-sm">{album.title}</strong>
                <small className="mt-1 block truncate text-xs text-[#a78475]">{album.artist}</small>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function LibraryHome({ albums, visibleAlbums, onSelect }) {
  const artistCount = new Set(albums.map((album) => album.artist).filter(Boolean)).size;
  const genreCount = new Set(albums.map((album) => album.genre).filter(Boolean)).size;
  const newestYear = Math.max(...albums.map((album) => album.year || 0));
  const stats = [
    ["Albums", albums.length],
    ["Artists", artistCount],
    ["Genres", genreCount],
    ["Newest", newestYear || "--"],
  ];

  return (
    <div>
      <span className="text-[10px] font-extrabold tracking-[0.24em] text-[#b56f55] uppercase">Personal library</span>
      <h1 className="mt-2 font-serif text-5xl tracking-[-0.06em] text-[#513a32] sm:text-7xl">A quiet place for your collection.</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-[#a27d6e]">Browse albums from your Notion catalog, filter the shelves, and inspect the lossless quality before you listen.</p>

      <section className="mt-9 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map(([label, value]) => (
          <div className="rounded-[1.5rem] border border-[#ead8ca] bg-[#fffaf5]/75 p-4 shadow-[0_14px_30px_rgba(128,87,69,0.06)]" key={label}>
            <strong className="font-serif text-3xl text-[#8d5a48]">{value}</strong>
            <span className="mt-1 block text-[10px] font-extrabold tracking-[0.18em] text-[#b58b78] uppercase">{label}</span>
          </div>
        ))}
      </section>

      <section className="mt-10">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <span className="text-[10px] font-extrabold tracking-[0.2em] text-[#b58b78] uppercase">Collection</span>
            <h2 className="mt-1 font-serif text-3xl text-[#563e35]">Albums on the shelf</h2>
          </div>
          <span className="text-xs font-bold text-[#ad8a7a]">{visibleAlbums.length} shown</span>
        </div>
        {visibleAlbums.length === 0 && <p className="rounded-2xl bg-[#fffaf5] p-5 text-sm text-[#a78475]">No albums match the current filters.</p>}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
          {visibleAlbums.map((album) => (
            <button className="group rounded-[1.5rem] border border-transparent bg-[#fffaf5]/55 p-3 text-left transition hover:-translate-y-1 hover:border-[#e7d3c4] hover:bg-[#fffaf5] hover:shadow-[0_18px_34px_rgba(128,87,69,0.1)]" key={album.id} onClick={() => onSelect(album)} type="button">
              <Cover album={album} size="card" />
              <strong className="mt-3 block truncate text-sm text-[#634b42]">{album.title}</strong>
              <small className="mt-1 block truncate text-xs text-[#ad8a7a]">{album.artist}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function MoviesHome({ continueItems = [], onRemoveProgress, onResetProgress, onSelect, videos, visibleVideos }) {
  const seriesGroups = useMemo(() => {
    const grouped = new Map();
    const standalone = [];
    for (const video of visibleVideos) {
      if (!video.series) {
        standalone.push(video);
        continue;
      }
      const group = grouped.get(video.series) || {
        name: video.series,
        videos: [],
      };
      group.videos.push(video);
      grouped.set(video.series, group);
    }
    const sortEpisodes = (items) =>
      [...items].sort((a, b) =>
        (a.seriesOrder ?? Number.MAX_SAFE_INTEGER) - (b.seriesOrder ?? Number.MAX_SAFE_INTEGER) ||
        (a.year || 0) - (b.year || 0) ||
        a.title.localeCompare(b.title),
      );
    return {
      series: [...grouped.values()]
        .map((group) => ({ ...group, videos: sortEpisodes(group.videos) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      standalone: sortEpisodes(standalone),
    };
  }, [visibleVideos]);
  const readyCount = videos.filter((video) => video.video?.url).length;
  const seriesCount = new Set(videos.map((video) => video.series).filter(Boolean)).size;
  const newestYear = Math.max(...videos.map((video) => video.year || 0));
  const stats = [
    ["Movies", videos.length],
    ["Ready", readyCount],
    ["Series", seriesCount],
    ["Newest", newestYear || "--"],
  ];
  const recentlyAdded = useMemo(() => {
    return [...visibleVideos]
      .sort((a, b) => {
        const aTime = Date.parse(a.addedAt || a.createdAt || a.updatedAt || 0) || 0;
        const bTime = Date.parse(b.addedAt || b.createdAt || b.updatedAt || 0) || 0;
        if (aTime || bTime) {
          return bTime - aTime || (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title);
        }
        return (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title);
      })
      .slice(0, 8);
  }, [visibleVideos]);

  return (
    <div>
      <span className="text-[10px] font-extrabold tracking-[0.24em] text-[#4f7f78] uppercase">Video library</span>
      <h1 className="mt-2 font-serif text-5xl tracking-[-0.06em] text-[#334742] sm:text-7xl">Movies from your Notion shelf.</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-[#718882]">Play browser-ready MP4 files from Notion and switch between uploaded WebVTT subtitles.</p>

      <section className="mt-9 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map(([label, value]) => (
          <div className="rounded-[1.5rem] border border-[#d9e2dc] bg-[#fbfaf6]/75 p-4 shadow-[0_14px_30px_rgba(74,88,84,0.06)]" key={label}>
            <strong className="font-serif text-3xl text-[#4f7f78]">{value}</strong>
            <span className="mt-1 block text-[10px] font-extrabold tracking-[0.18em] text-[#7c938d] uppercase">{label}</span>
          </div>
        ))}
      </section>

      {continueItems.length > 0 && (
        <section className="mt-10">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <span className="text-[10px] font-extrabold tracking-[0.2em] text-[#7c938d] uppercase">Continue watching</span>
              <h2 className="mt-1 font-serif text-3xl text-[#334742]">Pick up where you left off</h2>
            </div>
            <span className="text-xs font-bold text-[#7f958f]">{continueItems.length} recent</span>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {continueItems.map(({ progress, video }) => (
              <div
                className="group flex items-center gap-4 rounded-[1.5rem] border border-[#d9e2dc] bg-[#fbfaf6]/75 p-4 text-left shadow-[0_18px_42px_rgba(74,88,84,0.08)] transition hover:-translate-y-1 hover:border-[#8fb3aa] hover:bg-[#fbfaf6]"
                key={progress.id || `${progress.uid}_${progress.videoId}`}
              >
                <MoviePoster size="small" video={video} />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm text-[#334742]">{video.title}</strong>
                  <small className="mt-1 block text-xs font-semibold text-[#7f958f]">
                    {Math.round(progress.percent || 0)}% / {formatTime(progress.positionSeconds || 0)}
                  </small>
                  <span className="mt-3 block h-2 overflow-hidden rounded-full bg-[#e4eee9]">
                    <span className="block h-full rounded-full bg-[#4f7f78]" style={{ width: `${Math.max(4, Math.min(100, progress.percent || 0))}%` }} />
                  </span>
                  <small className="mt-2 block truncate text-[11px] font-semibold text-[#7f958f]">{formatDateTime(progress.lastWatchedAt)}</small>
                  <span className="mt-3 flex flex-wrap gap-2">
                    <button className="rounded-full bg-[#334742] px-3 py-1.5 text-[11px] font-extrabold text-white" onClick={() => onSelect(video)} type="button">
                      Resume
                    </button>
                    <button className="rounded-full border border-[#d8ded8] bg-white px-3 py-1.5 text-[11px] font-extrabold text-[#5e746f]" onClick={() => onRemoveProgress?.(video.id)} type="button">
                      Remove
                    </button>
                    <button className="rounded-full border border-[#ecc4b1] bg-white px-3 py-1.5 text-[11px] font-extrabold text-[#9b5d49]" onClick={() => onResetProgress?.(video.id)} type="button">
                      Reset progress
                    </button>
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {recentlyAdded.length > 0 && (
        <section className="mt-10">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <span className="text-[10px] font-extrabold tracking-[0.2em] text-[#7c938d] uppercase">Recently added</span>
              <h2 className="mt-1 font-serif text-3xl text-[#334742]">Fresh on the shelf</h2>
            </div>
            <span className="text-xs font-bold text-[#7f958f]">{recentlyAdded.length} shown</span>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 xl:grid-cols-8">
            {recentlyAdded.map((video) => (
              <button className="group rounded-[1.25rem] border border-[#d9e2dc] bg-[#fbfaf6]/75 p-2 text-left transition hover:-translate-y-1 hover:border-[#8fb3aa] hover:bg-[#fbfaf6]" key={video.id} onClick={() => onSelect(video)} type="button">
                <MoviePoster size="card" video={video} />
                <strong className="mt-2 block truncate text-xs text-[#334742]">{video.title}</strong>
                <small className="mt-1 block truncate text-[11px] text-[#7f958f]">{video.createdAt ? formatDateKey(video.createdAt) : video.year || "No date"}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {seriesGroups.series.length > 0 && (
        <section className="mt-10">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <span className="text-[10px] font-extrabold tracking-[0.2em] text-[#7c938d] uppercase">Series</span>
              <h2 className="mt-1 font-serif text-3xl text-[#334742]">Collections</h2>
            </div>
            <span className="text-xs font-bold text-[#7f958f]">{seriesGroups.series.length} shown</span>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {seriesGroups.series.map((group) => {
              const representative = group.videos.find((video) => video.cover) || group.videos[0];
              const readyEpisodes = group.videos.filter((video) => video.video?.url).length;
              const yearRange = [
                Math.min(...group.videos.map((video) => video.year || Number.MAX_SAFE_INTEGER)),
                Math.max(...group.videos.map((video) => video.year || 0)),
              ];
              const yearText =
                yearRange[0] === Number.MAX_SAFE_INTEGER
                  ? "No year"
                  : yearRange[0] === yearRange[1]
                    ? String(yearRange[0])
                    : `${yearRange[0]}-${yearRange[1]}`;
              return (
                <button
                  className="group flex min-h-44 items-end gap-4 rounded-[1.5rem] border border-[#d9e2dc] bg-[#fbfaf6]/75 p-4 text-left shadow-[0_18px_42px_rgba(74,88,84,0.08)] transition hover:-translate-y-1 hover:border-[#8fb3aa] hover:bg-[#fbfaf6]"
                  key={group.name}
                  onClick={() => onSelect({ type: "series", group })}
                  type="button"
                >
                  <MoviePoster size="small" video={representative} />
                  <span className="min-w-0 flex-1">
                    <span className="text-[10px] font-extrabold tracking-[0.18em] text-[#7c938d] uppercase">Series</span>
                    <strong className="mt-1 block truncate font-serif text-3xl text-[#334742]">{group.name}</strong>
                    <small className="mt-2 block text-xs font-semibold text-[#7f958f]">
                      {group.videos.length} movies / {readyEpisodes} ready / {yearText}
                    </small>
                  </span>
                  <span className="text-xl text-[#6d817b] transition group-hover:translate-x-1">&rarr;</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="mt-10">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <span className="text-[10px] font-extrabold tracking-[0.2em] text-[#7c938d] uppercase">Collection</span>
            <h2 className="mt-1 font-serif text-3xl text-[#334742]">Standalone Movies</h2>
          </div>
          <span className="text-xs font-bold text-[#7f958f]">{seriesGroups.standalone.length} shown</span>
        </div>
        {visibleVideos.length === 0 && <p className="rounded-2xl bg-[#fbfaf6] p-5 text-sm text-[#7f958f]">No movies match the current filters.</p>}
        {visibleVideos.length > 0 && seriesGroups.standalone.length === 0 && (
          <p className="rounded-2xl bg-[#fbfaf6] p-5 text-sm text-[#7f958f]">No standalone movies match the current filters.</p>
        )}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
          {seriesGroups.standalone.map((video) => (
            <button className="group rounded-[1.5rem] border border-transparent bg-[#fbfaf6]/55 p-3 text-left transition hover:-translate-y-1 hover:border-[#cfded7] hover:bg-[#fbfaf6] hover:shadow-[0_18px_34px_rgba(74,88,84,0.1)]" key={video.id} onClick={() => onSelect(video)} type="button">
              <MoviePoster size="card" video={video} />
              <strong className="mt-3 block truncate text-sm text-[#334742]">{video.title}</strong>
              <small className="mt-1 block truncate text-xs text-[#7f958f]">
                {video.year || "No year"}{video.genre ? ` / ${video.genre}` : ""}
              </small>
              {!video.video?.url && <span className="mt-2 inline-block rounded-full bg-[#f2dfd5] px-2 py-1 text-[9px] font-extrabold tracking-wide text-[#9b5d49] uppercase">Missing MP4</span>}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function SeriesDetail({ group, onBack, onSelect }) {
  if (!group) {
    return null;
  }

  return (
    <div>
      <button
        className="mb-7 rounded-full border border-[#cbdcd4] bg-[#fffdf9] px-4 py-2 text-xs font-extrabold tracking-[0.08em] text-[#4f7f78] transition hover:bg-[#eef5f1]"
        onClick={onBack}
        type="button"
      >
        Back to Video Home
      </button>
      <header>
        <span className="text-[10px] font-extrabold tracking-[0.24em] text-[#4f7f78] uppercase">Series</span>
        <h1 className="mt-2 max-w-4xl font-serif text-5xl leading-[0.95] tracking-[-0.06em] text-[#334742] sm:text-7xl lg:text-8xl">
          {group.name}
        </h1>
        <p className="mt-4 text-sm font-semibold text-[#718882]">
          {group.videos.length} movies
        </p>
      </header>

      <section className="mt-10 rounded-[1.75rem] border border-[#d9e2dc] bg-[#fbfaf6]/75 p-2 shadow-[0_20px_48px_rgba(74,88,84,0.08)] sm:p-3">
        <div className="grid grid-cols-[64px_1fr_auto] border-b border-[#d9e2dc] px-3 pt-2 pb-3 text-[10px] font-extrabold tracking-[0.2em] text-[#7c938d] uppercase">
          <span>#</span>
          <span>Title</span>
          <span>Status</span>
        </div>
        {group.videos.map((video, index) => (
          <button
            className="grid w-full grid-cols-[64px_1fr_auto] items-center gap-3 rounded-2xl px-3 py-3 text-left transition hover:bg-[#edf5f1]"
            key={video.id}
            onClick={() => onSelect(video)}
            type="button"
          >
            <span className="text-sm font-bold tabular-nums text-[#7f958f]">{video.seriesOrder || index + 1}</span>
            <span className="min-w-0">
              <strong className="block truncate text-sm text-[#334742]">{video.title}</strong>
              <small className="mt-1 block truncate text-xs text-[#7f958f]">
                {video.year || "No year"}{video.runtime ? ` / ${formatMinutes(video.runtime)}` : ""}
              </small>
            </span>
            <span className={`rounded-full px-2 py-1 text-[9px] font-extrabold tracking-wide uppercase ${
              video.video?.url ? "bg-[#dfeee4] text-[#4f7f5b]" : "bg-[#f2dfd5] text-[#9b5d49]"
            }`}>
              {video.video?.url ? "Ready" : video.status || "Missing MP4"}
            </span>
          </button>
        ))}
      </section>
    </div>
  );
}

function ReportIssueDialog({ onClose, onSubmit, video }) {
  const [type, setType] = useState("broken_video");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submitReport(event) {
    event.preventDefault();
    setSubmitting(true);
    setMessage("");
    try {
      await onSubmit({ note, type });
      setMessage("Report sent to admin.");
      setNote("");
    } catch (requestError) {
      setMessage(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#1d2432]/45 px-4 py-8 backdrop-blur-sm">
      <form className="w-full max-w-md rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9] p-5 shadow-[0_24px_70px_rgba(31,40,62,0.24)]" onSubmit={submitReport}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="text-[10px] font-extrabold tracking-[0.2em] text-[#7c938d] uppercase">Report issue</span>
            <h3 className="mt-1 font-serif text-3xl text-[#334742]">{video.title}</h3>
          </div>
          <button className="rounded-full border border-[#d8ded8] bg-white px-3 py-1.5 text-sm font-extrabold text-[#71847f]" onClick={onClose} type="button">
            Close
          </button>
        </div>
        <div className="mt-4 grid gap-3">
          <select className="rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm font-bold text-[#405c56]" onChange={(event) => setType(event.target.value)} value={type}>
            {VIDEO_REPORT_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <textarea className="min-h-28 rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm outline-none focus:border-[#4f7f78]" maxLength={1000} onChange={(event) => setNote(event.target.value)} placeholder="What is wrong? Add timestamp, subtitle language, or expected title if useful." value={note} />
          <div className="flex flex-wrap items-center gap-3">
            <button className="rounded-full bg-[#334742] px-5 py-3 text-sm font-extrabold text-white disabled:opacity-50" disabled={submitting} type="submit">
              Send report
            </button>
            {message && <span className="text-sm font-semibold text-[#4f7f78]">{message}</span>}
          </div>
        </div>
      </form>
    </div>
  );
}

function subtitleCacheKey(video, subtitle, index) {
  return `${video?.id || "video"}:${video?.updatedAt || video?.coverVersion || "1"}:${index}:${subtitle?.name || ""}`;
}

function MoviePlayer({ apiFetchText, loading, nextVideo, onAutoNext, onBack, onPrefsChange, onProgress, onRefresh, onReportIssue, onWatchEvent, prefs, progress, resumeEnabled, video }) {
  const videoRef = useRef(null);
  const restoredRef = useRef(false);
  const lastProgressRef = useRef(0);
  const analyticsProgressRef = useRef(new Set());
  const subtitleAssetUrlsRef = useRef([]);
  const recoveryRef = useRef({ busy: false, lastAt: 0, pending: null, refreshed: false, tried: new Set() });
  const stallTimerRef = useRef(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [mergedSubtitleUrl, setMergedSubtitleUrl] = useState("");
  const [subtitleAssets, setSubtitleAssets] = useState({ texts: {}, urls: {} });
  const [playbackSource, setPlaybackSource] = useState({
    mode: video?.video?.url ? "direct" : "proxy",
    url: video?.video?.url || video?.video?.proxyUrl || "",
  });
  const [preparedVideo, setPreparedVideo] = useState(null);
  const dualSubtitlePair = useMemo(() => findDualSubtitlePair(video?.subtitles || []), [video?.subtitles]);
  const selectedSubtitleTrack = video?.subtitles?.length
    ? prefs.subtitleTrack === DUAL_SUBTITLE_TRACK && !dualSubtitlePair
      ? "default"
      : prefs.subtitleTrack
    : "off";
  const activeSubtitleTracks = useMemo(() => {
    if (!video?.subtitles?.length || selectedSubtitleTrack === "off") {
      return [];
    }
    if (selectedSubtitleTrack === DUAL_SUBTITLE_TRACK) {
      return mergedSubtitleUrl
        ? [{
            label: "Chinese + English",
            name: "Chinese + English",
            srclang: "mul",
            src: mergedSubtitleUrl,
          }]
        : [];
    }
    if (selectedSubtitleTrack === "default") {
      return subtitleAssets.urls[0] ? [{ ...video.subtitles[0], index: 0, src: subtitleAssets.urls[0] }] : [];
    }
    const index = Number(selectedSubtitleTrack);
    return Number.isInteger(index) && video.subtitles[index]
      ? subtitleAssets.urls[index] ? [{ ...video.subtitles[index], index, src: subtitleAssets.urls[index] }] : []
      : subtitleAssets.urls[0] ? [{ ...video.subtitles[0], index: 0, src: subtitleAssets.urls[0] }] : [];
  }, [mergedSubtitleUrl, selectedSubtitleTrack, subtitleAssets.urls, video?.subtitles]);
  const showingSubtitles = activeSubtitleTracks.length > 0;

  const clearStallTimer = useCallback(() => {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    restoredRef.current = false;
    lastProgressRef.current = 0;
    analyticsProgressRef.current = new Set();
    recoveryRef.current = { busy: false, lastAt: 0, pending: null, refreshed: false, tried: new Set() };
    setPreparedVideo(null);
    setPlaybackSource({
      mode: video?.video?.url ? "direct" : "proxy",
      url: video?.video?.url || video?.video?.proxyUrl || "",
    });
  }, [video?.id, video?.video?.url]);

  useEffect(() => () => clearStallTimer(), [clearStallTimer]);

  useEffect(() => {
    let cancelled = false;
    const createdUrls = [];
    subtitleAssetUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    subtitleAssetUrlsRef.current = [];
    setSubtitleAssets({ texts: {}, urls: {} });

    if (!video?.subtitles?.length) {
      return () => {
        cancelled = true;
      };
    }

    Promise.all(
      video.subtitles.map(async (subtitle, index) => {
        const key = subtitleCacheKey(video, subtitle, index);
        let text = subtitleTextCache.get(key);
        if (!text) {
          text = await apiFetchText(subtitle.url);
          subtitleTextCache.set(key, text);
        }
        if (cancelled) {
          return null;
        }
        const url = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
        createdUrls.push(url);
        return [index, { text, url }];
      }),
    )
      .then((entries) => {
        if (cancelled) {
          return;
        }
        const texts = {};
        const urls = {};
        for (const entry of entries) {
          if (!entry) {
            continue;
          }
          const [index, asset] = entry;
          texts[index] = asset.text;
          urls[index] = asset.url;
        }
        subtitleAssetUrlsRef.current = createdUrls;
        setSubtitleAssets({ texts, urls });
      })
      .catch((error) => {
        console.error(error);
        createdUrls.forEach((url) => URL.revokeObjectURL(url));
        if (!cancelled) {
          setSubtitleAssets({ texts: {}, urls: {} });
        }
      });

    return () => {
      cancelled = true;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
      if (subtitleAssetUrlsRef.current === createdUrls) {
        subtitleAssetUrlsRef.current = [];
      }
    };
  }, [apiFetchText, video?.id, video?.subtitles, video?.updatedAt]);

  useEffect(() => {
    return () => {
      const element = videoRef.current;
      if (element && element.duration && element.currentTime > 0) {
        void onProgress?.({
          completed: element.ended,
          durationSeconds: element.duration,
          eventType: "unload",
          positionSeconds: element.currentTime,
        });
      }
    };
  }, [onProgress, video?.id]);

  useEffect(() => {
    const element = videoRef.current;
    if (element) {
      resumeElement(element);
    }
  }, [progress, resumeEnabled, video?.id, playbackSource.url]);

  useEffect(() => {
    const element = videoRef.current;
    if (element) {
      element.playbackRate = Number(prefs.playbackRate || 1);
      applySubtitlePreference(element);
    }
  }, [prefs.playbackRate, activeSubtitleTracks, selectedSubtitleTrack, video?.id]);

  useEffect(() => {
    if (selectedSubtitleTrack !== DUAL_SUBTITLE_TRACK || !dualSubtitlePair) {
      setMergedSubtitleUrl((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }
        return "";
      });
      return;
    }

    let cancelled = false;
    const primaryText = subtitleAssets.texts[dualSubtitlePair.primary.index];
    const secondaryText = subtitleAssets.texts[dualSubtitlePair.secondary.index];
    if (!primaryText || !secondaryText) {
      return;
    }

    Promise.resolve()
      .then(() => {
        if (cancelled) {
          return;
        }
        const merged = buildMergedWebVtt(parseWebVtt(primaryText), parseWebVtt(secondaryText));
        const url = URL.createObjectURL(new Blob([merged], { type: "text/vtt" }));
        setMergedSubtitleUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return url;
        });
      })
      .catch((error) => {
        console.error(error);
        if (!cancelled) {
          setMergedSubtitleUrl("");
        }
      });

    return () => {
      cancelled = true;
      setMergedSubtitleUrl((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }
        return "";
      });
    };
  }, [dualSubtitlePair, selectedSubtitleTrack, subtitleAssets.texts]);

  if (!video) {
    return null;
  }

  function progressPayload(eventType, element) {
    return {
      completed: eventType === "ended" || element.ended,
      durationSeconds: element.duration || 0,
      eventType,
      positionSeconds: element.currentTime || 0,
    };
  }

  function saveProgress(eventType, force = false) {
    const element = videoRef.current;
    if (!element || !Number.isFinite(element.duration) || element.duration <= 0) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastProgressRef.current < 10000) {
      return;
    }
    lastProgressRef.current = now;
    void onProgress?.(progressPayload(eventType, element));
  }

  async function refreshDirectUrlInBackground() {
    if (recoveryRef.current.refreshed || playbackSource.mode !== "direct") {
      return;
    }
    recoveryRef.current.refreshed = true;
    try {
      const freshVideo = await onRefresh?.({ apply: false, reason: "prefetch" });
      if (freshVideo?.video?.url) {
        setPreparedVideo(freshVideo);
      }
    } catch (error) {
      console.warn("Unable to prefetch refreshed video URL.", error);
      recoveryRef.current.refreshed = false;
    }
  }

  function handleTimeUpdate() {
    saveProgress("progress");
    const element = videoRef.current;
    if (element && Number.isFinite(element.duration) && element.duration > 0) {
      const percent = Math.floor((element.currentTime / element.duration) * 100);
      for (const threshold of [25, 50, 75, 90]) {
        if (percent >= threshold && !analyticsProgressRef.current.has(threshold)) {
          analyticsProgressRef.current.add(threshold);
          trackAnalyticsEvent("video_progress", videoAnalyticsParams(video, {
            progress_percent: threshold,
            source_mode: playbackSource.mode,
          }));
        }
      }
    }
    if (
      element &&
      playbackSource.mode === "direct" &&
      element.currentTime >= DIRECT_VIDEO_REFRESH_AFTER_SECONDS
    ) {
      void refreshDirectUrlInBackground();
    }
  }

  function recordEvent(eventType) {
    const element = videoRef.current;
    if (!element || !Number.isFinite(element.duration)) {
      return;
    }
    void onWatchEvent?.(progressPayload(eventType, element));
  }

  function resumeElement(element) {
    const positionSeconds = Number(progress?.positionSeconds || 0);
    const storedDuration = Number(progress?.durationSeconds || 0);
    const actualDuration = Number(element.duration || 0);
    const durationSeconds = storedDuration || actualDuration;
    if (!resumeEnabled || restoredRef.current || positionSeconds <= 3 || durationSeconds <= 0) {
      return;
    }
    if (!Number.isFinite(actualDuration) || actualDuration <= 0) {
      return;
    }
    const completed = Boolean(progress?.completed);
    const remaining = durationSeconds - positionSeconds;
    if (!completed && remaining > 3) {
      element.currentTime = Math.max(0, Math.min(positionSeconds - 2, actualDuration - 1));
      restoredRef.current = true;
    }
  }

  function resumePlayback(event) {
    const pending = recoveryRef.current.pending;
    if (pending && Number.isFinite(pending.time)) {
      const element = event.currentTarget;
      if (Number.isFinite(element.duration) && element.duration > 0) {
        element.currentTime = Math.max(0, Math.min(pending.time, element.duration - 1));
        if (pending.play) {
          void element.play().catch(() => {});
        }
        recoveryRef.current.pending = null;
      }
    }
    resumeElement(event.currentTarget);
    applySubtitlePreference(event.currentTarget);
  }

  function applySubtitlePreference(element) {
    const tracks = [...(element?.textTracks || [])];
    tracks.forEach((track, index) => {
      track.mode = showingSubtitles && index === 0 ? "showing" : "disabled";
    });
  }

  function updatePrefs(updates) {
    onPrefsChange?.({ ...prefs, ...updates });
  }

  function handlePlaybackRateChange(value) {
    const playbackRate = Number(value);
    updatePrefs({ playbackRate });
    trackAnalyticsEvent("playback_speed_change", videoAnalyticsParams(video, {
      playback_rate: `rate_${String(playbackRate).replace(".", "_")}`,
    }));
  }

  function handleSubtitleTrackChange(value) {
    updatePrefs({ subtitleTrack: value });
    const subtitle =
      value === "off"
        ? null
        : value === DUAL_SUBTITLE_TRACK
          ? { srclang: "dual" }
          : value === "default"
            ? video.subtitles[0]
            : video.subtitles[Number(value)];
    trackAnalyticsEvent("subtitle_change", videoAnalyticsParams(video, {
      subtitle_language: subtitleAnalyticsValue(subtitle),
    }));
  }

  function switchPlaybackSource(url, mode) {
    const element = videoRef.current;
    recoveryRef.current.pending = {
      play: Boolean(element && !element.paused && !element.ended),
      time: element?.currentTime || 0,
    };
    setPlaybackSource({ mode, url });
  }

  async function recoverPlayback(reason) {
    const now = Date.now();
    if (
      recoveryRef.current.busy ||
      now - recoveryRef.current.lastAt < PLAYBACK_RECOVERY_COOLDOWN_MS
    ) {
      return;
    }
    recoveryRef.current.busy = true;
    recoveryRef.current.lastAt = now;
    clearStallTimer();

    try {
      if (playbackSource.url) {
        recoveryRef.current.tried.add(playbackSource.url);
      }

      const preparedUrl = preparedVideo?.video?.url;
      if (preparedUrl && !recoveryRef.current.tried.has(preparedUrl)) {
        switchPlaybackSource(preparedUrl, "direct");
        trackAnalyticsEvent("video_source_recover", videoAnalyticsParams(video, {
          recover_reason: reason,
          source_mode: "direct",
        }));
        return;
      }

      const freshVideo = await onRefresh?.({ apply: false, reason: "recover" });
      if (freshVideo?.video?.url && !recoveryRef.current.tried.has(freshVideo.video.url)) {
        setPreparedVideo(freshVideo);
        switchPlaybackSource(freshVideo.video.url, "direct");
        trackAnalyticsEvent("video_source_recover", videoAnalyticsParams(video, {
          recover_reason: reason,
          source_mode: "direct",
        }));
        return;
      }

      const proxyUrl = freshVideo?.video?.proxyUrl || preparedVideo?.video?.proxyUrl || video.video?.proxyUrl;
      if (proxyUrl && playbackSource.url !== proxyUrl) {
        switchPlaybackSource(proxyUrl, "proxy");
        trackAnalyticsEvent("video_source_recover", videoAnalyticsParams(video, {
          recover_reason: reason,
          source_mode: "proxy",
        }));
        trackAnalyticsEvent("proxy_fallback", videoAnalyticsParams(video, {
          recover_reason: reason,
          source_mode: "proxy",
        }));
      }
    } catch (error) {
      console.error(error);
      const proxyUrl = preparedVideo?.video?.proxyUrl || video.video?.proxyUrl;
      if (proxyUrl && playbackSource.url !== proxyUrl) {
        switchPlaybackSource(proxyUrl, "proxy");
        trackAnalyticsEvent("proxy_fallback", videoAnalyticsParams(video, {
          recover_reason: reason,
          source_mode: "proxy",
        }));
      }
    } finally {
      recoveryRef.current.busy = false;
    }
  }

  function schedulePlaybackRecovery(reason) {
    clearStallTimer();
    stallTimerRef.current = setTimeout(() => {
      void recoverPlayback(reason);
    }, PLAYBACK_STALL_RECOVERY_MS);
  }

  return (
    <div>
      <button
        className="mb-7 rounded-full border border-[#cbdcd4] bg-[#fffdf9] px-4 py-2 text-xs font-extrabold tracking-[0.08em] text-[#4f7f78] transition hover:bg-[#eef5f1]"
        onClick={onBack}
        type="button"
      >
        Back to Video Home
      </button>
      <header className="flex min-h-56 flex-col gap-6 sm:flex-row sm:items-end">
        <MoviePoster video={video} />
        <div className="pb-1">
          <span className="text-[10px] font-extrabold tracking-[0.24em] text-[#4f7f78] uppercase">Movie</span>
          <h1 className="mt-2 max-w-4xl font-serif text-5xl leading-[0.95] tracking-[-0.06em] text-[#334742] sm:text-7xl lg:text-8xl">
            {video.title}
          </h1>
          <p className="mt-4 text-sm font-semibold text-[#718882]">
            {video.year ? `${video.year}` : "No year"}
            {video.genre ? ` / ${video.genre}` : ""}
            {video.runtime ? ` / ${formatMinutes(video.runtime)}` : ""}
            {video.audioLanguage ? ` / ${video.audioLanguage}` : ""}
          </p>
        </div>
      </header>

      <section className="mt-10 overflow-hidden rounded-[1.75rem] border border-[#d9e2dc] bg-[#111816] shadow-[0_20px_48px_rgba(44,62,58,0.16)] sm:mt-14">
        {loading && <p className="p-5 text-sm text-[#d8e7e0]">Refreshing video URL...</p>}
        {!video.video?.url ? (
          <div className="grid min-h-80 place-items-center p-8 text-center">
            <div>
              <FilmIcon className="mx-auto h-14 w-14 text-[#8fa8a1]" />
              <h2 className="mt-4 font-serif text-3xl text-[#f7fbf8]">MP4 is not ready yet</h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-[#b9cbc5]">
                Finish uploading the MP4 into the Notion Video property, then refresh this movie.
              </p>
            </div>
          </div>
        ) : (
          <video
            ref={videoRef}
            className={`aspect-video w-full bg-black subtitle-size-${prefs.subtitleSize || "medium"}`}
            controls
            crossOrigin="anonymous"
            onEnded={() => {
              saveProgress("ended", true);
              recordEvent("ended");
              if (prefs.autoNext && nextVideo) {
                onAutoNext?.(nextVideo);
              }
            }}
            onCanPlay={resumePlayback}
            onDurationChange={resumePlayback}
            onError={() => {
              recordEvent("error");
              void recoverPlayback("error");
            }}
            onLoadedMetadata={resumePlayback}
            onPause={() => {
              saveProgress("pause", true);
              recordEvent("pause");
            }}
            onPlay={() => {
              clearStallTimer();
              recordEvent("play");
            }}
            onPlaying={clearStallTimer}
            onStalled={() => schedulePlaybackRecovery("stalled")}
            onTimeUpdate={handleTimeUpdate}
            onWaiting={() => schedulePlaybackRecovery("waiting")}
            playsInline
            poster={getVideoCoverUrl(video, "large") || undefined}
            preload="metadata"
            src={playbackSource.url}
          >
            {activeSubtitleTracks.map((subtitle, index) => (
              <track
                default={index === 0}
                key={`${selectedSubtitleTrack}-${subtitle.srclang}-${subtitle.name}-${subtitle.src || subtitle.url}`}
                kind="subtitles"
                label={subtitle.label || subtitle.name || `Subtitle ${index + 1}`}
                onLoad={() => applySubtitlePreference(videoRef.current)}
                src={subtitle.src || subtitle.url}
                srcLang={subtitle.srclang || "und"}
              />
            ))}
          </video>
        )}
      </section>

      <section className="mt-4 grid gap-3 rounded-[1.5rem] border border-[#d9e2dc] bg-[#fbfaf6]/75 p-4 text-sm text-[#405c56] md:grid-cols-[1fr_1fr_1fr_1.2fr_auto]">
        <label className="grid gap-1">
          <span className="text-[10px] font-extrabold tracking-[0.18em] text-[#7c938d] uppercase">Speed</span>
          <select
            className="rounded-xl border border-[#d8ded8] bg-white px-3 py-2 text-sm font-bold"
            onChange={(event) => handlePlaybackRateChange(event.target.value)}
            value={prefs.playbackRate}
          >
            {PLAYBACK_RATE_OPTIONS.map((rate) => (
              <option key={rate} value={rate}>{rate}x</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-[10px] font-extrabold tracking-[0.18em] text-[#7c938d] uppercase">Subtitles</span>
          <select
            className="rounded-xl border border-[#d8ded8] bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
            disabled={!video.subtitles.length}
            onChange={(event) => handleSubtitleTrackChange(event.target.value)}
            value={selectedSubtitleTrack}
          >
            <option value="off">Off</option>
            <option value="default">Default</option>
            {dualSubtitlePair && <option value={DUAL_SUBTITLE_TRACK}>Chinese + English</option>}
            {video.subtitles.map((subtitle, index) => (
              <option key={`${subtitle.srclang}-${subtitle.name}`} value={String(index)}>
                {subtitle.label || subtitle.srclang || `Subtitle ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-[10px] font-extrabold tracking-[0.18em] text-[#7c938d] uppercase">Subtitle size</span>
          <select
            className="rounded-xl border border-[#d8ded8] bg-white px-3 py-2 text-sm font-bold"
            onChange={(event) => updatePrefs({ subtitleSize: event.target.value })}
            value={prefs.subtitleSize}
          >
            {SUBTITLE_SIZE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 text-xs font-extrabold text-[#5e746f]">
          <span>
            Auto next
            {nextVideo ? <small className="mt-1 block truncate font-semibold text-[#7f958f]">{nextVideo.title}</small> : <small className="mt-1 block font-semibold text-[#7f958f]">No next movie</small>}
          </span>
          <input
            checked={Boolean(prefs.autoNext)}
            disabled={!nextVideo}
            onChange={(event) => updatePrefs({ autoNext: event.target.checked })}
            type="checkbox"
          />
        </label>
        <button className="rounded-xl border border-[#ecc4b1] bg-white px-3 py-2 text-xs font-extrabold text-[#9b5d49]" onClick={() => setReportOpen(true)} type="button">
          Report issue
        </button>
      </section>

      <section className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] border border-[#d9e2dc] bg-[#fbfaf6]/75 p-4">
        <div>
          <span className="text-[10px] font-extrabold tracking-[0.18em] text-[#7c938d] uppercase">Notion file</span>
          <p className="mt-1 text-sm font-semibold text-[#405c56]">{video.video?.name || "No MP4 uploaded"}</p>
          <p className="mt-1 text-xs text-[#7f958f]">
            {video.subtitles.length ? `${video.subtitles.length} subtitle file${video.subtitles.length === 1 ? "" : "s"}` : "No WebVTT subtitles"}
            {progress?.positionSeconds ? ` / Resume at ${formatTime(progress.positionSeconds)}` : ""}
          </p>
        </div>
        <button
          className="rounded-full border border-[#cbdcd4] bg-[#fffdf9] px-4 py-2 text-xs font-extrabold tracking-[0.08em] text-[#4f7f78] transition hover:bg-[#eef5f1]"
          onClick={onRefresh}
          type="button"
        >
          Refresh movie metadata
        </button>
      </section>
      {reportOpen && (
        <ReportIssueDialog
          onClose={() => setReportOpen(false)}
          onSubmit={async (report) => {
            await onReportIssue?.(report);
            setReportOpen(false);
          }}
          video={video}
        />
      )}
    </div>
  );
}

function WishlistLauncher({ apiFetch, user }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("new");
  const [type, setType] = useState("movie");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [wishes, setWishes] = useState([]);
  const [wishQuery, setWishQuery] = useState("");
  const [wishStatus, setWishStatus] = useState("all");
  const [wishType, setWishType] = useState("all");
  const [editingWishId, setEditingWishId] = useState("");
  const [editDraft, setEditDraft] = useState({ note: "", title: "", type: "movie" });
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const loadWishes = useCallback(async () => {
    const data = await apiFetch("/api/wishlist");
    const nextWishes = data.wishes || [];
    setWishes(nextWishes);
    setUnreadCount(countChangedWishes(user?.uid, nextWishes));
  }, [apiFetch, user?.uid]);

  useEffect(() => {
    if (!open) {
      return;
    }
    loadWishes().catch(() => {});
  }, [loadWishes, open]);

  useEffect(() => {
    if (!open || tab !== "wishes") {
      return;
    }
    writeSeenWishStatuses(user?.uid, wishes);
    setUnreadCount(0);
  }, [open, tab, user?.uid, wishes]);

  useEffect(() => {
    loadWishes().catch(() => {});
  }, [loadWishes]);

  const filteredWishes = wishes.filter((wish) => {
    const query = wishQuery.trim().toLowerCase();
    const matchesQuery =
      !query || `${wish.title || ""} ${wish.note || ""} ${wish.adminNote || ""}`.toLowerCase().includes(query);
    const matchesStatus = wishStatus === "all" || (wish.status || "new") === wishStatus;
    const matchesType = wishType === "all" || (wish.type || "movie") === wishType;
    return matchesQuery && matchesStatus && matchesType;
  });

  async function submitWish(event) {
    event.preventDefault();
    if (!title.trim()) {
      setMessage(type === "feature" ? "Enter the feature you want first." : "Enter a movie or series title first.");
      return;
    }
    setSubmitting(true);
    setMessage("");
    try {
      await apiFetch("/api/wishlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, title, type }),
      });
      trackAnalyticsEvent("wishlist_submit", {
        content_type: type,
        has_note: Boolean(note.trim()),
        title_length: title.trim().length,
        type,
      });
      setTitle("");
      setNote("");
      setType("movie");
      setMessage("Wish sent to admin.");
      await loadWishes();
    } catch (requestError) {
      setMessage(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  function startEditWish(wish) {
    setEditingWishId(wish.id);
    setEditDraft({
      note: wish.note || "",
      title: wish.title || "",
      type: wish.type || "movie",
    });
    setMessage("");
  }

  async function saveWishEdit(wish) {
    if (!editDraft.title.trim()) {
      setMessage("Enter a title before saving.");
      return;
    }
    setSubmitting(true);
    setMessage("");
    try {
      const response = await apiFetch(`/api/wishlist/${encodeURIComponent(wish.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editDraft),
      });
      setWishes((current) => current.map((item) => (item.id === wish.id ? { ...item, ...editDraft, ...(response.wish || {}) } : item)));
      setEditingWishId("");
      setMessage("Wish updated.");
    } catch (requestError) {
      setMessage(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelWish(wish) {
    setSubmitting(true);
    setMessage("");
    try {
      const response = await apiFetch(`/api/wishlist/${encodeURIComponent(wish.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      });
      setWishes((current) => current.map((item) => (item.id === wish.id ? { ...item, status: "cancelled", ...(response.wish || {}) } : item)));
      setMessage("Wish cancelled.");
    } catch (requestError) {
      setMessage(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        className="rounded-full border border-[#d6dfda] bg-[#fffdf9] px-3 py-2 text-xs font-extrabold text-[#5e7e76]"
        onClick={() => {
          setOpen(true);
          setTab(unreadCount ? "wishes" : "new");
          setMessage("");
        }}
        type="button"
      >
        Wish
        {unreadCount > 0 && (
          <span className="ml-2 rounded-full bg-[#bf795c] px-2 py-0.5 text-[10px] text-white">{unreadCount}</span>
        )}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-[#22302c]/45 p-3 backdrop-blur-sm sm:p-5">
          <form className="h-full w-full max-w-xl overflow-auto rounded-[1.25rem] border border-[#d9e2dc] bg-[#fffdf9] p-5 shadow-[0_24px_70px_rgba(34,48,44,0.22)]" onSubmit={submitWish}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="text-[10px] font-extrabold tracking-[0.2em] text-[#7c938d] uppercase">Wishlist</span>
                <h3 className="mt-1 font-serif text-3xl text-[#334742]">Request a movie or feature</h3>
              </div>
              <button
                aria-label="Close wishlist dialog"
                className="rounded-full border border-[#d8ded8] bg-white px-3 py-1.5 text-sm font-extrabold text-[#71847f]"
                onClick={() => setOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>
            <div className="mt-4 flex rounded-2xl bg-[#f4f0e9] p-1 text-sm font-extrabold text-[#5e746f]">
              {[
                ["new", "New wish"],
                ["wishes", `My wishes${unreadCount ? ` (${unreadCount})` : ""}`],
              ].map(([value, label]) => (
                <button
                  className={`flex-1 rounded-xl px-4 py-2 ${tab === value ? "bg-white text-[#334742]" : ""}`}
                  key={value}
                  onClick={() => setTab(value)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === "new" && (
            <div className="mt-4 grid gap-3">
              <div className="grid grid-cols-2 gap-2">
                {WISH_TYPE_OPTIONS.map(([value, label]) => (
                  <button
                    className={`rounded-2xl px-4 py-3 text-sm font-extrabold transition ${
                      type === value
                        ? "bg-[#334742] text-white"
                        : "border border-[#d8ded8] bg-white text-[#5e746f] hover:bg-[#edf5f1]"
                    }`}
                    key={value}
                    onClick={() => setType(value)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input
                className="rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm outline-none focus:border-[#4f7f78]"
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={type === "feature" ? "Feature name or idea" : "Movie or series title"}
                value={title}
              />
              <textarea
                className="min-h-28 rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm outline-none focus:border-[#4f7f78]"
                maxLength={1000}
                onChange={(event) => setNote(event.target.value)}
                placeholder={type === "feature" ? "Describe the workflow or problem this solves" : "Optional source, language, version, or priority"}
                value={note}
              />
              <div className="rounded-2xl bg-[#f4f0e9] p-3">
                <span className="text-[10px] font-extrabold tracking-[0.18em] text-[#71847f] uppercase">Recent wishes</span>
                <div className="mt-2 grid max-h-40 gap-2 overflow-auto">
                  {wishes.length === 0 && <p className="rounded-2xl bg-white p-3 text-sm font-semibold text-[#71847f]">No wishes submitted yet.</p>}
                  {wishes.slice(0, 4).map((wish) => (
                    <div className="rounded-2xl bg-white p-3 text-sm" key={wish.id}>
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-[#e4eee9] px-2 py-1 text-[9px] font-extrabold tracking-wide text-[#4f7f78] uppercase">
                          {WISH_TYPE_LABELS[wish.type || "movie"] || "Movie"}
                        </span>
                        <strong className="min-w-0 truncate text-[#334742]">{wish.title}</strong>
                      </div>
                      <span className="mt-1 block text-xs font-semibold text-[#71847f]">{wish.status || "new"} / {formatDateTime(wish.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button className="rounded-full bg-[#334742] px-5 py-3 text-sm font-extrabold text-white disabled:opacity-50" disabled={submitting} type="submit">
                  Send wish
                </button>
                {message && <span className="text-sm font-semibold text-[#4f7f78]">{message}</span>}
              </div>
            </div>
            )}
            {tab === "wishes" && (
              <div className="mt-4 grid gap-3">
                <div className="grid gap-2 md:grid-cols-[1fr_auto_auto]">
                  <input
                    className="rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm outline-none focus:border-[#4f7f78]"
                    onChange={(event) => setWishQuery(event.target.value)}
                    placeholder="Search your wishes"
                    value={wishQuery}
                  />
                  <select className="rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm font-bold text-[#405c56]" onChange={(event) => setWishType(event.target.value)} value={wishType}>
                    <option value="all">All types</option>
                    {WISH_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <select className="rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm font-bold text-[#405c56]" onChange={(event) => setWishStatus(event.target.value)} value={wishStatus}>
                    <option value="all">All status</option>
                    {WISH_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
                  </select>
                </div>
                <div className="grid max-h-96 gap-3 overflow-auto">
                  {filteredWishes.length === 0 && <p className="rounded-2xl bg-[#f4f0e9] p-4 text-sm font-semibold text-[#71847f]">No wishlist requests match this filter.</p>}
                  {filteredWishes.map((wish) => {
                    const editing = editingWishId === wish.id;
                    const editable = (wish.status || "new") === "new";
                    return (
                      <div className="rounded-2xl bg-[#f4f0e9] p-4 text-sm" key={wish.id}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-white px-2 py-1 text-[9px] font-extrabold tracking-wide text-[#4f7f78] uppercase">{WISH_TYPE_LABELS[wish.type || "movie"] || "Movie"}</span>
                          <span className="rounded-full bg-white px-2 py-1 text-[9px] font-extrabold tracking-wide text-[#71847f] uppercase">{wish.status || "new"}</span>
                          <span className="text-xs font-semibold text-[#71847f]">{formatDateTime(wish.createdAt)}</span>
                        </div>
                        {editing ? (
                          <div className="mt-3 grid gap-2">
                            <input className="rounded-xl border border-[#d8ded8] bg-white px-3 py-2 text-sm" maxLength={160} onChange={(event) => setEditDraft((current) => ({ ...current, title: event.target.value }))} value={editDraft.title} />
                            <textarea className="min-h-20 rounded-xl border border-[#d8ded8] bg-white px-3 py-2 text-sm" maxLength={1000} onChange={(event) => setEditDraft((current) => ({ ...current, note: event.target.value }))} value={editDraft.note} />
                            <select className="rounded-xl border border-[#d8ded8] bg-white px-3 py-2 text-sm font-bold" onChange={(event) => setEditDraft((current) => ({ ...current, type: event.target.value }))} value={editDraft.type}>
                              {WISH_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                          </div>
                        ) : (
                          <>
                            <strong className="mt-3 block text-[#334742]">{wish.title}</strong>
                            {wish.note && <p className="mt-2 text-sm leading-6 text-[#405c56]">{wish.note}</p>}
                            {wish.adminNote && <p className="mt-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-[#71847f]">Admin note: {wish.adminNote}</p>}
                          </>
                        )}
                        {editable && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {editing ? (
                              <>
                                <button className="rounded-full bg-[#334742] px-4 py-2 text-xs font-extrabold text-white disabled:opacity-50" disabled={submitting} onClick={() => saveWishEdit(wish)} type="button">Save</button>
                                <button className="rounded-full border border-[#d8ded8] bg-white px-4 py-2 text-xs font-extrabold text-[#71847f]" onClick={() => setEditingWishId("")} type="button">Cancel edit</button>
                              </>
                            ) : (
                              <>
                                <button className="rounded-full border border-[#d8ded8] bg-white px-4 py-2 text-xs font-extrabold text-[#4f7f78]" onClick={() => startEditWish(wish)} type="button">Edit</button>
                                <button className="rounded-full border border-[#ecc4b1] bg-white px-4 py-2 text-xs font-extrabold text-[#9b5d49] disabled:opacity-50" disabled={submitting} onClick={() => cancelWish(wish)} type="button">Cancel wish</button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {message && <span className="text-sm font-semibold text-[#4f7f78]">{message}</span>}
              </div>
            )}
          </form>
        </div>
      )}
    </>
  );
}

function SettingsDialog({ nightMode, onNightModeChange, onSaveProfile, user }) {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDisplayName(user?.displayName || "");
  }, [user?.displayName]);

  async function saveSettings(event) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      await onSaveProfile({ displayName });
      setMessage("Settings saved.");
    } catch (requestError) {
      setMessage(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        className="rounded-full border border-[#d6dfda] bg-[#fffdf9] px-3 py-2 text-xs font-extrabold text-[#5e7e76]"
        onClick={() => {
          setDisplayName(user?.displayName || "");
          setMessage("");
          setOpen(true);
        }}
        type="button"
      >
        Settings
      </button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[#1d2432]/45 px-4 py-8 backdrop-blur-sm">
          <form className="w-full max-w-md rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9] p-5 shadow-[0_24px_70px_rgba(31,40,62,0.24)]" onSubmit={saveSettings}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="text-[10px] font-extrabold tracking-[0.2em] text-[#7c938d] uppercase">Settings</span>
                <h3 className="mt-1 font-serif text-3xl text-[#334742]">Profile and appearance</h3>
              </div>
              <button
                aria-label="Close settings dialog"
                className="rounded-full border border-[#d8ded8] bg-white px-3 py-1.5 text-sm font-extrabold text-[#71847f]"
                onClick={() => setOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>
            <div className="mt-4 grid gap-4">
              <label className="grid gap-2">
                <span className="text-[10px] font-extrabold tracking-[0.18em] text-[#71847f] uppercase">Nickname</span>
                <input
                  className="rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm outline-none focus:border-[#4f7f78]"
                  maxLength={60}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="How your name should appear"
                  value={displayName}
                />
              </label>
              <div className="rounded-2xl bg-[#f4f0e9] p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <span className="text-[10px] font-extrabold tracking-[0.18em] text-[#71847f] uppercase">Night mode</span>
                    <p className="mt-1 text-sm font-semibold text-[#405c56]">Blue-slate night theme for this device.</p>
                  </div>
                  <label className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-xs font-extrabold text-[#5e746f]">
                    <input checked={nightMode} onChange={(event) => onNightModeChange(event.target.checked)} type="checkbox" />
                    {nightMode ? "On" : "Off"}
                  </label>
                </div>
              </div>
              <div className="rounded-2xl bg-[#f4f0e9] p-4 text-sm text-[#5e746f]">
                Signed in as <strong className="text-[#334742]">{user?.email}</strong>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button className="rounded-full bg-[#334742] px-5 py-3 text-sm font-extrabold text-white disabled:opacity-50" disabled={saving} type="submit">
                  Save settings
                </button>
                {message && <span className="text-sm font-semibold text-[#4f7f78]">{message}</span>}
              </div>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function AccountBar({ apiFetch, nightMode, onAdmin, onBack, onLogout, onNightModeChange, onSaveProfile, showWishlist = true, user }) {
  const identityLabel = user?.displayName || user?.email;
  const initials = String(identityLabel || "?")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-4 text-sm sm:px-8">
      {showWishlist && apiFetch && <WishlistLauncher apiFetch={apiFetch} user={user} />}
      {onBack && (
        <button className="rounded-full border border-[#d6dfda] bg-[#fffdf9] px-4 py-2 text-xs font-extrabold text-[#5e7e76]" onClick={onBack} type="button">
          Back to library
        </button>
      )}
      <div className="relative">
        <button className="flex items-center gap-2 rounded-full border border-[#d6dfda] bg-[#fffdf9] px-2 py-1.5 text-xs font-extrabold text-[#5e7e76]" onClick={() => setMenuOpen((open) => !open)} type="button">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-[#6b7cff] text-white">{initials}</span>
          <span className="hidden max-w-36 truncate sm:block">{identityLabel}</span>
          <span aria-hidden="true">v</span>
        </button>
        {menuOpen && (
          <div className="absolute right-0 z-40 mt-2 grid min-w-56 gap-2 rounded-2xl border border-[#d8ded8] bg-[#fffdf9] p-3 shadow-[0_18px_50px_rgba(34,48,44,0.18)]">
            <div className="border-b border-[#e7ece7] px-2 pb-2">
              <strong className="block truncate text-sm text-[#334742]">{identityLabel}</strong>
              <span className="block truncate text-xs font-semibold text-[#71847f]">{user?.email}</span>
            </div>
            {onSaveProfile && (
              <SettingsDialog
                nightMode={nightMode}
                onNightModeChange={onNightModeChange}
                onSaveProfile={onSaveProfile}
                user={user}
              />
            )}
            {user?.role === "admin" && onAdmin && (
              <button className="rounded-full bg-[#334742] px-4 py-2 text-xs font-extrabold text-white" onClick={onAdmin} type="button">
                Admin
              </button>
            )}
            <button className="rounded-full border border-[#ecc4b1] bg-white px-4 py-2 text-xs font-extrabold text-[#8f5c50]" onClick={onLogout} type="button">
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function BarList({ emptyText = "No data yet.", rows, title }) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <section className="rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9] p-5">
      <h3 className="font-serif text-2xl text-[#334742]">{title}</h3>
      <div className="mt-4 grid gap-3">
        {rows.length === 0 && <p className="text-sm font-semibold text-[#71847f]">{emptyText}</p>}
        {rows.map((row) => (
          <div className="grid gap-1" key={row.label}>
            <div className="flex items-center justify-between gap-3 text-xs font-bold text-[#5e746f]">
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="shrink-0 tabular-nums">{row.value}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[#e7ece7]">
              <div
                className="h-full rounded-full bg-[#4f7f78]"
                style={{ width: `${Math.max(8, (row.value / max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function WatchStatsPanel({ events, progress }) {
  const stats = useMemo(() => summarizeWatchData(events, progress), [events, progress]);
  return (
    <section className="mt-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.cards.map(([label, value]) => (
          <div className="rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9] p-4" key={label}>
            <strong className="font-serif text-3xl text-[#4f7f78]">{value}</strong>
            <span className="mt-1 block text-[10px] font-extrabold tracking-[0.18em] text-[#71847f] uppercase">{label}</span>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <BarList rows={stats.byDate} title="Events by day" />
        <BarList rows={stats.byVideo} title="Top videos" />
        <BarList rows={stats.byIp} title="Top IP addresses" />
        <BarList rows={stats.byUser} title="Top users" />
      </div>

      <section className="mt-5 rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9] p-5">
        <h3 className="font-serif text-2xl text-[#334742]">Abnormal watch candidates</h3>
        <div className="mt-4 grid gap-2">
          {stats.anomalyRows.length === 0 && (
            <p className="text-sm font-semibold text-[#71847f]">No obvious abnormal patterns in the latest events.</p>
          )}
          {stats.anomalyRows.map((row) => (
            <div className="rounded-2xl bg-[#f4f0e9] p-3 text-sm" key={`${row.label}:${row.detail}`}>
              <strong className="block text-[#334742]">{row.label}</strong>
              <span className="mt-1 block text-xs font-semibold text-[#71847f]">{row.detail}</span>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

function AdminWishlistPanel({ onBatchUpdate, onUpdate, wishes }) {
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState([]);
  const [batchStatus, setBatchStatus] = useState("reviewing");
  const [noteDrafts, setNoteDrafts] = useState({});
  const filteredWishes = wishes.filter((wish) => {
    const type = wish.type || "movie";
    const status = wish.status || "new";
    const normalizedQuery = query.trim().toLowerCase();
    const matchesQuery =
      !normalizedQuery || `${wish.title || ""} ${wish.note || ""} ${wish.adminNote || ""} ${wish.email || ""}`.toLowerCase().includes(normalizedQuery);
    const matchesType = typeFilter === "all" || type === typeFilter;
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" && ["new", "reviewing", "planned"].includes(status)) ||
      status === statusFilter;
    return matchesQuery && matchesType && matchesStatus;
  });
  const selectedVisibleIds = selectedIds.filter((id) => filteredWishes.some((wish) => wish.id === id));

  function toggleSelected(id) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(0, 50));
  }

  function toggleAllVisible(checked) {
    setSelectedIds(checked ? filteredWishes.slice(0, 50).map((wish) => wish.id) : []);
  }
  const selectedWish = filteredWishes.find((wish) => selectedIds.includes(wish.id)) || filteredWishes[0] || null;

  return (
    <section className="rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9] p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-3xl text-[#334742]">Wishlist</h2>
          <p className="mt-1 text-sm font-semibold text-[#71847f]">
            {filteredWishes.length} shown / {wishes.length} total requests
          </p>
        </div>
        <div className="grid w-full gap-2 md:w-auto md:grid-cols-[1fr_auto_auto]">
          <input className="rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm" onChange={(event) => setQuery(event.target.value)} placeholder="Search wishlist" value={query} />
          <select className="rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm font-bold text-[#405c56]" onChange={(event) => setTypeFilter(event.target.value)} value={typeFilter}>
            <option value="all">All types</option>
            <option value="movie">Movies only</option>
            <option value="feature">Features only</option>
          </select>
          <select className="rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm font-bold text-[#405c56]" onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
            <option value="active">Active</option>
            <option value="all">All status</option>
            {WISH_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl bg-[#f4f0e9] p-3 text-xs font-bold text-[#5e746f]">
        <label className="rounded-full bg-white px-3 py-2">
          <input checked={selectedVisibleIds.length > 0 && selectedVisibleIds.length === Math.min(filteredWishes.length, 50)} className="mr-2" onChange={(event) => toggleAllVisible(event.target.checked)} type="checkbox" />
          Select visible
        </label>
        <span>{selectedVisibleIds.length} selected</span>
        <select className="rounded-full border border-[#d8ded8] bg-white px-3 py-2" onChange={(event) => setBatchStatus(event.target.value)} value={batchStatus}>
          {WISH_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
        <button
          className="rounded-full bg-[#334742] px-4 py-2 text-xs font-extrabold text-white disabled:opacity-50"
          disabled={!selectedVisibleIds.length}
          onClick={() => onBatchUpdate(selectedVisibleIds, { status: batchStatus }).then(() => setSelectedIds([]))}
          type="button"
        >
          Batch update
        </button>
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_22rem]">
        <div className="overflow-auto rounded-2xl border border-[#e0e6e1]">
          <table className="min-w-full divide-y divide-[#e0e6e1] text-left text-sm">
            <thead className="bg-[#f4f0e9] text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#71847f]">
              <tr>
                <th className="px-3 py-3"><input checked={selectedVisibleIds.length > 0 && selectedVisibleIds.length === Math.min(filteredWishes.length, 50)} onChange={(event) => toggleAllVisible(event.target.checked)} type="checkbox" /></th>
                <th className="px-3 py-3">Type</th>
                <th className="px-3 py-3">Title</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">User</th>
                <th className="px-3 py-3">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#edf0ec]">
              {filteredWishes.map((wish) => (
                <tr className={`cursor-pointer ${selectedWish?.id === wish.id ? "bg-[#edf5f1]" : "bg-white"}`} key={wish.id} onClick={() => setSelectedIds([wish.id])}>
                  <td className="px-3 py-3" onClick={(event) => event.stopPropagation()}><input checked={selectedIds.includes(wish.id)} onChange={() => toggleSelected(wish.id)} type="checkbox" /></td>
                  <td className="px-3 py-3 text-xs font-extrabold text-[#4f7f78]">{WISH_TYPE_LABELS[wish.type || "movie"] || "Movie"}</td>
                  <td className="max-w-xs truncate px-3 py-3 font-bold text-[#334742]">{wish.title}</td>
                  <td className="px-3 py-3"><span className="rounded-full bg-[#f4f0e9] px-2 py-1 text-[10px] font-extrabold uppercase text-[#71847f]">{wish.status || "new"}</span></td>
                  <td className="max-w-40 truncate px-3 py-3 text-xs font-semibold text-[#71847f]">{wish.email}</td>
                  <td className="px-3 py-3 text-xs font-semibold text-[#71847f]">{formatDateKey(wish.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <aside className="rounded-2xl bg-[#f4f0e9] p-4">
          {selectedWish ? (
            <div className="grid gap-3 text-sm">
              <div>
                <span className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-[#71847f]">Detail</span>
                <h3 className="mt-1 font-serif text-2xl text-[#334742]">{selectedWish.title}</h3>
                <p className="mt-1 text-xs font-semibold text-[#71847f]">{selectedWish.email} / {selectedWish.ipAddress || "No IP"}</p>
              </div>
              {selectedWish.note && <p className="rounded-xl bg-white p-3 leading-6 text-[#405c56]">{selectedWish.note}</p>}
              <select
                className="rounded-xl border border-[#d8ded8] bg-white px-3 py-2 text-sm font-bold text-[#405c56]"
                onChange={(event) => onUpdate(selectedWish, { status: event.target.value })}
                value={selectedWish.status || "new"}
              >
                {WISH_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
              <textarea
                className="min-h-28 rounded-xl border border-[#d8ded8] bg-white px-3 py-2 text-xs font-semibold text-[#71847f]"
                onChange={(event) => setNoteDrafts((current) => ({ ...current, [selectedWish.id]: event.target.value }))}
                placeholder="Admin note"
                value={noteDrafts[selectedWish.id] ?? selectedWish.adminNote ?? ""}
              />
              <button className="rounded-full bg-[#334742] px-4 py-2 text-xs font-extrabold text-white" onClick={() => onUpdate(selectedWish, { adminNote: noteDrafts[selectedWish.id] ?? selectedWish.adminNote ?? "" })} type="button">
                Save note
              </button>
            </div>
          ) : (
            <p className="text-sm font-semibold text-[#71847f]">Select a wishlist request.</p>
          )}
        </aside>
      </div>
      <div className="mt-4 hidden gap-3">
        {filteredWishes.length === 0 && <p className="rounded-2xl bg-[#f4f0e9] p-4 text-sm font-semibold text-[#71847f]">No wishlist requests match this filter.</p>}
        {filteredWishes.map((wish) => (
          <div className="grid gap-3 rounded-2xl bg-[#f4f0e9] p-4 text-sm lg:grid-cols-[auto_1fr_auto]" key={wish.id}>
            <input checked={selectedIds.includes(wish.id)} onChange={() => toggleSelected(wish.id)} type="checkbox" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-white px-2 py-1 text-[9px] font-extrabold tracking-wide text-[#4f7f78] uppercase">
                  {WISH_TYPE_LABELS[wish.type || "movie"] || "Movie"}
                </span>
                <span className="rounded-full bg-white px-2 py-1 text-[9px] font-extrabold tracking-wide text-[#71847f] uppercase">
                  {wish.status || "new"}
                </span>
                <strong className="min-w-0 truncate text-[#334742]">{wish.title}</strong>
              </div>
              <span className="mt-1 block text-xs font-semibold text-[#71847f]">
                {wish.email} / {wish.ipAddress || "No IP"} / {formatDateTime(wish.createdAt)}
              </span>
              {wish.note && <p className="mt-2 text-sm leading-6 text-[#405c56]">{wish.note}</p>}
              <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto]">
                <input
                  className="rounded-xl border border-[#d8ded8] bg-white px-3 py-2 text-xs font-semibold text-[#71847f]"
                  onChange={(event) => setNoteDrafts((current) => ({ ...current, [wish.id]: event.target.value }))}
                  placeholder="Admin note"
                  value={noteDrafts[wish.id] ?? wish.adminNote ?? ""}
                />
                <button className="rounded-full border border-[#d8ded8] bg-white px-4 py-2 text-xs font-extrabold text-[#4f7f78]" onClick={() => onUpdate(wish, { adminNote: noteDrafts[wish.id] ?? wish.adminNote ?? "" })} type="button">
                  Save note
                </button>
              </div>
            </div>
            <select
              className="h-10 rounded-xl border border-[#d8ded8] bg-white px-3 text-sm font-bold text-[#405c56]"
              onChange={(event) => onUpdate(wish, { status: event.target.value })}
              value={wish.status || "new"}
            >
              {WISH_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </div>
        ))}
      </div>
    </section>
  );
}

function DemoLanding({ error, loading, onGoogleLogin, items = [] }) {
  const audioRef = useRef(null);
  const videoRef = useRef(null);
  const musicItems = items.filter((item) => item.type === "music");
  const videoItems = items.filter((item) => item.type === "video");
  const [selectedMusicId, setSelectedMusicId] = useState(musicItems[0]?.id || "");
  const [selectedVideoId, setSelectedVideoId] = useState(videoItems[0]?.id || "");
  const selectedMusic = musicItems.find((item) => item.id === selectedMusicId) || musicItems[0] || null;
  const selectedVideo = videoItems.find((item) => item.id === selectedVideoId) || videoItems[0] || null;

  useEffect(() => {
    if (!selectedMusicId && musicItems[0]) {
      setSelectedMusicId(musicItems[0].id);
    }
    if (!selectedVideoId && videoItems[0]) {
      setSelectedVideoId(videoItems[0].id);
    }
  }, [items, selectedMusicId, selectedVideoId]);

  function pauseOtherMedia(kind) {
    if (kind === "audio") {
      videoRef.current?.pause();
    } else {
      audioRef.current?.pause();
    }
  }

  return (
    <main className="min-h-screen bg-[#f4f0e9] font-sans text-[#405c56]">
      <header className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
        <div>
          <span className="text-[10px] font-extrabold tracking-[0.24em] text-[#70837d] uppercase">Notion Media Library</span>
          <p className="mt-1 text-sm font-semibold text-[#71847f]">Public demo</p>
        </div>
        <button
          className="rounded-full bg-[#334742] px-5 py-3 text-xs font-extrabold text-white shadow-sm transition hover:bg-[#4f7f78] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={loading}
          onClick={onGoogleLogin}
          type="button"
        >
          登入完整媒體庫
        </button>
      </header>

      <section className="mx-auto grid max-w-7xl gap-8 px-5 pt-10 pb-20 sm:px-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-end lg:pt-20">
        <div>
          <p className="text-xs font-extrabold tracking-[0.22em] text-[#bd7458] uppercase">A small legal showcase</p>
          <h1 className="mt-4 max-w-3xl font-serif text-5xl leading-[0.96] text-[#334742] sm:text-7xl">Listen and watch a few selected works.</h1>
          <p className="mt-6 max-w-2xl text-base leading-8 text-[#657973]">
            這裡只展示已取得授權的片段。登入後，經管理員核准的使用者才會看到完整私人媒體庫。
          </p>
          {error && <p className="mt-5 rounded-2xl border border-[#e6b9a7] bg-[#fff0e7] px-4 py-3 text-sm font-semibold text-[#9a5e4c]">{error}</p>}
          {loading && <p className="mt-5 text-sm font-semibold text-[#71847f]">Loading demo...</p>}
        </div>

        <div className="rounded-[2rem] border border-[#d8ded8] bg-[#fffdf9] p-6 shadow-[0_20px_54px_rgba(76,89,84,0.08)]">
          <p className="text-[10px] font-extrabold tracking-[0.2em] text-[#70837d] uppercase">How access works</p>
          <div className="mt-5 grid gap-4 text-sm leading-6 text-[#5e746f]">
            <p><strong className="text-[#334742]">01</strong> 直接播放下方公開 Demo 素材。</p>
            <p><strong className="text-[#334742]">02</strong> 右上角登入，系統只會載入核准帳號可用的私人目錄。</p>
            <p><strong className="text-[#334742]">03</strong> Demo 不會儲存播放進度、願望清單或使用者資料。</p>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-6 px-5 pb-24 sm:px-8 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="rounded-[2rem] border border-[#d8ded8] bg-[#fffaf4] p-6 sm:p-8">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-[10px] font-extrabold tracking-[0.2em] text-[#70837d] uppercase">Selected songs</p>
              <h2 className="mt-2 font-serif text-3xl text-[#60483f]">Listen</h2>
            </div>
            <span className="rounded-full bg-[#f1dfd2] px-3 py-1 text-xs font-bold text-[#9a654f]">{musicItems.length} tracks</span>
          </div>
          {selectedMusic ? (
            <>
              <div className="mt-7 rounded-3xl bg-[#60483f] p-5 text-[#fffaf4]">
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#e6c2ae]">Now selected</p>
                <h3 className="mt-2 truncate font-serif text-2xl">{selectedMusic.title}</h3>
                {selectedMusic.artist && <p className="mt-1 text-sm text-[#f0d9cc]">{selectedMusic.artist}</p>}
                {selectedMusic.credit && <p className="mt-2 text-xs text-[#f0d9cc]">素材：{selectedMusic.credit}</p>}
                {selectedMusic.sourceUrl && <a className="mt-1 inline-block text-xs text-[#e6c2ae] underline" href={selectedMusic.sourceUrl} rel="noreferrer" target="_blank">查看來源／授權連結</a>}
                <audio
                  ref={audioRef}
                  className="mt-5 w-full"
                  controls
                  onPlay={() => pauseOtherMedia("audio")}
                  preload="metadata"
                  src={selectedMusic.media.url}
                />
              </div>
              <div className="mt-4 grid gap-2">
                {musicItems.map((item) => (
                  <button
                    className={`flex items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left text-sm font-bold transition ${item.id === selectedMusic.id ? "bg-[#f1dfd2] text-[#9a654f]" : "bg-white text-[#5e746f] hover:bg-[#f7eee8]"}`}
                    key={item.id}
                    onClick={() => setSelectedMusicId(item.id)}
                    type="button"
                  >
                    <span className="min-w-0 truncate">{item.title}</span>
                    <span className="shrink-0 text-xs">▶</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="mt-7 rounded-2xl bg-white px-4 py-5 text-sm font-semibold text-[#71847f]">尚未設定展示歌曲。</p>
          )}
        </div>

        <div className="rounded-[2rem] border border-[#d8ded8] bg-[#eef3ef] p-6 sm:p-8">
          <p className="text-[10px] font-extrabold tracking-[0.2em] text-[#70837d] uppercase">Selected clips</p>
          <h2 className="mt-2 font-serif text-3xl text-[#334742]">Watch</h2>
          {selectedVideo ? (
            <div className="mt-7 overflow-hidden rounded-3xl bg-[#24322f]">
              <video
                ref={videoRef}
                className="aspect-video w-full bg-black object-contain"
                controls
                onPlay={() => pauseOtherMedia("video")}
                preload="metadata"
                src={selectedVideo.media.url}
              >
                {selectedVideo.subtitles?.map((subtitle) => (
                  <track
                    default={subtitle === selectedVideo.subtitles[0]}
                    kind="subtitles"
                    key={subtitle.url}
                    label={subtitle.label}
                    src={subtitle.url}
                    srcLang={subtitle.srclang}
                  />
                ))}
              </video>
              <div className="p-5 text-white">
                <h3 className="font-serif text-2xl">{selectedVideo.title}</h3>
                {selectedVideo.description && <p className="mt-2 text-sm leading-6 text-[#d9e6df]">{selectedVideo.description}</p>}
                {selectedVideo.credit && <p className="mt-3 text-xs text-[#b8cbc2]">素材：{selectedVideo.credit}</p>}
                {selectedVideo.sourceUrl && <a className="mt-2 inline-block text-xs text-[#e6c2ae] underline" href={selectedVideo.sourceUrl} rel="noreferrer" target="_blank">查看來源／授權連結</a>}
              </div>
              {videoItems.length > 1 && <div className="grid gap-2 border-t border-white/10 p-4">{videoItems.map((item) => <button className={`rounded-2xl px-4 py-3 text-left text-sm font-bold transition ${item.id === selectedVideo.id ? "bg-[#d9e6df] text-[#334742]" : "bg-white/10 text-white hover:bg-white/20"}`} key={item.id} onClick={() => setSelectedVideoId(item.id)} type="button"><span className="block truncate">{item.title}</span>{item.credit && <span className="mt-1 block truncate text-xs font-normal opacity-75">{item.credit}</span>}</button>)}</div>}
            </div>
          ) : (
            <p className="mt-7 rounded-2xl bg-white px-4 py-5 text-sm font-semibold text-[#71847f]">尚未設定展示影片。</p>
          )}
        </div>
      </section>
    </main>
  );
}

function AdminVideoReportsPanel({ onUpdate, reports }) {
  const [statusFilter, setStatusFilter] = useState("new");
  const [query, setQuery] = useState("");
  const [noteDrafts, setNoteDrafts] = useState({});
  const filteredReports = reports.filter((report) => {
    const normalizedQuery = query.trim().toLowerCase();
    const matchesQuery =
      !normalizedQuery || `${report.videoTitle || ""} ${report.note || ""} ${report.email || ""} ${report.type || ""}`.toLowerCase().includes(normalizedQuery);
    const matchesStatus = statusFilter === "all" || (report.status || "new") === statusFilter;
    return matchesQuery && matchesStatus;
  });

  return (
    <section className="rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9] p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-3xl text-[#334742]">Video reports</h2>
          <p className="mt-1 text-sm font-semibold text-[#71847f]">{filteredReports.length} shown / {reports.length} total reports</p>
        </div>
        <div className="grid w-full gap-2 md:w-auto md:grid-cols-[1fr_auto]">
          <input className="rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm" onChange={(event) => setQuery(event.target.value)} placeholder="Search reports" value={query} />
          <select className="rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm font-bold text-[#405c56]" onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
            <option value="all">All status</option>
            {VIDEO_REPORT_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </div>
      </div>
      <div className="mt-4 grid gap-3">
        {filteredReports.length === 0 && <p className="rounded-2xl bg-[#f4f0e9] p-4 text-sm font-semibold text-[#71847f]">No video reports match this filter.</p>}
        {filteredReports.map((report) => (
          <div className="grid gap-3 rounded-2xl bg-[#f4f0e9] p-4 text-sm xl:grid-cols-[1fr_auto]" key={report.id}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-white px-2 py-1 text-[9px] font-extrabold uppercase tracking-wide text-[#4f7f78]">{report.type || "other"}</span>
                <span className="rounded-full bg-white px-2 py-1 text-[9px] font-extrabold uppercase tracking-wide text-[#71847f]">{report.status || "new"}</span>
                <strong className="min-w-0 truncate text-[#334742]">{report.videoTitle || report.videoId}</strong>
              </div>
              <span className="mt-1 block text-xs font-semibold text-[#71847f]">{report.email} / {formatDateTime(report.createdAt)}</span>
              {report.note && <p className="mt-2 rounded-xl bg-white p-3 leading-6 text-[#405c56]">{report.note}</p>}
              <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto]">
                <input className="rounded-xl border border-[#d8ded8] bg-white px-3 py-2 text-xs font-semibold text-[#71847f]" onChange={(event) => setNoteDrafts((current) => ({ ...current, [report.id]: event.target.value }))} placeholder="Admin note" value={noteDrafts[report.id] ?? report.adminNote ?? ""} />
                <button className="rounded-full border border-[#d8ded8] bg-white px-4 py-2 text-xs font-extrabold text-[#4f7f78]" onClick={() => onUpdate(report, { adminNote: noteDrafts[report.id] ?? report.adminNote ?? "" })} type="button">
                  Save note
                </button>
              </div>
            </div>
            <select className="h-10 rounded-xl border border-[#d8ded8] bg-white px-3 text-sm font-bold text-[#405c56]" onChange={(event) => onUpdate(report, { status: event.target.value })} value={report.status || "new"}>
              {VIDEO_REPORT_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </div>
        ))}
      </div>
    </section>
  );
}

function AdminAuditPanel({ logs }) {
  const [targetType, setTargetType] = useState("all");
  const [query, setQuery] = useState("");
  const filteredLogs = logs.filter((log) => {
    const normalizedQuery = query.trim().toLowerCase();
    const matchesQuery =
      !normalizedQuery || `${log.actorName || ""} ${log.actorUid || ""} ${log.action || ""} ${log.targetType || ""} ${log.targetId || ""}`.toLowerCase().includes(normalizedQuery);
    const matchesTarget = targetType === "all" || log.targetType === targetType;
    return matchesQuery && matchesTarget;
  });

  return (
    <section className="rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9] p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-3xl text-[#334742]">Audit log</h2>
          <p className="mt-1 text-sm font-semibold text-[#71847f]">{filteredLogs.length} shown / {logs.length} total actions</p>
        </div>
        <div className="grid w-full gap-2 md:w-auto md:grid-cols-[1fr_auto]">
          <input className="rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm" onChange={(event) => setQuery(event.target.value)} placeholder="Search actor, action, target" value={query} />
          <select className="rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm font-bold text-[#405c56]" onChange={(event) => setTargetType(event.target.value)} value={targetType}>
            <option value="all">All targets</option>
            {AUDIT_TARGET_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </div>
      </div>
      <div className="mt-4 grid gap-2">
        {filteredLogs.length === 0 && <p className="rounded-2xl bg-[#f4f0e9] p-4 text-sm font-semibold text-[#71847f]">No audit entries match this filter.</p>}
        {filteredLogs.map((log) => (
          <div className="grid gap-1 rounded-2xl bg-[#f4f0e9] p-3 text-sm md:grid-cols-[1fr_auto_auto]" key={log.id}>
            <strong className="text-[#334742]">{log.action}</strong>
            <span className="text-xs font-semibold text-[#71847f]">{log.actorName || log.actorUid}</span>
            <span className="text-xs font-semibold text-[#71847f]">{log.targetType}:{log.targetId} / {formatDateTime(log.createdAt)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function AdminDashboard({ apiFetch, nightMode, onBack, onLogout, onNightModeChange, onSaveProfile, user }) {
  const [users, setUsers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [videos, setVideos] = useState([]);
  const [progress, setProgress] = useState([]);
  const [events, setEvents] = useState([]);
  const [wishes, setWishes] = useState([]);
  const [reports, setReports] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [message, setMessage] = useState("");
  const [activeAdminTab, setActiveAdminTab] = useState("users");
  const [watchLoaded, setWatchLoaded] = useState(false);
  const [watchLoading, setWatchLoading] = useState(false);
  const [wishlistLoaded, setWishlistLoaded] = useState(false);
  const [wishlistLoading, setWishlistLoading] = useState(false);
  const [reportsLoaded, setReportsLoaded] = useState(false);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [auditLoaded, setAuditLoaded] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [selectedUserKey, setSelectedUserKey] = useState("");
  const [form, setForm] = useState({
    email: "",
    displayName: "",
    role: "user",
  });

  const loadUsersData = useCallback(async () => {
    const [userData, videoData] = await Promise.all([
      apiFetch("/api/admin/users"),
      apiFetch("/api/videos"),
    ]);
    setUsers(userData.users || []);
    setInvites(userData.invites || []);
    setVideos(videoData || []);
  }, [apiFetch]);

  const loadWatchData = useCallback(async () => {
    setWatchLoading(true);
    try {
      const [progressData, eventData] = await Promise.all([
        apiFetch("/api/admin/watch-progress"),
        apiFetch("/api/admin/watch-events"),
      ]);
      setProgress(progressData.progress || []);
      setEvents(eventData.events || []);
    } finally {
      setWatchLoaded(true);
      setWatchLoading(false);
    }
  }, [apiFetch]);

  const loadWishlistData = useCallback(async () => {
    setWishlistLoading(true);
    try {
      const wishlistData = await apiFetch("/api/admin/wishlist");
      setWishes(wishlistData.wishes || []);
    } finally {
      setWishlistLoaded(true);
      setWishlistLoading(false);
    }
  }, [apiFetch]);

  const loadReportsData = useCallback(async () => {
    setReportsLoading(true);
    try {
      const reportData = await apiFetch("/api/admin/video-reports");
      setReports(reportData.reports || []);
    } finally {
      setReportsLoaded(true);
      setReportsLoading(false);
    }
  }, [apiFetch]);

  const loadAuditData = useCallback(async () => {
    setAuditLoading(true);
    try {
      const auditData = await apiFetch("/api/admin/audit-logs");
      setAuditLogs(auditData.logs || []);
    } finally {
      setAuditLoaded(true);
      setAuditLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    loadUsersData().catch((requestError) => setMessage(requestError.message));
  }, [loadUsersData]);

  useEffect(() => {
    if (activeAdminTab === "watch" && !watchLoaded && !watchLoading) {
      loadWatchData().catch((requestError) => setMessage(requestError.message));
    }
    if (activeAdminTab === "wishlist" && !wishlistLoaded && !wishlistLoading) {
      loadWishlistData().catch((requestError) => setMessage(requestError.message));
    }
    if (activeAdminTab === "reports" && !reportsLoaded && !reportsLoading) {
      loadReportsData().catch((requestError) => setMessage(requestError.message));
    }
    if (activeAdminTab === "audit" && !auditLoaded && !auditLoading) {
      loadAuditData().catch((requestError) => setMessage(requestError.message));
    }
  }, [
    activeAdminTab,
    auditLoaded,
    auditLoading,
    loadAuditData,
    loadReportsData,
    loadWatchData,
    loadWishlistData,
    reportsLoaded,
    reportsLoading,
    watchLoaded,
    watchLoading,
    wishlistLoaded,
    wishlistLoading,
  ]);

  async function addUser(event) {
    event.preventDefault();
    setMessage("");
    try {
      const response = await apiFetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.email,
          displayName: form.displayName,
          role: form.role,
          allowedProviders: ["google.com"],
          featureFlags: DEFAULT_FEATURE_FLAGS,
          contentAccess: DEFAULT_CONTENT_ACCESS,
          status: "active",
        }),
      });
      setMessage(response.temporaryPassword ? `Temporary password: ${response.temporaryPassword}` : "User added.");
      setForm({ email: "", displayName: "", role: "user" });
      await loadUsersData();
    } catch (requestError) {
      setMessage(requestError.message);
    }
  }

  async function saveUser(row, updates) {
    setMessage("");
    try {
      await apiFetch(`/api/admin/users/${encodeURIComponent(row.uid || row.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      setMessage("User updated.");
      setAuditLoaded(false);
      await loadUsersData();
    } catch (requestError) {
      setMessage(requestError.message);
    }
  }

  async function updateWish(wish, updates) {
    setMessage("");
    try {
      const response = await apiFetch(`/api/admin/wishlist/${encodeURIComponent(wish.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      setWishes((current) =>
        current.map((item) =>
          item.id === wish.id
            ? {
                ...item,
                ...(response.wish || {}),
                ...updates,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      );
      setMessage("Wishlist updated.");
      setAuditLoaded(false);
    } catch (requestError) {
      setMessage(requestError.message);
    }
  }

  async function updateReport(report, updates) {
    setMessage("");
    try {
      const response = await apiFetch(`/api/admin/video-reports/${encodeURIComponent(report.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      setReports((current) =>
        current.map((item) =>
          item.id === report.id
            ? {
                ...item,
                ...(response.report || {}),
                ...updates,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      );
      setAuditLoaded(false);
      setMessage("Report updated.");
    } catch (requestError) {
      setMessage(requestError.message);
    }
  }

  async function batchUpdateWishes(ids, updates) {
    setMessage("");
    try {
      const response = await apiFetch("/api/admin/wishlist:batch", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, updates }),
      });
      const updatedById = new Map((response.wishes || []).map((wish) => [wish.id, wish]));
      setWishes((current) =>
        current.map((item) =>
          updatedById.has(item.id)
            ? {
                ...item,
                ...updatedById.get(item.id),
                ...updates,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      );
      setMessage("Wishlist batch updated.");
      setAuditLoaded(false);
    } catch (requestError) {
      setMessage(requestError.message);
    }
  }

  const allUsers = [
    ...users.map((item) => ({ ...item, kind: "user" })),
    ...invites.map((item) => ({ ...item, kind: "invite", uid: item.id })),
  ];
  const selectedUser = allUsers.find((item) => (item.uid || item.id) === selectedUserKey) || allUsers[0] || null;

  useEffect(() => {
    if (allUsers.length && (!selectedUserKey || !allUsers.some((item) => (item.uid || item.id) === selectedUserKey))) {
      setSelectedUserKey(allUsers[0].uid || allUsers[0].id);
    }
  }, [allUsers, selectedUserKey]);

  const adminTabs = [
    ["users", "Users"],
    ["watch", "Watch state"],
    ["wishlist", "Wishlist"],
    ["reports", "Reports"],
    ["audit", "Audit"],
  ];

  return (
    <main className="min-h-screen bg-[#f4f0e9] font-sans text-[#40504c]">
      <AccountBar
        apiFetch={apiFetch}
        nightMode={nightMode}
        onBack={onBack}
        onLogout={onLogout}
        onNightModeChange={onNightModeChange}
        onSaveProfile={onSaveProfile}
        showWishlist={false}
        user={user}
      />
      <section className="mx-auto max-w-7xl px-5 pb-16 sm:px-8">
        <span className="text-[10px] font-extrabold tracking-[0.24em] text-[#70837d] uppercase">Admin</span>
        <h1 className="mt-2 font-serif text-5xl leading-none text-[#334742]">Library controls</h1>
        {message && <p className="mt-4 rounded-2xl bg-[#fffdf9] px-4 py-3 text-sm font-semibold text-[#4f7f78]">{message}</p>}

        <div className="mt-8 flex flex-wrap gap-2 rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9] p-2">
          {adminTabs.map(([tab, label]) => (
            <button
              className={`rounded-full px-5 py-3 text-sm font-extrabold transition ${
                activeAdminTab === tab
                  ? "bg-[#334742] text-white"
                  : "text-[#5e746f] hover:bg-[#edf3ef]"
              }`}
              key={tab}
              onClick={() => setActiveAdminTab(tab)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        {activeAdminTab === "users" && (
          <>
            <form className="mt-5 grid gap-3 rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9] p-5 md:grid-cols-[1fr_1fr_auto_auto]" onSubmit={addUser}>
              <input className="rounded-2xl border border-[#d8ded8] px-4 py-3 text-sm" onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} placeholder="Email" type="email" value={form.email} />
              <input className="rounded-2xl border border-[#d8ded8] px-4 py-3 text-sm" onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} placeholder="Display name" value={form.displayName} />
              <select className="rounded-2xl border border-[#d8ded8] px-4 py-3 text-sm" onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))} value={form.role}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
              <button className="rounded-full bg-[#334742] px-5 py-3 text-sm font-extrabold text-white" type="submit">
                Add
              </button>
            </form>

            <section className="mt-5 rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9] p-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="font-serif text-3xl text-[#334742]">Users</h2>
                  <p className="mt-1 text-sm font-semibold text-[#71847f]">{allUsers.length} users and pending invites</p>
                </div>
                <select
                  className="w-full rounded-2xl border border-[#d8ded8] bg-white px-4 py-3 text-sm font-semibold text-[#405c56] sm:w-80"
                  onChange={(event) => setSelectedUserKey(event.target.value)}
                  value={selectedUserKey || selectedUser?.uid || selectedUser?.id || ""}
                >
                  {allUsers.map((row) => (
                    <option key={row.uid || row.id} value={row.uid || row.id}>
                      {row.email}{row.kind === "invite" ? " (pending)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mt-4">
                {selectedUser ? (
                  <AdminUserRow key={selectedUser.uid || selectedUser.id} row={selectedUser} onSave={saveUser} videos={videos} />
                ) : (
                  <p className="rounded-2xl bg-[#f4f0e9] p-4 text-sm font-semibold text-[#71847f]">No users yet.</p>
                )}
              </div>
            </section>
          </>
        )}

        {activeAdminTab === "watch" && (
          <>
            <section className="mt-5 rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9] p-5">
              <h2 className="font-serif text-3xl text-[#334742]">Latest progress</h2>
              <div className="mt-4 grid max-h-[36rem] gap-3 overflow-auto">
                {progress.length === 0 && <p className="rounded-2xl bg-[#f4f0e9] p-4 text-sm font-semibold text-[#71847f]">No watch progress yet.</p>}
                {progress.map((item) => (
                  <div className="rounded-2xl bg-[#f4f0e9] p-4 text-sm" key={item.id}>
                    <strong className="block text-[#334742]">{item.title || item.videoId}</strong>
                    <span className="mt-1 block text-xs text-[#71847f]">{item.email} / {formatTime(item.positionSeconds)} of {formatTime(item.durationSeconds)} / {Math.round(item.percent || 0)}%</span>
                    <span className="mt-1 block text-xs text-[#71847f]">{item.completed ? "Completed" : "Watching"} / {item.lastWatchedAt || "No timestamp"}</span>
                  </div>
                ))}
              </div>
            </section>

            <WatchStatsPanel events={events} progress={progress} />

            <section className="mt-5 rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9] p-5">
              <h2 className="font-serif text-3xl text-[#334742]">History</h2>
              <div className="mt-4 grid max-h-[28rem] gap-2 overflow-auto text-sm">
                {events.length === 0 && <p className="rounded-2xl bg-[#f4f0e9] p-4 text-sm font-semibold text-[#71847f]">No watch events yet.</p>}
                {events.map((item) => (
                  <div className="grid gap-1 rounded-2xl bg-[#f4f0e9] p-3 md:grid-cols-[1fr_auto_auto_auto]" key={item.id}>
                    <strong className="text-[#334742]">{item.title || item.videoId}</strong>
                    <span className="text-xs text-[#71847f]">{item.email}</span>
                    <span className="text-xs text-[#71847f]">{item.ipAddress || "No IP"}</span>
                    <span className="text-xs text-[#71847f]">{item.eventType} / {formatTime(item.positionSeconds)} / {formatDateTime(item.createdAt)}</span>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}

        {activeAdminTab === "wishlist" && (
          <div className="mt-5">
            <AdminWishlistPanel onBatchUpdate={batchUpdateWishes} onUpdate={updateWish} wishes={wishes} />
          </div>
        )}

        {activeAdminTab === "reports" && (
          <div className="mt-5">
            <AdminVideoReportsPanel onUpdate={updateReport} reports={reports} />
          </div>
        )}

        {activeAdminTab === "audit" && (
          <div className="mt-5">
            <AdminAuditPanel logs={auditLogs} />
          </div>
        )}
      </section>
    </main>
  );
}

function AdminUserRow({ onSave, row, videos }) {
  const [draft, setDraft] = useState({
    role: row.role || "user",
    status: row.status || "active",
    allowedProviders: ["google.com"],
    featureFlags: { ...DEFAULT_FEATURE_FLAGS, ...(row.featureFlags || {}) },
    contentAccess: { ...DEFAULT_CONTENT_ACCESS, ...(row.contentAccess || {}) },
  });

  function toggleFlag(flag) {
    setDraft((current) => ({
      ...current,
      featureFlags: { ...current.featureFlags, [flag]: !current.featureFlags[flag] },
    }));
  }

  const seriesGroups = useMemo(() => {
    const grouped = new Map();
    for (const video of videos || []) {
      if (!video.series) {
        continue;
      }
      const group = grouped.get(video.series) || [];
      group.push(video);
      grouped.set(video.series, group);
    }
    return [...grouped.entries()]
      .map(([name, items]) => ({
        name,
        videos: items.sort((a, b) =>
          (a.seriesOrder ?? Number.MAX_SAFE_INTEGER) - (b.seriesOrder ?? Number.MAX_SAFE_INTEGER) ||
          a.title.localeCompare(b.title),
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [videos]);

  function setAllMoviesAccess(enabled) {
    setDraft((current) => ({
      ...current,
      contentAccess: {
        ...current.contentAccess,
        mode: enabled ? "all" : "custom",
      },
    }));
  }

  function toggleVideoAccess(videoId) {
    setDraft((current) => {
      const selected = new Set(current.contentAccess.videoIds || []);
      if (selected.has(videoId)) {
        selected.delete(videoId);
      } else {
        selected.add(videoId);
      }
      return {
        ...current,
        contentAccess: {
          ...current.contentAccess,
          mode: "custom",
          videoIds: [...selected],
        },
      };
    });
  }

  function toggleSeriesAccess(seriesName) {
    setDraft((current) => {
      const selected = new Set(current.contentAccess.series || []);
      if (selected.has(seriesName)) {
        selected.delete(seriesName);
      } else {
        selected.add(seriesName);
      }
      return {
        ...current,
        contentAccess: {
          ...current.contentAccess,
          mode: "custom",
          series: [...selected],
        },
      };
    });
  }

  return (
    <div className="rounded-2xl bg-[#f4f0e9] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <strong className="block text-[#334742]">{row.email}</strong>
          <span className="text-xs font-semibold text-[#71847f]">{row.kind === "invite" ? "Pending invite" : row.uid}</span>
        </div>
        <button className="rounded-full bg-[#334742] px-4 py-2 text-xs font-extrabold text-white" onClick={() => onSave(row, draft)} type="button">
          Save
        </button>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <select className="rounded-xl border border-[#d8ded8] px-3 py-2 text-sm" onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))} value={draft.role}>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <select className="rounded-xl border border-[#d8ded8] px-3 py-2 text-sm" onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))} value={draft.status}>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>
      <div className="mt-4">
        <span className="text-[10px] font-extrabold tracking-[0.18em] text-[#71847f] uppercase">Feature access</span>
        <div className="mt-2 flex flex-wrap gap-2 text-xs font-bold text-[#5e7e76]">
          {[
            ["music", "Can enter Music"],
            ["video", "Can enter Movies"],
            ["resumePlayback", "Auto resume movies"],
            ["beta", "Beta features"],
          ].map(([flag, label]) => (
            <label className="rounded-full bg-white px-3 py-2" key={flag}>
              <input checked={Boolean(draft.featureFlags[flag])} className="mr-2" onChange={() => toggleFlag(flag)} type="checkbox" />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-2xl bg-white p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[10px] font-extrabold tracking-[0.18em] text-[#71847f] uppercase">Movie permissions</span>
          <label className="rounded-full bg-[#edf3ef] px-3 py-2 text-xs font-extrabold text-[#5e7e76]">
            <input checked={draft.contentAccess.mode === "all"} className="mr-2" onChange={(event) => setAllMoviesAccess(event.target.checked)} type="checkbox" />
            All movies
          </label>
        </div>

        {draft.contentAccess.mode === "all" && (
          <p className="mt-3 text-xs font-semibold text-[#71847f]">All movies and series are available.</p>
        )}

        {draft.contentAccess.mode !== "all" && (
          <>
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-[10px] font-extrabold tracking-[0.18em] text-[#71847f] uppercase">Series checklist</span>
                <span className="text-xs font-bold text-[#71847f]">{(draft.contentAccess.series || []).length} selected</span>
              </div>
              <div className="grid max-h-44 gap-2 overflow-auto pr-1">
                {seriesGroups.map((group) => {
                  const selected = (draft.contentAccess.series || []).includes(group.name);
                  return (
                    <label
                      className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-xs font-semibold ${selected ? "bg-[#dfeee4] text-[#355d42]" : "bg-[#f4f0e9] text-[#405c56]"}`}
                      key={group.name}
                    >
                      <span className="min-w-0 truncate">
                        <input checked={selected} className="mr-2" onChange={() => toggleSeriesAccess(group.name)} type="checkbox" />
                        {group.name}
                      </span>
                      <span className="shrink-0">{group.videos.length} movies</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-[10px] font-extrabold tracking-[0.18em] text-[#71847f] uppercase">Movie checklist</span>
                <span className="text-xs font-bold text-[#71847f]">{(draft.contentAccess.videoIds || []).length} selected</span>
              </div>
              <div className="grid max-h-56 gap-2 overflow-auto pr-1">
                {(videos || []).map((video) => {
                  const seriesGranted = video.series && (draft.contentAccess.series || []).includes(video.series);
                  const selected = (draft.contentAccess.videoIds || []).includes(video.id);
                  return (
                    <label className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold ${seriesGranted ? "bg-[#dfeee4] text-[#355d42]" : "bg-[#f4f0e9] text-[#405c56]"}`} key={video.id}>
                      <input checked={selected || Boolean(seriesGranted)} disabled={Boolean(seriesGranted)} onChange={() => toggleVideoAccess(video.id)} type="checkbox" />
                      <span className="min-w-0 truncate">{video.series ? `${video.series} / ` : ""}{video.title}</span>
                      {seriesGranted && <span className="ml-auto shrink-0 text-[10px] font-extrabold uppercase">Series</span>}
                    </label>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function WelcomeScreen({ albumsLoading, featureFlags, onChoose, totalAlbums, totalVideos, videosLoading }) {
  const choices = [
    {
      mode: "music",
      label: "Music",
      title: "Enter Music",
      subtitle: albumsLoading ? "Loading albums..." : `${totalAlbums} albums ready`,
      IconComponent: MusicIcon,
      accent: "bg-[#bf795c] text-[#fffaf4]",
      border: "hover:border-[#d8a385]",
      enabled: featureFlags?.music !== false,
    },
    {
      mode: "movies",
      label: "Video",
      title: "Enter Video",
      subtitle: videosLoading ? "Loading movies..." : `${totalVideos} movies ready`,
      IconComponent: FilmIcon,
      accent: "bg-[#4f7f78] text-[#fffaf4]",
      border: "hover:border-[#8fb3aa]",
      enabled: featureFlags?.video !== false,
    },
  ];

  return (
    <main className="min-h-screen bg-[#f4f0e9] px-5 py-8 font-sans text-[#40504c] sm:px-8 lg:px-12">
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-6xl flex-col justify-center">
        <div className="max-w-3xl">
          <span className="text-[10px] font-extrabold tracking-[0.24em] text-[#70837d] uppercase">Notion library</span>
          <h1 className="mt-3 font-serif text-5xl leading-[0.95] tracking-[-0.06em] text-[#334742] sm:text-7xl lg:text-8xl">
            Choose where to start.
          </h1>
          <p className="mt-5 max-w-xl text-sm leading-6 text-[#6f817c]">
            Open your Notion-backed collection as a music player or a video library.
          </p>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {choices.map(({ IconComponent, accent, border, enabled, label, mode, subtitle, title }) => (
            <button
              className={`group flex min-h-56 items-end justify-between gap-5 rounded-[1.5rem] border border-[#d8ded8] bg-[#fffdf9]/78 p-5 text-left shadow-[0_20px_54px_rgba(76,89,84,0.08)] transition enabled:hover:-translate-y-1 disabled:opacity-45 ${border}`}
              disabled={!enabled}
              key={mode}
              onClick={() => onChoose(mode)}
              type="button"
            >
              <span>
                <span className={`grid h-12 w-12 place-items-center rounded-2xl ${accent}`}>
                  <IconComponent className="h-6 w-6" />
                </span>
                <span className="mt-8 block text-[10px] font-extrabold tracking-[0.2em] text-[#7d918b] uppercase">{label}</span>
                <strong className="mt-2 block font-serif text-4xl leading-none text-[#344842] sm:text-5xl">{title}</strong>
                <small className="mt-3 block text-sm font-semibold text-[#71847f]">{enabled ? subtitle : "Not enabled for this account"}</small>
              </span>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-[#d7dfda] text-xl text-[#6d817b] transition group-hover:bg-[#edf5f1]">
                &rarr;
              </span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}

function SearchResults({ albums, loading, onSelectAlbum, onSelectTrack, query, tracks }) {
  return (
    <div>
      <span className="text-[10px] font-extrabold tracking-[0.24em] text-[#b56f55] uppercase">Search</span>
      <h1 className="mt-2 font-serif text-5xl tracking-[-0.06em] text-[#513a32] sm:text-7xl">
        Results for "{query}"
      </h1>
      {loading && <p className="mt-5 text-sm text-[#a27d6e]">Indexing songs from Notion...</p>}

      <section className="mt-9">
        <div className="mb-3 flex items-end justify-between gap-4">
          <h2 className="font-serif text-3xl text-[#563e35]">Songs</h2>
          <span className="text-xs font-bold text-[#ad8a7a]">{tracks.length} found</span>
        </div>
        <div className="rounded-[1.75rem] border border-[#ead8ca] bg-[#fffaf5]/75 p-2 shadow-[0_20px_48px_rgba(128,87,69,0.06)]">
          {!loading && tracks.length === 0 && (
            <p className="px-3 py-5 text-sm text-[#a78475]">No matching songs found.</p>
          )}
          {tracks.map((track, index) => (
            <button
              className="grid w-full grid-cols-[42px_1fr_auto] items-center rounded-2xl px-3 py-3 text-left transition hover:bg-[#fcf0e7]"
              key={`${track.album.id}-${track.id}`}
              onClick={() => onSelectTrack(track)}
              type="button"
            >
              <span className="text-sm tabular-nums text-[#b5988b]">{index + 1}</span>
              <span className="min-w-0">
                <strong className="block truncate text-sm text-[#634b42]">{track.title}</strong>
                <small className="mt-1 block truncate text-xs text-[#ad8a7a]">
                  {track.album.artist} / {track.album.title}
                </small>
              </span>
              {track.format === "flac" && <span className="text-[9px] font-extrabold tracking-[0.12em] text-[#789064] uppercase">FLAC</span>}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-9">
        <div className="mb-3 flex items-end justify-between gap-4">
          <h2 className="font-serif text-3xl text-[#563e35]">Albums</h2>
          <span className="text-xs font-bold text-[#ad8a7a]">{albums.length} found</span>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
          {albums.map((album) => (
            <button className="group rounded-[1.5rem] border border-transparent bg-[#fffaf5]/55 p-3 text-left transition hover:-translate-y-1 hover:border-[#e7d3c4] hover:bg-[#fffaf5]" key={album.id} onClick={() => onSelectAlbum(album)} type="button">
              <Cover album={album} size="card" />
              <strong className="mt-3 block truncate text-sm text-[#634b42]">{album.title}</strong>
              <small className="mt-1 block truncate text-xs text-[#ad8a7a]">{album.artist}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function QualityDetails({ track, metadata, loading }) {
  const [showTags, setShowTags] = useState(false);

  useEffect(() => {
    setShowTags(false);
  }, [track?.id]);

  if (!track || track.format !== "flac") {
    return null;
  }

  const items = metadata
    ? [
        ["Codec", metadata.codec],
        ["Quality", `${metadata.bitsPerSample}-bit / ${formatSampleRate(metadata.sampleRate)}`],
        ["Channels", metadata.channels === 2 ? "Stereo" : `${metadata.channels} channels`],
        ["Bitrate", metadata.bitrate ? `~${metadata.bitrate} kbps` : "Unknown"],
        ["Duration", formatTime(metadata.duration)],
        ["File size", formatBytes(metadata.fileSize)],
      ]
    : [];

  return (
    <section className="mt-5 rounded-[1.75rem] border border-[#ead8ca] bg-[#fffaf5]/75 p-5 shadow-[0_20px_48px_rgba(128,87,69,0.06)]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="text-[10px] font-extrabold tracking-[0.2em] text-[#b58b78] uppercase">Now selected</span>
          <h3 className="mt-1 font-serif text-2xl text-[#563e35]">Lossless details</h3>
        </div>
        <span className="rounded-full bg-[#e8f0df] px-3 py-1 text-[10px] font-extrabold tracking-[0.15em] text-[#668052] uppercase">FLAC lossless</span>
      </div>
      {loading && <p className="mt-4 text-sm text-[#a78475]">Reading FLAC metadata...</p>}
      {!loading && metadata && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {items.map(([label, value]) => (
              <div className="rounded-2xl bg-[#f8eee6] p-3" key={label}>
                <small className="text-[10px] font-extrabold tracking-[0.12em] text-[#b58b78] uppercase">{label}</small>
                <strong className="mt-1 block text-sm text-[#684b40]">{value}</strong>
              </div>
            ))}
          </div>
          {Object.keys(metadata.tags || {}).length > 0 && (
            <>
              <button
                className="mt-4 rounded-full border border-[#e5cdbd] bg-[#fffdf9] px-4 py-2 text-xs font-extrabold tracking-[0.08em] text-[#a3634e] transition hover:bg-[#f8eee6]"
                onClick={() => setShowTags((visible) => !visible)}
                type="button"
              >
                {showTags ? "Hide metadata" : `Show metadata (${Object.keys(metadata.tags).length})`}
              </button>
              {showTags && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(metadata.tags).map(([key, value]) => (
                    <span className="rounded-full border border-[#ead8ca] bg-[#fffdf9] px-3 py-1 text-xs text-[#89695c]" key={key}>
                      <strong className="inline text-[#a3634e]">{key}</strong>: {value}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function TrackList({ activeTrackId, album, tracks, isPlaying, loading, onPlay, metadata, metadataLoading, metadataTrack }) {
  return (
    <>
      <header className="flex min-h-56 flex-col gap-6 sm:flex-row sm:items-end">
        <Cover album={album} />
        <div className="pb-1">
          <span className="text-[10px] font-extrabold tracking-[0.24em] text-[#b56f55] uppercase">
            Album
          </span>
          <h1 className="mt-2 max-w-4xl font-serif text-5xl leading-[0.95] tracking-[-0.06em] text-[#513a32] sm:text-7xl lg:text-8xl">
            {album.title}
          </h1>
          <p className="mt-4 text-sm font-semibold text-[#a27d6e]">
            <strong className="inline text-[#664a40]">{album.artist}</strong>
            {album.year ? ` / ${album.year}` : ""}
            {album.genre ? ` / ${album.genre}` : ""}
          </p>
        </div>
      </header>

      <section className="mt-10 rounded-[1.75rem] border border-[#ead8ca] bg-[#fffaf5]/75 p-2 shadow-[0_20px_48px_rgba(128,87,69,0.08)] sm:mt-14 sm:p-3">
        <div className="grid grid-cols-[42px_1fr] border-b border-[#eddfd4] px-3 pt-2 pb-3 text-[10px] font-extrabold tracking-[0.2em] text-[#b58b78] uppercase">
          <span>#</span>
          <span>Title</span>
        </div>
        {loading && <p className="px-3 py-5 text-sm text-[#a78475]">Loading tracks...</p>}
        {!loading && tracks.length === 0 && (
          <p className="px-3 py-5 text-sm text-[#a78475]">
            No audio blocks found on this album page.
          </p>
        )}
        {tracks.map((track, index) => {
          const active = activeTrackId === track.id;
          return (
            <button
              className={`grid w-full grid-cols-[42px_1fr] items-center rounded-2xl px-3 py-3 text-left transition ${
                active ? "bg-[#f5e5d8]" : "hover:bg-[#fcf0e7]"
              }`}
              disabled={!track.url}
              key={track.id}
              onClick={() => onPlay(index)}
              type="button"
            >
              <span className={`text-sm tabular-nums ${active ? "text-[#b2644a]" : "text-[#b5988b]"}`}>
                {active && isPlaying ? <PlayIcon className="h-3.5 w-3.5 fill-current" /> : index + 1}
              </span>
              <span>
                <strong className={`block text-sm ${active ? "text-[#a7553f]" : "text-[#634b42]"}`}>
                  {track.title}
                </strong>
                <small className="mt-1 block text-xs text-[#ad8a7a]">{album.artist}</small>
                {track.format === "flac" && <small className="mt-1 block text-[10px] font-extrabold tracking-[0.12em] text-[#789064] uppercase">FLAC lossless</small>}
              </span>
            </button>
          );
        })}
      </section>
      <QualityDetails loading={metadataLoading} metadata={metadata} track={metadataTrack} />
    </>
  );
}

function QueuePanel({ open, queue, onClose, onMove, onPlay, onRemove, onReorder, repeatMode }) {
  const [draggedIndex, setDraggedIndex] = useState(null);

  if (!open) {
    return null;
  }

  return (
    <aside className="fixed right-3 bottom-[8.75rem] z-20 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-[1.5rem] border border-[#e5d2c5] bg-[#fffaf5]/98 shadow-[0_18px_54px_rgba(97,61,48,0.2)] backdrop-blur md:right-5 md:bottom-[6.75rem]">
      <div className="flex items-center justify-between border-b border-[#eddfd4] px-4 py-3">
        <div>
          <span className="text-[10px] font-extrabold tracking-[0.18em] text-[#b58b78] uppercase">Up next</span>
          <h3 className="mt-0.5 font-serif text-2xl text-[#563e35]">Play queue</h3>
        </div>
        <button className="grid h-8 w-8 place-items-center rounded-full text-xl leading-none text-[#a27d6e] hover:bg-[#f5e5d8]" onClick={onClose} type="button" aria-label="Close queue">
          &times;
        </button>
      </div>
      <div className="max-h-[min(28rem,55vh)] overflow-y-auto p-2">
        {queue.length === 0 && (
          <p className="px-3 py-5 text-sm leading-6 text-[#a78475]">
            {repeatMode === "one" ? "The current track will repeat." : "No more tracks in the queue."}
          </p>
        )}
        {queue.map(({ queueIndex, track }, position) => (
          <div
            className="flex items-center gap-2 rounded-2xl px-2 py-2 transition hover:bg-[#f8eee6]"
            draggable
            key={`${position}-${track.album.id}-${track.id}`}
            onDragEnd={() => setDraggedIndex(null)}
            onDragOver={(event) => event.preventDefault()}
            onDragStart={() => setDraggedIndex(queueIndex)}
            onDrop={() => {
              if (draggedIndex !== null) {
                onReorder(draggedIndex, queueIndex);
              }
              setDraggedIndex(null);
            }}
          >
            <span className="w-5 shrink-0 text-xs font-bold tabular-nums text-[#bd8e7a]">{position + 1}</span>
            <span className="cursor-grab text-xs tracking-[-0.2em] text-[#c49b89]" title="Drag to reorder">::</span>
            <button className="min-w-0 flex-1 text-left" onClick={() => onPlay(queueIndex)} type="button">
              <strong className="block truncate text-sm text-[#634b42]">{track.title}</strong>
              <small className="mt-1 block truncate text-xs text-[#ad8a7a]">{track.album.artist} / {track.album.title}</small>
            </button>
            <div className="flex shrink-0 items-center">
              <button className="grid h-7 w-7 place-items-center rounded-full text-[#a27d6e] hover:bg-[#eeded3] disabled:opacity-30" disabled={position === 0} onClick={() => onMove(queueIndex, -1)} title="Move earlier" type="button" aria-label={`Move ${track.title} earlier`}>
                <MoveUpIcon />
              </button>
              <button className="grid h-7 w-7 place-items-center rounded-full text-[#a27d6e] hover:bg-[#eeded3] disabled:opacity-30" disabled={position === queue.length - 1} onClick={() => onMove(queueIndex, 1)} title="Move later" type="button" aria-label={`Move ${track.title} later`}>
                <MoveDownIcon />
              </button>
              <button className="grid h-7 w-7 place-items-center rounded-full text-lg leading-none text-[#a27d6e] hover:bg-[#eeded3]" onClick={() => onRemove(queueIndex)} title="Remove from queue" type="button" aria-label={`Remove ${track.title} from queue`}>
                &times;
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function PlayerBar({
  album,
  track,
  isPlaying,
  currentTime,
  duration,
  volume,
  onToggle,
  onNext,
  onPrevious,
  onSeek,
  onVolume,
  onRefresh,
  shuffle,
  onToggleShuffle,
  repeatMode,
  onCycleRepeat,
  queueOpen,
  onToggleQueue,
}) {
  const iconButton =
    "grid h-9 w-9 place-items-center rounded-full text-[#88675a] transition hover:bg-[#f1dfd2] hover:text-[#a85e46] disabled:opacity-35";

  return (
    <footer className="fixed right-0 bottom-0 left-0 z-10 grid min-h-[7.75rem] gap-2 border-t border-[#e4d3c7] bg-[#fffaf5]/95 px-4 py-3 shadow-[0_-12px_34px_rgba(123,84,65,0.09)] backdrop-blur md:min-h-[5.5rem] md:grid-cols-[minmax(220px,1fr)_minmax(320px,1.4fr)_minmax(220px,1fr)] md:items-center md:gap-5 md:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <Cover album={album} size="mini" />
        <div className="min-w-0">
          <strong className="block truncate text-sm text-[#5e463d]">
            {track?.title || "Nothing playing"}
          </strong>
          <small className="mt-1 block truncate text-xs text-[#aa8879]">
            {album?.artist || "Select an album"}
          </small>
        </div>
      </div>

      <div className="md:block">
        <div className="absolute top-4 right-4 flex items-center justify-center gap-2 md:static md:gap-3">
          <button
            className={`${iconButton} ${shuffle ? "bg-[#f1dfd2] text-[#a85e46]" : ""}`}
            onClick={onToggleShuffle}
            disabled={!track}
            type="button"
            aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"}
            title={shuffle ? "Shuffle on" : "Shuffle off"}
          >
            <ShuffleIcon />
          </button>
          <button className={iconButton} onClick={onPrevious} disabled={!track} type="button" aria-label="Previous track">
            <PreviousIcon />
          </button>
          <button
            className="grid h-10 w-10 place-items-center rounded-full bg-[#bd7458] text-[#fffaf5] shadow-[0_8px_18px_rgba(174,100,74,0.26)] transition hover:bg-[#aa654d] disabled:opacity-35"
            onClick={onToggle}
            disabled={!track}
            type="button"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button className={iconButton} onClick={onNext} disabled={!track} type="button" aria-label="Next track">
            <NextIcon />
          </button>
          <button
            className={`${iconButton} relative ${repeatMode !== "off" ? "bg-[#f1dfd2] text-[#a85e46]" : ""}`}
            onClick={onCycleRepeat}
            disabled={!track}
            type="button"
            aria-label={`Repeat mode: ${repeatMode}`}
            title={repeatMode === "one" ? "Repeat current track" : repeatMode === "album" ? "Repeat album" : "Repeat off"}
          >
            <RepeatIcon />
            {repeatMode !== "off" && (
              <span className="absolute -right-0.5 -bottom-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-[#bd7458] px-0.5 text-[8px] font-black text-white">
                {repeatMode === "one" ? "1" : "A"}
              </span>
            )}
          </button>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] font-semibold tabular-nums text-[#ad8a7a] md:mt-2">
          <span>{formatTime(currentTime)}</span>
          <input
            aria-label="Playback position"
            className="h-1 w-full accent-[#bd7458]"
            max={duration || 0}
            min="0"
            onChange={(event) => onSeek(Number(event.target.value))}
            step="0.1"
            type="range"
            value={Math.min(currentTime, duration || 0)}
          />
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <div className="hidden items-center justify-end gap-2 text-[10px] font-extrabold tracking-[0.12em] text-[#ad8a7a] md:flex">
        <button
          className={iconButton}
          onClick={onRefresh}
          disabled={!album}
          type="button"
          title="Refresh temporary URLs"
        >
          <RefreshIcon />
        </button>
        <span>VOL</span>
        <input
          aria-label="Volume"
          className="h-1 w-24 accent-[#bd7458]"
          max="1"
          min="0"
          onChange={(event) => onVolume(Number(event.target.value))}
          step="0.01"
          type="range"
          value={volume}
        />
        <button
          className={`${iconButton} ${queueOpen ? "bg-[#f1dfd2] text-[#a85e46]" : ""}`}
          onClick={onToggleQueue}
          disabled={!track}
          type="button"
          title="Show play queue"
          aria-label="Show play queue"
        >
          <QueueIcon />
        </button>
      </div>
      <button
        className={`absolute right-4 bottom-3 grid h-8 w-8 place-items-center rounded-full text-[#88675a] transition hover:bg-[#f1dfd2] md:hidden ${queueOpen ? "bg-[#f1dfd2] text-[#a85e46]" : ""}`}
        onClick={onToggleQueue}
        disabled={!track}
        type="button"
        title="Show play queue"
        aria-label="Show play queue"
      >
        <QueueIcon />
      </button>
    </footer>
  );
}

export default function App() {
  const audioRef = useRef(null);
  const preloadRef = useRef(null);
  const preloadedTrackIdRef = useRef(null);
  const browseRequestRef = useRef(0);
  const videoRequestRef = useRef(0);
  const playlistSummaryCacheRef = useRef(new Map());
  const retryingTrackRef = useRef(null);
  const watchSessionIdRef = useRef(
    globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const searchAnalyticsRef = useRef("");
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState(firebaseConfigError);
  const [firebaseUser, setFirebaseUser] = useState(null);
  const [authProfile, setAuthProfile] = useState(null);
  const [demoItems, setDemoItems] = useState([]);
  const [demoLoading, setDemoLoading] = useState(true);
  const [demoError, setDemoError] = useState("");
  const [nightMode, setNightMode] = useState(() => {
    try {
      return window.localStorage.getItem(NIGHT_MODE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [adminOpen, setAdminOpen] = useState(false);
  const [albums, setAlbums] = useState([]);
  const [libraryTracks, setLibraryTracks] = useState([]);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [selectedAlbum, setSelectedAlbum] = useState(null);
  const [selectedTracks, setSelectedTracks] = useState([]);
  const [playbackAlbum, setPlaybackAlbum] = useState(null);
  const [playbackAlbumTracks, setPlaybackAlbumTracks] = useState([]);
  const [playbackQueue, setPlaybackQueue] = useState([]);
  const [queueCursor, setQueueCursor] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [albumsLoading, setAlbumsLoading] = useState(true);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("");
  const [year, setYear] = useState("");
  const [trackInfo, setTrackInfo] = useState(null);
  const [trackInfoLoading, setTrackInfoLoading] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState("off");
  const [queueOpen, setQueueOpen] = useState(false);
  const [viewHome, setViewHome] = useState(true);
  const [libraryMode, setLibraryMode] = useState(null);
  const [videos, setVideos] = useState([]);
  const [videosLoading, setVideosLoading] = useState(true);
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [selectedSeries, setSelectedSeries] = useState(null);
  const [selectedVideoProgress, setSelectedVideoProgress] = useState(null);
  const [videoRefreshing, setVideoRefreshing] = useState(false);
  const [continueProgress, setContinueProgress] = useState([]);
  const [moviePrefs, setMoviePrefs] = useState(DEFAULT_MOVIE_PREFS);
  const [moviePrefsLoaded, setMoviePrefsLoaded] = useState(false);

  const apiFetch = useCallback(async (url, options = {}) => {
    const token = auth?.currentUser ? await auth.currentUser.getIdToken() : "";
    const headers = { ...(options.headers || {}) };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetchJson(url, { ...options, headers });
  }, []);

  const apiFetchText = useCallback(async (url, options = {}) => {
    const token = auth?.currentUser ? await auth.currentUser.getIdToken() : "";
    const headers = { ...(options.headers || {}) };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetchText(url, { ...options, headers });
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchJson("/api/demo")
      .then((payload) => {
        if (!cancelled) {
          setDemoItems(Array.isArray(payload.items) ? payload.items : []);
          setDemoError("");
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setDemoError(requestError.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDemoLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const currentTrack = playbackQueue[queueCursor] || null;
  const ensureLibraryLoaded = useCallback(async () => {
    if (libraryLoaded || libraryLoading) {
      return;
    }
    setLibraryLoading(true);
    try {
      const tracks = await apiFetch("/api/library");
      setLibraryTracks(tracks);
      const grouped = new Map();
      for (const track of tracks) {
        const albumTracks = grouped.get(track.album.id) || [];
        albumTracks.push(track);
        grouped.set(track.album.id, albumTracks);
      }
      for (const [albumId, tracksForAlbum] of grouped) {
        playlistSummaryCacheRef.current.set(albumId, tracksForAlbum);
      }
      setLibraryLoaded(true);
    } catch (requestError) {
      setError(`Unable to index songs: ${requestError.message}`);
    } finally {
      setLibraryLoading(false);
    }
  }, [apiFetch, libraryLoaded, libraryLoading]);

  const queue = useMemo(() => {
    if (repeatMode === "one") {
      return [];
    }
    return playbackQueue
      .slice(queueCursor + 1)
      .map((track, index) => ({ queueIndex: queueCursor + index + 1, track }));
  }, [playbackQueue, queueCursor, repeatMode]);
  const upcomingTrack =
    repeatMode === "one"
      ? currentTrack
      : playbackQueue[queueCursor + 1] ||
        (repeatMode === "album" && !shuffle ? playbackQueue[0] : null);
  const genres = useMemo(
    () => [...new Set(albums.map((album) => album.genre).filter(Boolean))].sort(),
    [albums],
  );
  const years = useMemo(
    () => [...new Set(albums.map((album) => album.year).filter(Boolean))].sort((a, b) => b - a),
    [albums],
  );
  const videoGenres = useMemo(
    () => [...new Set(videos.flatMap((video) => video.genres || []).filter(Boolean))].sort(),
    [videos],
  );
  const videoYears = useMemo(
    () => [...new Set(videos.map((video) => video.year).filter(Boolean))].sort((a, b) => b - a),
    [videos],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const filteredAlbums = useMemo(() => {
    return albums.filter((album) => {
      const matchesQuery =
        !normalizedQuery ||
        `${album.title} ${album.artist}`.toLowerCase().includes(normalizedQuery);
      const matchesGenre = !genre || album.genre === genre;
      const matchesYear = !year || String(album.year) === year;
      return matchesQuery && matchesGenre && matchesYear;
    });
  }, [albums, genre, normalizedQuery, year]);
  const filteredLibraryTracks = useMemo(() => {
    if (!normalizedQuery) {
      return [];
    }
    return libraryTracks.filter((track) => {
      const matchesQuery =
        `${track.title} ${track.album.title} ${track.album.artist}`.toLowerCase().includes(normalizedQuery);
      const matchesGenre = !genre || track.album.genre === genre;
      const matchesYear = !year || String(track.album.year) === year;
      return matchesQuery && matchesGenre && matchesYear;
    });
  }, [genre, libraryTracks, normalizedQuery, year]);
  const searchAlbums = useMemo(() => {
    const matches = new Map(filteredAlbums.map((album) => [album.id, album]));
    for (const track of filteredLibraryTracks) {
      matches.set(track.album.id, track.album);
    }
    return [...matches.values()];
  }, [filteredAlbums, filteredLibraryTracks]);
  const filteredVideos = useMemo(() => {
    return videos.filter((video) => {
      const matchesQuery =
        !normalizedQuery ||
        `${video.title} ${video.series || ""} ${video.genre || ""} ${(video.genres || []).join(" ")}`.toLowerCase().includes(normalizedQuery);
      const matchesGenre = !genre || (video.genres || []).includes(genre);
      const matchesYear = !year || String(video.year) === year;
      return matchesQuery && matchesGenre && matchesYear;
    });
  }, [genre, normalizedQuery, videos, year]);
  const videoById = useMemo(() => new Map(videos.map((video) => [video.id, video])), [videos]);
  const continueItems = useMemo(() => {
    return continueProgress
      .filter((progress) => !progress.completed && Number(progress.percent || 0) < 92)
      .map((progress) => {
        const video = videoById.get(progress.videoId);
        return video ? { progress, video } : null;
      })
      .filter(Boolean)
      .slice(0, 6);
  }, [continueProgress, videoById]);
  const nextVideo = useMemo(() => {
    if (!selectedVideo?.series) {
      return null;
    }
    const candidates = videos
      .filter((video) => video.series === selectedVideo.series && video.video?.url)
      .sort((a, b) =>
        (a.seriesOrder ?? Number.MAX_SAFE_INTEGER) - (b.seriesOrder ?? Number.MAX_SAFE_INTEGER) ||
        (a.year || 0) - (b.year || 0) ||
        a.title.localeCompare(b.title),
      );
    const index = candidates.findIndex((video) => video.id === selectedVideo.id);
    return index >= 0 ? candidates[index + 1] || null : null;
  }, [selectedVideo, videos]);

  useEffect(() => {
    initAnalytics();
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("theme-midnight", nightMode);
    try {
      window.localStorage.setItem(NIGHT_MODE_STORAGE_KEY, nightMode ? "1" : "0");
    } catch {
      // Ignore localStorage failures and keep the in-memory preference.
    }
  }, [nightMode]);

  useEffect(() => {
    if (!authProfile?.uid) {
      return;
    }
    setMoviePrefsLoaded(false);
    setMoviePrefs(readMoviePrefs(authProfile.uid));
    setMoviePrefsLoaded(true);
  }, [authProfile?.uid]);

  useEffect(() => {
    if (!authProfile?.uid || !moviePrefsLoaded) {
      return;
    }
    writeMoviePrefs(authProfile.uid, moviePrefs);
  }, [authProfile?.uid, moviePrefs, moviePrefsLoaded]);

  useEffect(() => {
    if (!authReady) {
      return;
    }
    if (!authProfile) {
      trackPageView("/demo", "Public demo");
      return;
    }
    if (adminOpen) {
      trackPageView("/admin", "Admin");
      return;
    }
    if (libraryMode === "movies") {
      if (selectedVideo) {
        trackPageView(`/movies/${selectedVideo.id}`, "Movie detail");
      } else if (selectedSeries) {
        trackPageView("/movies/series", "Movie series");
      } else {
        trackPageView("/movies", "Movies");
      }
      return;
    }
    if (libraryMode === "music") {
      if (selectedAlbum) {
        trackPageView(`/music/${selectedAlbum.id}`, "Album detail");
      } else if (normalizedQuery) {
        trackPageView("/music/search", "Music search");
      } else {
        trackPageView("/music", "Music");
      }
      return;
    }
    trackPageView("/", "Welcome");
  }, [
    adminOpen,
    authProfile,
    authReady,
    libraryMode,
    normalizedQuery,
    selectedAlbum,
    selectedSeries,
    selectedVideo,
  ]);

  useEffect(() => {
    if (!authProfile || !libraryMode || normalizedQuery.length < 2) {
      return undefined;
    }
    const contentType = libraryMode === "movies" ? "video" : "music";
    const resultCount =
      libraryMode === "movies"
        ? filteredVideos.length
        : filteredLibraryTracks.length + searchAlbums.length;
    const key = `${contentType}:${normalizedQuery}:${resultCount}`;
    const timer = setTimeout(() => {
      if (searchAnalyticsRef.current === key) {
        return;
      }
      searchAnalyticsRef.current = key;
      trackAnalyticsEvent("search", {
        content_type: contentType,
        query_length: normalizedQuery.length,
        result_count: resultCount,
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [
    authProfile,
    filteredLibraryTracks.length,
    filteredVideos.length,
    libraryMode,
    normalizedQuery,
    searchAlbums.length,
  ]);

  useEffect(() => {
    if (!auth || firebaseConfigError) {
      setAuthReady(true);
      return undefined;
    }

    return onAuthStateChanged(auth, async (nextUser) => {
      setFirebaseUser(nextUser);
      if (nextUser) {
        setAuthError("");
      }
      setAuthReady(false);
      if (!nextUser) {
        setAuthProfile(null);
        setAuthReady(true);
        return;
      }
      try {
        const idToken = await nextUser.getIdToken();
        const session = await fetchJson("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        });
        setAuthProfile(session.user);
      } catch (requestError) {
        setAuthProfile(null);
        setAuthError(requestError.message);
        await signOut(auth).catch(() => {});
      } finally {
        setAuthReady(true);
      }
    });
  }, []);

  useEffect(() => {
    if (!authProfile) {
      return;
    }
    setAlbumsLoading(true);
    apiFetch("/api/albums")
      .then(setAlbums)
      .catch((requestError) => setError(requestError.message))
      .finally(() => setAlbumsLoading(false));
  }, [apiFetch, authProfile]);

  useEffect(() => {
    if (!authProfile || libraryMode !== "music") {
      return;
    }
    ensureLibraryLoaded();
  }, [authProfile, ensureLibraryLoaded, libraryMode]);

  useEffect(() => {
    if (!authProfile) {
      return;
    }
    setVideosLoading(true);
    apiFetch("/api/videos")
      .then((nextVideos) => {
        setVideos(nextVideos);
      })
      .catch((requestError) => setError(`Unable to load movies: ${requestError.message}`))
      .finally(() => setVideosLoading(false));
  }, [apiFetch, authProfile]);

  useEffect(() => {
    if (!authProfile?.featureFlags?.video || !videos.length) {
      return;
    }
    apiFetch("/api/watch-progress?limit=12")
      .then((data) => setContinueProgress(data.progress || []))
      .catch(() => {});
  }, [apiFetch, authProfile?.featureFlags?.video, videos.length]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) {
      return;
    }

    audio.src = currentTrack.url;
    audio.load();
    setCurrentTime(0);
    setDuration(0);

    if (isPlaying) {
      audio.play().catch(() => setIsPlaying(false));
    }
  }, [currentTrack?.id, currentTrack?.url]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    preloadedTrackIdRef.current = null;
    retryingTrackRef.current = null;
    if (preloadRef.current) {
      preloadRef.current.removeAttribute("src");
      preloadRef.current.load();
    }
  }, [currentTrack?.id]);

  useEffect(() => {
    if (!currentTrack?.album || currentTrack.format !== "flac") {
      setTrackInfo(null);
      setTrackInfoLoading(false);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setTrackInfo(null);
    setTrackInfoLoading(true);
    apiFetch(
      `/api/track-info/${encodeURIComponent(currentTrack.album.id)}/${encodeURIComponent(currentTrack.id)}`,
      { signal: controller.signal },
    )
      .then((metadata) => {
        if (active) {
          setTrackInfo(metadata);
        }
      })
      .catch((requestError) => {
        if (requestError.name !== "AbortError") {
          setError(`Unable to inspect FLAC metadata: ${requestError.message}`);
        }
      })
      .finally(() => {
        if (active) {
          setTrackInfoLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [apiFetch, currentTrack?.album, currentTrack?.format, currentTrack?.id]);

  useEffect(() => {
    if (!currentTrack || !("mediaSession" in navigator) || !("MediaMetadata" in window)) {
      return;
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.album.artist,
      album: currentTrack.album.title,
      artwork: currentTrack.album.cover ? [{ src: getCoverUrl(currentTrack.album), sizes: "512x512", type: "image/webp" }] : [],
    });
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    const handlers = [
      ["play", () => audioRef.current?.play()],
      ["pause", () => audioRef.current?.pause()],
      ["nexttrack", nextTrack],
      ["previoustrack", previousTrack],
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Ignore optional actions that are not implemented by this browser.
      }
    }

    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore optional actions that are not implemented by this browser.
        }
      }
    };
  }, [currentTrack, isPlaying, playbackAlbumTracks, playbackQueue, queueCursor, repeatMode, shuffle]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.target instanceof HTMLElement && event.target.matches("input, select, textarea, button")) {
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      } else if (event.code === "ArrowRight") {
        nextTrack();
      } else if (event.code === "ArrowLeft") {
        previousTrack();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentTrack, isPlaying, playbackAlbumTracks, playbackQueue, queueCursor, repeatMode, shuffle]);

  async function openAlbum(album) {
    const requestId = browseRequestRef.current + 1;
    browseRequestRef.current = requestId;
    setSelectedAlbum(album);
    setSelectedTracks(playlistSummaryCacheRef.current.get(album.id) || []);
    setViewHome(false);
    setTracksLoading(true);
    setError("");
    try {
      const nextTracks = await apiFetch(`/api/playlist/${encodeURIComponent(album.id)}`);
      playlistSummaryCacheRef.current.set(album.id, summarizeTracks(nextTracks));
      if (browseRequestRef.current === requestId) {
        setSelectedTracks(nextTracks);
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      if (browseRequestRef.current === requestId) {
        setTracksLoading(false);
      }
    }
  }

  function replaceQueueWithAlbum(album, tracks, index) {
    const next = createAlbumQueue(album, tracks, index, shuffle);
    setPlaybackAlbum(album);
    setPlaybackAlbumTracks(tracks);
    setPlaybackQueue(next.queue);
    setQueueCursor(next.cursor);
    setIsPlaying(next.queue.length > 0);
  }

  function playSelectedTrack(index) {
    const track = selectedTracks[index];
    const audio = audioRef.current;
    if (!track?.url || !selectedAlbum) {
      return;
    }

    if (currentTrack?.id === track.id && currentTrack.album.id === selectedAlbum.id && audio?.src) {
      if (audio.paused) {
        audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
      } else {
        audio.pause();
        setIsPlaying(false);
      }
      return;
    }

    replaceQueueWithAlbum(selectedAlbum, selectedTracks, index);
  }

  async function playSearchTrack(track) {
    const album = track.album;
    const requestId = browseRequestRef.current + 1;
    browseRequestRef.current = requestId;
    setSelectedAlbum(album);
    setSelectedTracks(playlistSummaryCacheRef.current.get(album.id) || []);
    setViewHome(false);
    setTracksLoading(true);
    setError("");
    try {
      const nextTracks = await apiFetch(`/api/playlist/${encodeURIComponent(album.id)}`);
      const index = nextTracks.findIndex((candidate) => candidate.id === track.id);
      if (index < 0) {
        throw new Error("The selected song is no longer available in this album.");
      }
      playlistSummaryCacheRef.current.set(album.id, summarizeTracks(nextTracks));
      if (browseRequestRef.current === requestId) {
        setSelectedTracks(nextTracks);
      }
      replaceQueueWithAlbum(album, nextTracks, index);
      setQuery("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      if (browseRequestRef.current === requestId) {
        setTracksLoading(false);
      }
    }
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || !currentTrack) {
      return;
    }

    if (audio.paused) {
      audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  }

  function advanceTrack({ ended = false } = {}) {
    if (!playbackQueue.length) {
      return;
    }

    if (ended && repeatMode === "one") {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => setIsPlaying(false));
      return;
    }

    const nextCursor = queueCursor + 1;
    if (nextCursor < playbackQueue.length) {
      setQueueCursor(nextCursor);
      setIsPlaying(true);
      return;
    }

    if (repeatMode === "album") {
      const next = createAlbumQueue(playbackAlbum, playbackAlbumTracks, shuffle ? -1 : 0, shuffle);
      setPlaybackQueue(next.queue);
      setQueueCursor(next.cursor);
      setIsPlaying(true);
      return;
    }

    setIsPlaying(false);
  }

  function nextTrack() {
    advanceTrack();
  }

  function preloadUpcomingTrack(event) {
    setCurrentTime(event.currentTarget.currentTime);
    const remaining = event.currentTarget.duration - event.currentTarget.currentTime;
    if (
      remaining > 30 ||
      !upcomingTrack ||
      upcomingTrack.id === currentTrack?.id ||
      preloadedTrackIdRef.current === upcomingTrack.id ||
      !preloadRef.current
    ) {
      return;
    }

    preloadedTrackIdRef.current = upcomingTrack.id;
    preloadRef.current.src = upcomingTrack.url;
    preloadRef.current.load();
  }

  function toggleShuffle() {
    const enabled = !shuffle;
    setShuffle(enabled);
    if (!enabled || queueCursor >= playbackQueue.length - 1) {
      return;
    }

    const played = playbackQueue.slice(0, queueCursor + 1);
    const upcoming = playbackQueue.slice(queueCursor + 1);
    for (let index = upcoming.length - 1; index > 0; index -= 1) {
      const replacement = Math.floor(Math.random() * (index + 1));
      [upcoming[index], upcoming[replacement]] = [upcoming[replacement], upcoming[index]];
    }
    setPlaybackQueue([...played, ...upcoming]);
  }

  function cycleRepeatMode() {
    setRepeatMode((current) => {
      if (current === "off") {
        return "one";
      }
      return current === "one" ? "album" : "off";
    });
  }

  function chooseQueueTrack(index) {
    setQueueOpen(false);
    setQueueCursor(index);
    setIsPlaying(true);
  }

  function moveQueueTrack(index, direction) {
    reorderQueueTrack(index, index + direction);
  }

  function reorderQueueTrack(index, target) {
    if (index <= queueCursor || target <= queueCursor || target >= playbackQueue.length || index === target) {
      return;
    }
    setPlaybackQueue((current) => {
      const next = [...current];
      const [track] = next.splice(index, 1);
      next.splice(target, 0, track);
      return next;
    });
  }

  function removeQueueTrack(index) {
    if (index <= queueCursor) {
      return;
    }
    setPlaybackQueue((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function previousTrack() {
    if (!playbackQueue.length) {
      return;
    }
    if (audioRef.current?.currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }

    if (queueCursor > 0) {
      setQueueCursor(queueCursor - 1);
      setIsPlaying(true);
      return;
    }

    if (repeatMode === "album" && playbackQueue.length) {
      setQueueCursor(playbackQueue.length - 1);
      setIsPlaying(true);
      return;
    }

    audioRef.current.currentTime = 0;
    setIsPlaying(true);
  }

  function seek(time) {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  }

  function currentMusicAnalyticsParams(extras = {}) {
    return musicAnalyticsParams(currentTrack, extras);
  }

  function handleMusicPlay() {
    setIsPlaying(true);
    trackAnalyticsEvent("music_play", currentMusicAnalyticsParams());
  }

  function handleMusicPause() {
    setIsPlaying(false);
    if (currentTrack && !audioRef.current?.ended) {
      trackAnalyticsEvent("music_pause", currentMusicAnalyticsParams({
        progress_percent:
          duration > 0 ? Math.max(0, Math.min(100, Math.round((currentTime / duration) * 100))) : 0,
      }));
    }
  }

  function handleMusicEnded() {
    trackAnalyticsEvent("music_complete", currentMusicAnalyticsParams({
      progress_percent: 100,
    }));
    advanceTrack({ ended: true });
  }

  async function refreshPlaybackUrls() {
    if (!playbackAlbum) {
      return;
    }
    const freshTracks = await apiFetch(`/api/playlist/${encodeURIComponent(playbackAlbum.id)}`);
    const freshById = new Map(freshTracks.map((track) => [track.id, track]));
    setPlaybackAlbumTracks(freshTracks);
    setPlaybackQueue((current) =>
      current.map((track) => {
        const fresh = freshById.get(track.id);
        return fresh ? { ...fresh, album: track.album } : track;
      }),
    );
    if (selectedAlbum?.id === playbackAlbum.id) {
      setSelectedTracks(freshTracks);
    }
  }

  async function requestPlaybackRefresh() {
    try {
      await refreshPlaybackUrls();
    } catch (requestError) {
      setError(`Unable to refresh temporary URLs: ${requestError.message}`);
    }
  }

  async function handlePlaybackError() {
    trackAnalyticsEvent("music_error", currentMusicAnalyticsParams());
    if (!currentTrack || retryingTrackRef.current === currentTrack.id) {
      setError("Playback failed after refreshing the temporary URL.");
      setIsPlaying(false);
      return;
    }

    retryingTrackRef.current = currentTrack.id;
    try {
      await refreshPlaybackUrls();
      setIsPlaying(true);
    } catch (requestError) {
      setError(`Playback failed: ${requestError.message}`);
      setIsPlaying(false);
    }
  }

  function goHome() {
    videoRequestRef.current += 1;
    setQuery("");
    setViewHome(true);
    setSelectedSeries(null);
    setSelectedVideo(null);
  }

  function changeGenreFilter(nextGenre) {
    setGenre(nextGenre);
    trackAnalyticsEvent("filter_change", {
      content_type: libraryMode === "movies" ? "video" : "music",
      filter_name: "genre",
      filter_set: Boolean(nextGenre),
    });
  }

  function changeYearFilter(nextYear) {
    setYear(nextYear);
    trackAnalyticsEvent("filter_change", {
      content_type: libraryMode === "movies" ? "video" : "music",
      filter_name: "year",
      filter_set: Boolean(nextYear),
    });
  }

  function changeLibraryMode(mode) {
    if (mode === "music" && authProfile?.featureFlags?.music === false) {
      setError("Music is not enabled for this account.");
      return;
    }
    if (mode === "movies" && authProfile?.featureFlags?.video === false) {
      setError("Video is not enabled for this account.");
      return;
    }
    videoRequestRef.current += 1;
    setLibraryMode(mode);
    trackAnalyticsEvent("library_mode_change", {
      content_type: mode === "movies" ? "video" : "music",
      mode,
    });
    setQuery("");
    setGenre("");
    setYear("");
    setViewHome(true);
    setError("");
    if (mode === "music") {
      setSelectedVideo(null);
      setSelectedSeries(null);
    }
  }

  async function openVideo(video) {
    const requestId = videoRequestRef.current + 1;
    videoRequestRef.current = requestId;
    const localProgress = readLocalVideoProgress(authProfile?.uid, video.id);
    setSelectedVideo(video);
    trackAnalyticsEvent("video_open", videoAnalyticsParams(video));
    setSelectedVideoProgress(localProgress);
    setSelectedSeries(null);
    setViewHome(false);
    setError("");
    setVideoRefreshing(true);

    try {
      const [freshVideo, progressData] = await Promise.all([
        apiFetch(`/api/video/${encodeURIComponent(video.id)}`),
        authProfile?.featureFlags?.resumePlayback
          ? apiFetch(`/api/watch-progress/${encodeURIComponent(video.id)}`)
          : Promise.resolve({ progress: null }),
      ]);
      if (videoRequestRef.current !== requestId) {
        return;
      }
      setSelectedVideo(freshVideo);
      setSelectedVideoProgress(newestProgress(progressData.progress, localProgress));
      setVideos((current) => current.map((item) => (item.id === freshVideo.id ? freshVideo : item)));
    } catch (requestError) {
      if (videoRequestRef.current === requestId) {
        setError(`Unable to refresh video URL: ${requestError.message}`);
      }
    } finally {
      if (videoRequestRef.current === requestId) {
        setVideoRefreshing(false);
      }
    }
  }

  function openVideoHomeItem(item) {
    if (item?.type === "series") {
      setSelectedSeries(item.group);
      setSelectedVideo(null);
      setViewHome(false);
      setError("");
      return;
    }
    openVideo(item);
  }

  function backToVideoHome() {
    videoRequestRef.current += 1;
    setSelectedSeries(null);
    setSelectedVideo(null);
    setViewHome(true);
  }

  async function refreshSelectedVideo(options = {}) {
    if (!selectedVideo) {
      return null;
    }
    const apply = options.apply !== false;
    if (apply) {
      setVideoRefreshing(true);
    }
    try {
      const freshVideo = await apiFetch(`/api/video/${encodeURIComponent(selectedVideo.id)}`);
      if (apply) {
        setSelectedVideo(freshVideo);
      }
      setVideos((current) => current.map((video) => (video.id === freshVideo.id ? freshVideo : video)));
      return freshVideo;
    } catch (requestError) {
      if (apply) {
        setError(`Unable to refresh video URL: ${requestError.message}`);
      }
      throw requestError;
    } finally {
      if (apply) {
        setVideoRefreshing(false);
      }
    }
  }

  async function loginWithGoogle() {
    if (!auth) {
      setAuthError(firebaseConfigError || "Firebase Auth is not configured.");
      return;
    }
    setAuthError("");
    await signInWithPopup(auth, googleProvider).catch((requestError) => {
      setAuthError(requestError.message);
    });
  }

  async function logout() {
    await fetchJson("/api/session", { method: "DELETE" }).catch(() => {});
    if (auth) {
      await signOut(auth).catch(() => {});
    }
    setAuthProfile(null);
    setFirebaseUser(null);
    setAuthError("");
    setAdminOpen(false);
    setLibraryMode(null);
  }

  async function saveProfile(updates) {
    const response = await apiFetch("/api/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    setAuthProfile((current) => ({ ...(current || {}), ...(response.user || {}) }));
    return response.user;
  }

  const saveVideoProgress = useCallback(
    async (payload) => {
      if (!selectedVideo) {
        return;
      }
      const progressBody = {
        ...payload,
        title: selectedVideo.title,
        series: selectedVideo.series || "",
      };
      const localProgress = writeLocalVideoProgress(authProfile?.uid, selectedVideo.id, progressBody);
      setSelectedVideoProgress((current) => newestProgress(localProgress, current));
      await apiFetch(`/api/watch-progress/${encodeURIComponent(selectedVideo.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(progressBody),
      })
        .then((response) => {
          setSelectedVideoProgress((current) => newestProgress(response.progress, current));
          setContinueProgress((current) => {
            const nextProgress = newestProgress(response.progress, localProgress);
            const withoutCurrent = current.filter((item) => item.videoId !== selectedVideo.id);
            return [nextProgress, ...withoutCurrent].filter(Boolean);
          });
        })
        .catch((requestError) => setError(`Unable to save watch progress: ${requestError.message}`));
    },
    [apiFetch, authProfile?.uid, selectedVideo],
  );

  const recordWatchEvent = useCallback(
    async (payload) => {
      if (!selectedVideo) {
        return;
      }
      await apiFetch("/api/watch-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          sessionId: watchSessionIdRef.current,
          title: selectedVideo.title,
          series: selectedVideo.series || "",
          videoId: selectedVideo.id,
        }),
      }).catch(() => {});
      const eventType = payload.eventType;
      const progressPercent =
        payload.durationSeconds > 0
          ? Math.max(0, Math.min(100, Math.round((payload.positionSeconds / payload.durationSeconds) * 100)))
          : 0;
      trackAnalyticsEvent("video_watch_event", videoAnalyticsParams(selectedVideo, {
        event_type: eventType,
        progress_percent: progressPercent,
      }));
      if (["play", "pause", "ended", "error"].includes(eventType)) {
        trackAnalyticsEvent(eventType === "ended" ? "video_complete" : `video_${eventType}`, videoAnalyticsParams(selectedVideo, {
          event_type: eventType,
          progress_percent: progressPercent,
        }));
      }
    },
    [apiFetch, selectedVideo],
  );

  async function clearVideoProgress(videoId) {
    if (!videoId) {
      return;
    }
    try {
      await apiFetch(`/api/watch-progress/${encodeURIComponent(videoId)}`, { method: "DELETE" });
      try {
        window.localStorage.removeItem(progressStorageKey(authProfile?.uid, videoId));
      } catch {
        // Ignore localStorage failures; the server state is authoritative.
      }
      setContinueProgress((current) => current.filter((item) => item.videoId !== videoId));
      if (selectedVideo?.id === videoId) {
        setSelectedVideoProgress(null);
      }
      setError("");
    } catch (requestError) {
      setError(`Unable to clear watch progress: ${requestError.message}`);
    }
  }

  async function submitVideoReport(report) {
    if (!selectedVideo) {
      return;
    }
    await apiFetch("/api/video-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...report,
        videoId: selectedVideo.id,
        videoTitle: selectedVideo.title,
      }),
    });
    trackAnalyticsEvent("video_report_submit", videoAnalyticsParams(selectedVideo, {
      report_type: report.type,
    }));
  }

  if (!authProfile) {
    return (
      <DemoLanding
        error={authError || demoError}
        items={demoItems}
        loading={demoLoading || !authReady}
        onGoogleLogin={loginWithGoogle}
      />
    );
  }

  if (adminOpen && authProfile.role === "admin") {
    return (
      <AdminDashboard
        apiFetch={apiFetch}
        nightMode={nightMode}
        onBack={() => setAdminOpen(false)}
        onLogout={logout}
        onNightModeChange={setNightMode}
        onSaveProfile={saveProfile}
        user={authProfile}
      />
    );
  }

  if (!libraryMode) {
    return (
      <div className="min-h-screen bg-[#f4f0e9]">
        <AccountBar
          apiFetch={apiFetch}
          nightMode={nightMode}
          onAdmin={() => setAdminOpen(true)}
          onBack={!viewHome ? goHome : undefined}
          onLogout={logout}
          onNightModeChange={setNightMode}
          onSaveProfile={saveProfile}
          user={authProfile}
        />
        <WelcomeScreen
          albumsLoading={albumsLoading}
          featureFlags={authProfile.featureFlags}
          onChoose={changeLibraryMode}
          totalAlbums={albums.length}
          totalVideos={videos.length}
          videosLoading={videosLoading}
        />
      </div>
    );
  }

  if (libraryMode === "movies") {
    return (
      <div className="min-h-screen bg-[#f4f0e9] font-sans text-[#405c56] md:grid md:grid-cols-[272px_1fr]">
        <MovieSidebar
          genres={videoGenres}
          genre={genre}
          loading={videosLoading}
          onGenre={changeGenreFilter}
          onHome={goHome}
          onMode={changeLibraryMode}
          onQuery={setQuery}
          onSelect={openVideo}
          query={query}
          selectedVideo={selectedVideo}
          totalVideos={videos.length}
          videos={filteredVideos}
          year={year}
          years={videoYears}
          onYear={changeYearFilter}
        />

        <main className="min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_74%_0%,rgba(145,180,169,0.26),transparent_38%)] px-5 pt-8 pb-20 sm:px-8 md:px-[clamp(2rem,5vw,4.5rem)] md:pt-11">
          <AccountBar
            apiFetch={apiFetch}
            nightMode={nightMode}
            onAdmin={() => setAdminOpen(true)}
            onBack={!viewHome ? backToVideoHome : undefined}
            onLogout={logout}
            onNightModeChange={setNightMode}
            onSaveProfile={saveProfile}
            user={authProfile}
          />
          {error && (
            <div className="mb-5 flex justify-between gap-4 rounded-2xl border border-[#c7ddd4] bg-[#eef7f2] px-4 py-3 text-sm text-[#3f756d]">
              <span>{error}</span>
              <button className="text-lg leading-none" onClick={() => setError("")} type="button" aria-label="Dismiss">
                &times;
              </button>
            </div>
          )}
          {selectedSeries && !viewHome ? (
            <SeriesDetail
              group={selectedSeries}
              onBack={backToVideoHome}
              onSelect={openVideo}
            />
          ) : selectedVideo && !viewHome ? (
            <MoviePlayer
              apiFetchText={apiFetchText}
              loading={videoRefreshing}
              nextVideo={nextVideo}
              onAutoNext={openVideo}
              onBack={backToVideoHome}
              onPrefsChange={setMoviePrefs}
              onProgress={saveVideoProgress}
              onRefresh={refreshSelectedVideo}
              onReportIssue={submitVideoReport}
              onWatchEvent={recordWatchEvent}
              prefs={moviePrefs}
              progress={selectedVideoProgress}
              resumeEnabled={authProfile.featureFlags?.resumePlayback !== false}
              video={selectedVideo}
            />
          ) : (
            <MoviesHome
              continueItems={continueItems}
              onRemoveProgress={clearVideoProgress}
              onResetProgress={clearVideoProgress}
              onSelect={openVideoHomeItem}
              videos={videos}
              visibleVideos={filteredVideos}
            />
          )}
        </main>
      </div>
    );
  }

  const player = {
    album: playbackAlbum,
    track: currentTrack,
    isPlaying,
    currentTime,
    duration,
    volume,
  };
  const activeTrackId = selectedAlbum?.id === playbackAlbum?.id ? currentTrack?.id : null;
  const metadataTrack = selectedAlbum?.id === playbackAlbum?.id ? currentTrack : null;

  return (
    <div className="min-h-screen bg-[#f8f1e9] font-sans text-[#60483f] md:grid md:grid-cols-[272px_1fr]">
      <audio
        ref={audioRef}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onEnded={handleMusicEnded}
        onError={handlePlaybackError}
        onPause={handleMusicPause}
        onPlay={handleMusicPlay}
        onTimeUpdate={preloadUpcomingTrack}
      />
      <audio ref={preloadRef} preload="auto" />

      <Sidebar
        albums={filteredAlbums}
        genres={genres}
        genre={genre}
        onGenre={changeGenreFilter}
        onHome={goHome}
        onMode={changeLibraryMode}
        onQuery={setQuery}
        selectedAlbum={selectedAlbum}
        loading={albumsLoading}
        onSelect={openAlbum}
        query={query}
        totalAlbums={albums.length}
        year={year}
        years={years}
        onYear={changeYearFilter}
      />

      <main className="min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_74%_0%,rgba(238,200,177,0.35),transparent_38%)] px-5 pt-8 pb-40 sm:px-8 md:px-[clamp(2rem,5vw,4.5rem)] md:pt-11 md:pb-32">
        <AccountBar
          apiFetch={apiFetch}
          nightMode={nightMode}
          onAdmin={() => setAdminOpen(true)}
          onLogout={logout}
          onNightModeChange={setNightMode}
          onSaveProfile={saveProfile}
          user={authProfile}
        />
        {error && (
          <div className="mb-5 flex justify-between gap-4 rounded-2xl border border-[#ecc4b1] bg-[#fff0e7] px-4 py-3 text-sm text-[#a3523d]">
            <span>{error}</span>
            <button className="text-lg leading-none" onClick={() => setError("")} type="button" aria-label="Dismiss">
              &times;
            </button>
          </div>
        )}
        {normalizedQuery ? (
          <SearchResults
            albums={searchAlbums}
            loading={libraryLoading}
            onSelectAlbum={openAlbum}
            onSelectTrack={playSearchTrack}
            query={query.trim()}
            tracks={filteredLibraryTracks}
          />
        ) : selectedAlbum && !viewHome ? (
          <TrackList
            activeTrackId={activeTrackId}
            album={selectedAlbum}
            isPlaying={isPlaying}
            loading={tracksLoading}
            metadata={trackInfo}
            metadataLoading={trackInfoLoading}
            metadataTrack={metadataTrack}
            onPlay={playSelectedTrack}
            tracks={selectedTracks}
          />
        ) : (
          <LibraryHome albums={albums} onSelect={openAlbum} visibleAlbums={filteredAlbums} />
        )}
      </main>

      <QueuePanel
        onClose={() => setQueueOpen(false)}
        onMove={moveQueueTrack}
        onPlay={chooseQueueTrack}
        onRemove={removeQueueTrack}
        onReorder={reorderQueueTrack}
        open={queueOpen}
        queue={queue}
        repeatMode={repeatMode}
      />

      <PlayerBar
        {...player}
        onNext={nextTrack}
        onPrevious={previousTrack}
        onRefresh={requestPlaybackRefresh}
        onSeek={seek}
        onToggle={togglePlayback}
        onVolume={setVolume}
        onCycleRepeat={cycleRepeatMode}
        onToggleQueue={() => setQueueOpen((open) => !open)}
        onToggleShuffle={toggleShuffle}
        queueOpen={queueOpen}
        repeatMode={repeatMode}
        shuffle={shuffle}
      />
    </div>
  );
}
