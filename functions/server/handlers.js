import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  getDataSourceId,
  getDemoMusicDataSourceId,
  getDemoVideoDataSourceId,
  getLegacyDemoDataSourceId,
  getVideoDataSourceId,
  queryAllAlbums,
  queryAllDemoAlbums,
  queryAllDemoVideos,
  queryAllLegacyDemoMedia,
  queryAllVideos,
  retrieveAllBlockChildren,
  retrievePage,
} from "./notion.js";
import sharp from "sharp";
import { TtlCache } from "./cache.js";
import { inspectFlac } from "./flac.js";
import {
  ensureVideoAllowed,
  filterVideosForUser,
  handleApiOptions,
  requireAuthenticatedUser,
  requireFeature,
  sendApiJson,
  sendAuthError,
  setApiCors,
} from "./auth.js";
import {
  isFlacBlock,
  mapAlbum,
  mapAlbums,
  mapLibraryTracks,
  mapLegacyDemoAlbum,
  mapLegacyDemoItem,
  mapLegacyDemoTrack,
  mapLegacyDemoVideo,
  mapTrack,
  mapTracks,
  mapVideo,
  mapVideos,
  isPublishedPage,
  pageBelongsToDataSource,
} from "./catalog.js";

const COVER_SIZES = new Set([96, 256, 512]);
const LIBRARY_ALBUM_CONCURRENCY = 5;
const COVER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COVER_CACHE_MAX_BYTES = 25 * 1024 * 1024;
const SUBTITLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SUBTITLE_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const PRIVATE_MEDIA_CACHE = "private, max-age=86400";
const PRIVATE_SHORT_CACHE = "private, max-age=300";
const PRIVATE_STREAM_CACHE = "private, no-store";
const DEMO_CATALOG_CACHE = "public, max-age=60, stale-while-revalidate=60";
const DEMO_ASSET_CACHE = "public, max-age=300";
const DEMO_READ_WINDOW_MS = 60 * 1000;
const DEMO_CATALOG_LIMIT = 30;
const DEMO_ASSET_LIMIT = 120;
const coverCache = new TtlCache({ maxBytes: COVER_CACHE_MAX_BYTES, maxEntries: 120 });
const subtitleCache = new TtlCache({ maxBytes: SUBTITLE_CACHE_MAX_BYTES, maxEntries: 100 });
const demoReadBuckets = new Map();

function getAllowedOrigin(req) {
  const configured = process.env.ALLOWED_ORIGINS || "*";
  if (configured === "*") {
    return "*";
  }

  const origin = req.headers.origin;
  const allowed = configured
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return allowed.includes(origin) ? origin : null;
}

function setCors(req, res) {
  setApiCors(req, res);
}

function sendJson(req, res, status, payload, cacheControl = "no-store") {
  sendApiJson(req, res, status, payload, cacheControl);
}

function sendError(req, res, error) {
  const status = error.status >= 400 && error.status < 600 ? error.status : 500;
  const message =
    status === 500 ? "Unable to load music data right now." : error.message;

  if (status === 500) {
    console.error(error);
  }

  sendJson(req, res, status, { error: message });
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function handleOptions(req, res) {
  return handleApiOptions(req, res);
}

function demoClientAddress(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 120);
}

export function enforceDemoReadRateLimit(req, action, limit, nowMs = Date.now()) {
  const bucket = Math.floor(nowMs / DEMO_READ_WINDOW_MS);
  const key = `${demoClientAddress(req)}:${action}:${bucket}`;
  const count = (demoReadBuckets.get(key) || 0) + 1;
  demoReadBuckets.set(key, count);
  if (demoReadBuckets.size > 2000) {
    const oldestAllowedBucket = bucket - 1;
    for (const existingKey of demoReadBuckets.keys()) {
      const existingBucket = Number(existingKey.slice(existingKey.lastIndexOf(":") + 1));
      if (Number.isFinite(existingBucket) && existingBucket < oldestAllowedBucket) {
        demoReadBuckets.delete(existingKey);
      }
    }
    while (demoReadBuckets.size > 2000) {
      const oldestKey = demoReadBuckets.keys().next().value;
      if (oldestKey === undefined) break;
      demoReadBuckets.delete(oldestKey);
    }
  }
  if (count > limit) {
    const error = new Error("Demo request limit reached. Please try again later.");
    error.status = 429;
    throw error;
  }
}

async function authenticatedUser(req, res, feature) {
  try {
    const user = await requireAuthenticatedUser(req);
    if (feature) {
      requireFeature(user, feature);
    }
    return user;
  } catch (error) {
    sendAuthError(req, res, error);
    return null;
  }
}

function demoSourceFor(kind) {
  const dedicatedSource = kind === "music" ? getDemoMusicDataSourceId() : getDemoVideoDataSourceId();
  return dedicatedSource || getLegacyDemoDataSourceId();
}

function demoUsesLegacySource(kind) {
  const dedicatedSource = kind === "music" ? getDemoMusicDataSourceId() : getDemoVideoDataSourceId();
  return !dedicatedSource && Boolean(getLegacyDemoDataSourceId());
}

function ensurePublishedPage(page, kind) {
  const dataSourceId = demoSourceFor(kind);
  if (!dataSourceId || !pageBelongsToDataSource(page, dataSourceId) || !isPublishedPage(page)) {
    const error = new Error("Demo item not found.");
    error.status = 404;
    throw error;
  }
  if (demoUsesLegacySource(kind) && mapLegacyDemoItem(page)?.type !== kind) {
    const error = new Error("Demo item not found.");
    error.status = 404;
    throw error;
  }
  return page;
}

function legacyEntries(pages, sourceId, kind) {
  return pages
    .filter((page) => pageBelongsToDataSource(page, sourceId))
    .map((page) => ({ page, item: mapLegacyDemoItem(page) }))
    .filter(({ item }) => item?.type === kind)
    .sort((a, b) => (a.item.order ?? Number.MAX_SAFE_INTEGER) - (b.item.order ?? Number.MAX_SAFE_INTEGER) || a.item.title.localeCompare(b.item.title));
}

function ensureAudioBlock(block) {
  if (!block || !(block.type === "audio" || isFlacBlock(block))) {
    const error = new Error("Demo track not found.");
    error.status = 404;
    throw error;
  }
  const mappedTrack = mapTrack(block, 0);
  const sourceName = block[block.type]?.name || mappedTrack.url?.split("?")[0].split("/").pop() || "";
  const extension = sourceName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "";
  const track = { ...mappedTrack, format: extension || mappedTrack.format };
  if (!track.url || !["flac", "mp3", "m4a", "ogg", "oga", "wav", "aac"].includes(track.format.toLowerCase())) {
    const error = new Error("Demo track not found.");
    error.status = 404;
    throw error;
  }
  return track;
}

function ensureDemoVideo(page) {
  const video = mapVideo(page);
  if (!video.video?.url || !/\.(mp4|webm|m4v)$/i.test(video.video.name)) {
    const error = new Error("Demo video not found.");
    error.status = 404;
    throw error;
  }
  return video;
}

export async function handleDemoCatalog(req, res, kind) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }
  try {
    enforceDemoReadRateLimit(req, `catalog:${kind}`, DEMO_CATALOG_LIMIT);
    if (kind === "albums") {
      const sourceId = getDemoMusicDataSourceId();
      if (sourceId) {
        const pages = await queryAllDemoAlbums();
        sendJson(req, res, 200, mapAlbums(pages.filter((page) => pageBelongsToDataSource(page, sourceId) && isPublishedPage(page)), { demo: true }), DEMO_CATALOG_CACHE);
      } else {
        const legacySourceId = getLegacyDemoDataSourceId();
        const entries = legacySourceId ? legacyEntries(await queryAllLegacyDemoMedia(), legacySourceId, "music") : [];
        sendJson(req, res, 200, entries.map(({ page }) => mapLegacyDemoAlbum(page)), DEMO_CATALOG_CACHE);
      }
      return;
    }
    if (kind === "library") {
      const sourceId = getDemoMusicDataSourceId();
      if (sourceId) {
        const pages = await queryAllDemoAlbums();
        const albums = mapAlbums(pages.filter((page) => pageBelongsToDataSource(page, sourceId) && isPublishedPage(page)), { demo: true });
        const tracks = await mapWithConcurrency(albums, LIBRARY_ALBUM_CONCURRENCY, async (album) => {
          const blocks = await retrieveAllBlockChildren(album.id);
          return mapLibraryTracks(album, blocks, { demo: true });
        });
        sendJson(req, res, 200, tracks.flat(), DEMO_CATALOG_CACHE);
      } else {
        const legacySourceId = getLegacyDemoDataSourceId();
        const entries = legacySourceId ? legacyEntries(await queryAllLegacyDemoMedia(), legacySourceId, "music") : [];
        sendJson(req, res, 200, entries.map(({ page }) => {
          const album = mapLegacyDemoAlbum(page);
          const track = mapLegacyDemoTrack(page, album);
          if (track) delete track.url;
          return track;
        }).filter(Boolean), DEMO_CATALOG_CACHE);
      }
      return;
    }
    if (kind === "videos") {
      const sourceId = getDemoVideoDataSourceId();
      let videos;
      if (sourceId) {
        const pages = await queryAllDemoVideos();
        const publishedPages = pages.filter((page) => pageBelongsToDataSource(page, sourceId) && isPublishedPage(page));
        videos = mapVideos(publishedPages, { proxyVideo: true, proxySubtitles: true, demo: true, apiPrefix: "/api/demo" })
          .filter((video) => video.video?.name && /\.(mp4|webm|m4v)$/i.test(video.video.name));
      } else {
        const legacySourceId = getLegacyDemoDataSourceId();
        const entries = legacySourceId ? legacyEntries(await queryAllLegacyDemoMedia(), legacySourceId, "video") : [];
        videos = entries.map(({ page }) => mapLegacyDemoVideo(page)).filter(Boolean);
      }
      sendJson(req, res, 200, videos, DEMO_CATALOG_CACHE);
      return;
    }
    sendJson(req, res, 404, { error: "Demo catalog not found." });
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleDemoPage(req, res, kind, pageId) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET" || !pageId) {
    sendJson(req, res, req.method === "GET" ? 400 : 405, { error: req.method === "GET" ? "Missing demo page ID." : "Method not allowed." });
    return;
  }
  try {
    enforceDemoReadRateLimit(req, "asset", DEMO_ASSET_LIMIT);
    const musicPage = kind === "album" || kind === "playlist";
    const page = ensurePublishedPage(await retrievePage(pageId, { fresh: true }), musicPage ? "music" : "video");
    const legacy = demoUsesLegacySource(musicPage ? "music" : "video");
    if (kind === "album") {
      sendJson(req, res, 200, legacy ? mapLegacyDemoAlbum(page) : mapAlbum(page, { demo: true }), DEMO_CATALOG_CACHE);
    } else if (kind === "playlist") {
      if (legacy) {
        sendJson(req, res, 200, [mapLegacyDemoTrack(page)].filter(Boolean), DEMO_CATALOG_CACHE);
      } else {
        const blocks = await retrieveAllBlockChildren(pageId, { fresh: true });
        sendJson(req, res, 200, mapTracks(blocks, { demo: true, albumId: pageId }), DEMO_CATALOG_CACHE);
      }
    } else if (kind === "video") {
      if (legacy) {
        sendJson(req, res, 200, mapLegacyDemoVideo(page), DEMO_CATALOG_CACHE);
      } else {
        ensureDemoVideo(page);
        sendJson(req, res, 200, mapVideo(page, { proxyVideo: true, proxySubtitles: true, demo: true, apiPrefix: "/api/demo" }), DEMO_CATALOG_CACHE);
      }
    } else {
      sendJson(req, res, 404, { error: "Demo route not found." });
    }
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleDemoTrackInfo(req, res, albumId, blockId) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET" || !albumId || !blockId) {
    sendJson(req, res, req.method === "GET" ? 400 : 405, { error: "Invalid demo track request." });
    return;
  }
  try {
    enforceDemoReadRateLimit(req, "asset", DEMO_ASSET_LIMIT);
    const page = ensurePublishedPage(await retrievePage(albumId, { fresh: true }), "music");
    if (demoUsesLegacySource("music")) {
      const item = mapLegacyDemoItem(page, { includeSourceUrls: true });
      if (blockId !== page.id || item?.media?.format !== "flac") {
        sendJson(req, res, 404, { error: "FLAC track not found." });
        return;
      }
      const metadata = await inspectFlac(item.media.sourceUrl, { cacheKey: `demo-legacy:${page.id}:${page.last_edited_time || "1"}` });
      sendJson(req, res, 200, { id: page.id, title: item.title, ...metadata }, DEMO_CATALOG_CACHE);
      return;
    }
    const blocks = await retrieveAllBlockChildren(albumId, { fresh: true });
    const block = blocks.find((candidate) => candidate.id === blockId);
    const track = ensureAudioBlock(block);
    if (track.format !== "flac") {
      sendJson(req, res, 404, { error: "FLAC track not found." });
      return;
    }
    const metadata = await inspectFlac(track.url, { cacheKey: `demo:${page.id}:${block.id}:${block.last_edited_time || page.last_edited_time || "1"}` });
    sendJson(req, res, 200, { id: track.id, title: track.title, ...metadata }, DEMO_CATALOG_CACHE);
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleDemoMediaAsset(req, res, kind, pageId, blockId = "") {
  if (handleOptions(req, res)) return;
  if ((req.method !== "GET" && req.method !== "HEAD") || !pageId || (kind === "music" && !blockId)) {
    sendJson(req, res, req.method === "GET" || req.method === "HEAD" ? 400 : 405, { error: "Invalid demo media request." });
    return;
  }
  try {
    enforceDemoReadRateLimit(req, "asset", DEMO_ASSET_LIMIT);
    const page = ensurePublishedPage(await retrievePage(pageId, { fresh: true }), kind);
    let sourceUrl;
    let contentType;
    let refreshSource;
    if (demoUsesLegacySource(kind)) {
      const item = mapLegacyDemoItem(page, { includeSourceUrls: true });
      if (!item || (kind === "music" && blockId !== page.id)) {
        const error = new Error("Demo media not found.");
        error.status = 404;
        throw error;
      }
      sourceUrl = item.media.sourceUrl;
      const types = { flac: "audio/flac", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", aac: "audio/aac", mp4: "video/mp4", webm: "video/webm", m4v: "video/mp4" };
      contentType = types[item.media.format] || "application/octet-stream";
      refreshSource = async () => {
        const freshPage = ensurePublishedPage(await retrievePage(pageId, { fresh: true }), kind);
        return mapLegacyDemoItem(freshPage, { includeSourceUrls: true })?.media?.sourceUrl || null;
      };
    } else if (kind === "music") {
      const blocks = await retrieveAllBlockChildren(pageId, { fresh: true });
      const block = blocks.find((candidate) => candidate.id === blockId);
      const track = ensureAudioBlock(block);
      sourceUrl = track.url;
      const types = { flac: "audio/flac", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", aac: "audio/aac" };
      contentType = types[track.format] || "application/octet-stream";
      refreshSource = async () => {
        const freshPage = ensurePublishedPage(await retrievePage(pageId, { fresh: true }), "music");
        const freshBlocks = await retrieveAllBlockChildren(freshPage.id, { fresh: true });
        return ensureAudioBlock(freshBlocks.find((candidate) => candidate.id === blockId)).url;
      };
    } else {
      const video = ensureDemoVideo(page);
      sourceUrl = video.video.url;
      contentType = video.video.name.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4";
      refreshSource = async () => {
        const freshPage = ensurePublishedPage(await retrievePage(pageId, { fresh: true }), "video");
        return ensureDemoVideo(freshPage).video.url;
      };
    }
    const source = await fetchMediaSource(req, sourceUrl, refreshSource);
    if (!source.ok && source.status !== 416) {
      const error = new Error(`Unable to load demo media (${source.status}).`);
      error.status = source.status >= 400 && source.status < 500 ? source.status : 502;
      throw error;
    }
    await sendFetchResponse(req, res, source, PRIVATE_STREAM_CACHE, contentType);
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleDemoCoverAsset(req, res, kind, pageId) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET" || !pageId) {
    sendJson(req, res, req.method === "GET" ? 400 : 405, { error: "Invalid demo cover request." });
    return;
  }
  try {
    enforceDemoReadRateLimit(req, "asset", DEMO_ASSET_LIMIT);
    const page = ensurePublishedPage(await retrievePage(pageId, { fresh: true }), kind);
    if (demoUsesLegacySource(kind)) {
      const item = mapLegacyDemoItem(page, { includeSourceUrls: true });
      if (!item?.coverSourceUrl) {
        sendJson(req, res, 404, { error: "Demo cover not found." });
        return;
      }
      await sendCoverImage(req, res, coverCacheKey(`demo-legacy-${kind}`, pageId, page.last_edited_time), item.coverSourceUrl, async () => {
        const fresh = ensurePublishedPage(await retrievePage(pageId, { fresh: true }), kind);
        return mapLegacyDemoItem(fresh, { includeSourceUrls: true })?.coverSourceUrl || null;
      });
      return;
    }
    const media = kind === "music" ? mapAlbum(page) : mapVideo(page);
    if (!media.cover) {
      sendJson(req, res, 404, { error: "Demo cover not found." });
      return;
    }
    await sendCoverImage(req, res, coverCacheKey(`demo-${kind}`, pageId, page.last_edited_time), media.cover, async () => {
      const fresh = ensurePublishedPage(await retrievePage(pageId, { fresh: true }), kind);
      return (kind === "music" ? mapAlbum(fresh) : mapVideo(fresh)).cover;
    });
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleDemoSubtitleAsset(req, res, pageId, subtitleIndex) {
  if (handleOptions(req, res)) return;
  const index = Number(subtitleIndex);
  if (req.method !== "GET" || !pageId || !Number.isInteger(index) || index < 0) {
    sendJson(req, res, req.method === "GET" ? 400 : 405, { error: "Invalid demo subtitle request." });
    return;
  }
  try {
    enforceDemoReadRateLimit(req, "asset", DEMO_ASSET_LIMIT);
    const page = ensurePublishedPage(await retrievePage(pageId, { fresh: true }), "video");
    const legacy = demoUsesLegacySource("video");
    const subtitle = legacy
      ? mapLegacyDemoItem(page, { includeSourceUrls: true })?.subtitles[index]
      : mapVideo(page).subtitles[index];
    if (!subtitle?.url) {
      sendJson(req, res, 404, { error: "Demo subtitle not found." });
      return;
    }
    const source = await fetchMediaSource(req, subtitle.sourceUrl || subtitle.url, async () => {
      const fresh = ensurePublishedPage(await retrievePage(pageId, { fresh: true }), "video");
      return legacy
        ? mapLegacyDemoItem(fresh, { includeSourceUrls: true })?.subtitles[index]?.sourceUrl || null
        : mapVideo(fresh).subtitles[index]?.url || null;
    });
    if (!source.ok) {
      const error = new Error(`Unable to load demo subtitle (${source.status}).`);
      error.status = source.status;
      throw error;
    }
    setCors(req, res);
    res.statusCode = 200;
    res.setHeader("Cache-Control", DEMO_ASSET_CACHE);
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.end(await source.text());
  } catch (error) {
    sendError(req, res, error);
  }
}

function getCoverSize(req) {
  const rawSize =
    req.query?.size ||
    new URL(req.url, "http://localhost").searchParams.get("size");
  const size = Number(rawSize);
  return COVER_SIZES.has(size) ? size : 256;
}

function stringBytes(value) {
  return Buffer.byteLength(value, "utf8");
}

export function coverCacheKey(type, pageId, version) {
  return `${type}:${pageId}:${version || "1"}`;
}

function isExpiredSourceResponse(response) {
  return response.status === 401 || response.status === 403;
}

export async function fetchMediaSource(req, sourceUrl, refreshSourceUrl, options = {}) {
  const method = options.method || (req.method === "HEAD" ? "HEAD" : "GET");
  const headers = {};
  if (req.headers?.range) {
    headers.Range = req.headers.range;
  }

  const request = { method, headers };
  let activeSourceUrl = sourceUrl;
  let response = await fetch(activeSourceUrl, request);
  if (isExpiredSourceResponse(response) && refreshSourceUrl) {
    const freshUrl = await refreshSourceUrl();
    if (freshUrl) {
      activeSourceUrl = freshUrl;
      response = await fetch(activeSourceUrl, request);
    }
  }

  // Some Notion file hosts reject HEAD even though they support ranged GET.
  // Use a one-byte range only to obtain equivalent response headers.
  if (method === "HEAD" && response.status === 403) {
    const fallbackHeaders = { ...headers, Range: headers.Range || "bytes=0-0" };
    response = await fetch(activeSourceUrl, { method: "GET", headers: fallbackHeaders });
    if (isExpiredSourceResponse(response) && refreshSourceUrl) {
      const freshUrl = await refreshSourceUrl();
      if (freshUrl) {
        response = await fetch(freshUrl, { method: "GET", headers: fallbackHeaders });
      }
    }
  }
  return response;
}

function copyResponseHeader(source, res, name) {
  const value = source.headers.get(name);
  if (value) {
    res.setHeader(name, value);
  }
}

async function sendFetchResponse(req, res, source, cacheControl, fallbackContentType) {
  setCors(req, res);
  res.statusCode = source.status;
  res.setHeader("Cache-Control", cacheControl);
  copyResponseHeader(source, res, "Accept-Ranges");
  copyResponseHeader(source, res, "Content-Length");
  copyResponseHeader(source, res, "Content-Range");
  copyResponseHeader(source, res, "ETag");
  copyResponseHeader(source, res, "Last-Modified");
  res.setHeader("Content-Type", source.headers.get("Content-Type") || fallbackContentType);

  if (req.method === "HEAD") {
    if (source.body) {
      await source.body.cancel().catch(() => {});
    }
    res.end();
    return;
  }

  if (!source.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(source.body), res);
}

export async function handleAlbums(req, res) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }

  try {
    const user = await authenticatedUser(req, res, "music");
    if (!user) {
      return;
    }
    const albums = mapAlbums(await queryAllAlbums());
    sendJson(req, res, 200, albums);
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleLibrary(req, res) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }

  try {
    const user = await authenticatedUser(req, res, "music");
    if (!user) {
      return;
    }
    const albums = mapAlbums(await queryAllAlbums());
    const groupedTracks = await mapWithConcurrency(albums, LIBRARY_ALBUM_CONCURRENCY, async (album) => {
      const blocks = await retrieveAllBlockChildren(album.id);
      return mapLibraryTracks(album, blocks);
    });
    const library = groupedTracks.flat();
    sendJson(req, res, 200, library);
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleVideos(req, res) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }

  try {
    const user = await authenticatedUser(req, res, "video");
    if (!user) {
      return;
    }
    const videos = filterVideosForUser(
      mapVideos(await queryAllVideos(), { proxySubtitles: true, proxyVideo: true }),
      user,
    );
    sendJson(req, res, 200, videos);
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleVideo(req, res, pageId) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }

  if (!pageId) {
    sendJson(req, res, 400, { error: "Missing video page ID." });
    return;
  }

  try {
    const user = await authenticatedUser(req, res, "video");
    if (!user) {
      return;
    }
    const page = await retrievePage(pageId, { fresh: true });
    if (!pageBelongsToDataSource(page, getVideoDataSourceId())) {
      sendJson(req, res, 404, { error: "Video not found." });
      return;
    }

    const video = mapVideo(page, { includeProxyVideoUrl: true, proxySubtitles: true });
    ensureVideoAllowed(user, video);
    sendJson(req, res, 200, video);
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleVideoStream(req, res, pageId) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }

  if (!pageId) {
    sendJson(req, res, 400, { error: "Missing video page ID." });
    return;
  }

  try {
    const user = await authenticatedUser(req, res, "video");
    if (!user) {
      return;
    }

    const page = await retrievePage(pageId, { fresh: true });
    if (!pageBelongsToDataSource(page, getVideoDataSourceId())) {
      sendJson(req, res, 404, { error: "Video not found." });
      return;
    }

    const proxiedVideo = mapVideo(page, { proxySubtitles: true, proxyVideo: true });
    ensureVideoAllowed(user, proxiedVideo);

    const sourceVideo = mapVideo(page);
    if (!sourceVideo.video?.url) {
      sendJson(req, res, 404, { error: "Video file not found." });
      return;
    }

    const source = await fetchMediaSource(
      req,
      sourceVideo.video.url,
      async () => {
        const freshPage = await retrievePage(pageId, { fresh: true });
        if (!pageBelongsToDataSource(freshPage, getVideoDataSourceId())) {
          return null;
        }
        return mapVideo(freshPage).video?.url;
      },
    );

    if (!source.ok && source.status !== 416) {
      const error = new Error(`Unable to stream video (${source.status}).`);
      error.status = source.status >= 400 && source.status < 500 ? source.status : 502;
      throw error;
    }

    await sendFetchResponse(req, res, source, PRIVATE_STREAM_CACHE, "video/mp4");
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleVideoSubtitle(req, res, pageId, subtitleIndex) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }

  const index = Number(subtitleIndex);
  if (!pageId || !Number.isInteger(index) || index < 0) {
    sendJson(req, res, 400, { error: "Missing video page ID or subtitle index." });
    return;
  }

  try {
    const user = await authenticatedUser(req, res, "video");
    if (!user) {
      return;
    }
    const page = await retrievePage(pageId, { fresh: true });
    if (!pageBelongsToDataSource(page, getVideoDataSourceId())) {
      sendJson(req, res, 404, { error: "Video not found." });
      return;
    }

    const video = mapVideo(page);
    ensureVideoAllowed(user, video);
    const subtitle = video.subtitles[index];
    if (!subtitle?.url) {
      sendJson(req, res, 404, { error: "Subtitle not found." });
      return;
    }

    const body = await subtitleCache.getOrSet(
      `subtitle:${pageId}:${index}:${page.last_edited_time || "1"}`,
      SUBTITLE_CACHE_TTL_MS,
      async () => {
        const source = await fetchMediaSource(
          req,
          subtitle.url,
          async () => {
            const freshPage = await retrievePage(pageId, { fresh: true });
            const freshSubtitle = mapVideo(freshPage).subtitles[index];
            return freshSubtitle?.url;
          },
          { method: "GET" },
        );
        if (!source.ok) {
          const error = new Error(`Unable to download subtitle (${source.status}).`);
          error.status = source.status;
          throw error;
        }

        return source.text();
      },
      stringBytes,
    );
    setCors(req, res);
    res.statusCode = 200;
    res.setHeader("Cache-Control", PRIVATE_SHORT_CACHE);
    res.setHeader("Content-Length", String(stringBytes(body)));
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.end(body);
  } catch (error) {
    sendError(req, res, error);
  }
}

async function sendCoverImage(req, res, cacheKey, sourceUrl, refreshSourceUrl) {
  const size = getCoverSize(req);
  const image = await coverCache.getOrSet(
    `cover:${cacheKey}:${size}`,
    COVER_CACHE_TTL_MS,
    async () => {
      const source = await fetchMediaSource(
        req,
        sourceUrl,
        refreshSourceUrl,
        { method: "GET" },
      );
      if (!source.ok) {
        const error = new Error(`Unable to download cover (${source.status}).`);
        error.status = source.status;
        throw error;
      }

      return sharp(Buffer.from(await source.arrayBuffer()))
        .rotate()
        .resize(size, size, { fit: "cover", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
    },
    (buffer) => buffer.byteLength,
  );

  setCors(req, res);
  res.statusCode = 200;
  res.setHeader("Cache-Control", PRIVATE_MEDIA_CACHE);
  res.setHeader("Content-Length", String(image.length));
  res.setHeader("Content-Type", "image/webp");
  res.end(image);
}

export async function handleCover(req, res, pageId) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }

  if (!pageId) {
    sendJson(req, res, 400, { error: "Missing album page ID." });
    return;
  }

  try {
    const user = await authenticatedUser(req, res, "music");
    if (!user) {
      return;
    }
    const page = await retrievePage(pageId, { fresh: true });
    if (!pageBelongsToDataSource(page, getDataSourceId())) {
      sendJson(req, res, 404, { error: "Album not found." });
      return;
    }

    const album = mapAlbum(page);
    if (!album.cover) {
      sendJson(req, res, 404, { error: "Album cover not found." });
      return;
    }

    await sendCoverImage(
      req,
      res,
      coverCacheKey("album", pageId, album.coverVersion),
      album.cover,
      async () => {
        const freshPage = await retrievePage(pageId, { fresh: true });
        return mapAlbum(freshPage).cover;
      },
    );
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleVideoCover(req, res, pageId) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }

  if (!pageId) {
    sendJson(req, res, 400, { error: "Missing video page ID." });
    return;
  }

  try {
    const user = await authenticatedUser(req, res, "video");
    if (!user) {
      return;
    }
    const page = await retrievePage(pageId, { fresh: true });
    if (!pageBelongsToDataSource(page, getVideoDataSourceId())) {
      sendJson(req, res, 404, { error: "Video not found." });
      return;
    }

    const video = mapVideo(page);
    ensureVideoAllowed(user, video);
    if (!video.cover) {
      sendJson(req, res, 404, { error: "Video cover not found." });
      return;
    }

    await sendCoverImage(
      req,
      res,
      coverCacheKey("video", pageId, video.coverVersion),
      video.cover,
      async () => {
        const freshPage = await retrievePage(pageId, { fresh: true });
        return mapVideo(freshPage).cover;
      },
    );
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handlePlaylist(req, res, pageId) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }

  if (!pageId) {
    sendJson(req, res, 400, { error: "Missing album page ID." });
    return;
  }

  try {
    const user = await authenticatedUser(req, res, "music");
    if (!user) {
      return;
    }
    const page = await retrievePage(pageId, { fresh: true });
    if (!pageBelongsToDataSource(page, getDataSourceId())) {
      sendJson(req, res, 404, { error: "Album not found." });
      return;
    }

    const tracks = mapTracks(await retrieveAllBlockChildren(pageId, { fresh: true }));
    sendJson(req, res, 200, tracks);
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleTrackInfo(req, res, pageId, blockId) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }

  if (!pageId || !blockId) {
    sendJson(req, res, 400, { error: "Missing album page ID or track block ID." });
    return;
  }

  try {
    const user = await authenticatedUser(req, res, "music");
    if (!user) {
      return;
    }
    const page = await retrievePage(pageId, { fresh: true });
    if (!pageBelongsToDataSource(page, getDataSourceId())) {
      sendJson(req, res, 404, { error: "Album not found." });
      return;
    }

    const blocks = await retrieveAllBlockChildren(pageId, { fresh: true });
    const block = blocks.find((candidate) => candidate.id === blockId);
    if (!block || !isFlacBlock(block)) {
      sendJson(req, res, 404, { error: "FLAC track not found." });
      return;
    }

    const track = mapTrack(block, blocks.indexOf(block));
    const metadata = await inspectFlac(track.url, {
      cacheKey: `${pageId}:${block.id}:${block.last_edited_time || page.last_edited_time || "1"}`,
    });
    sendJson(req, res, 200, { id: track.id, title: track.title, ...metadata });
  } catch (error) {
    sendError(req, res, error);
  }
}
