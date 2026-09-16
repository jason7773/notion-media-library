import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  getDataSourceId,
  getDemoDataSourceId,
  getVideoDataSourceId,
  queryAllAlbums,
  queryAllDemoMedia,
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
  mapDemoItem,
  mapDemoItems,
  mapLibraryTracks,
  mapTrack,
  mapTracks,
  mapVideo,
  mapVideos,
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

function ensureDemoConfigured() {
  const dataSourceId = getDemoDataSourceId();
  if (!dataSourceId) {
    const error = new Error("Demo content is not configured.");
    error.status = 404;
    throw error;
  }
  return dataSourceId;
}

function ensurePublishedDemoPage(page, dataSourceId, expectedType) {
  if (!page || !pageBelongsToDataSource(page, dataSourceId)) {
    const error = new Error("Demo item not found.");
    error.status = 404;
    throw error;
  }
  const item = mapDemoItem(page, { includeSourceUrls: true });
  if (!item || (expectedType && item.type !== expectedType)) {
    const error = new Error("Demo item not found.");
    error.status = 404;
    throw error;
  }
  return item;
}

export async function handleDemo(req, res) {
  if (handleOptions(req, res)) {
    return;
  }
  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }

  try {
    enforceDemoReadRateLimit(req, "catalog", DEMO_CATALOG_LIMIT);
    const dataSourceId = getDemoDataSourceId();
    if (!dataSourceId) {
      sendJson(req, res, 200, { enabled: false, items: [] }, "no-store");
      return;
    }
    const pages = await queryAllDemoMedia();
    const items = mapDemoItems(pages);
    sendJson(req, res, 200, { enabled: true, items }, DEMO_CATALOG_CACHE);
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleDemoMedia(req, res, pageId) {
  if (handleOptions(req, res)) {
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }
  if (!pageId) {
    sendJson(req, res, 400, { error: "Missing demo page ID." });
    return;
  }

  try {
    enforceDemoReadRateLimit(req, "asset", DEMO_ASSET_LIMIT);
    const dataSourceId = ensureDemoConfigured();
    const item = ensurePublishedDemoPage(
      await retrievePage(pageId, { fresh: true }),
      dataSourceId,
    );
    const source = await fetchMediaSource(
      req,
      item.media.sourceUrl,
      async () => {
        const fresh = await retrievePage(pageId, { fresh: true });
        return ensurePublishedDemoPage(fresh, getDemoDataSourceId()).media.sourceUrl;
      },
    );
    if (!source.ok && source.status !== 416) {
      const error = new Error(`Unable to load demo media (${source.status}).`);
      error.status = source.status >= 400 && source.status < 500 ? source.status : 502;
      throw error;
    }
    const contentType = item.type === "video" ? "video/mp4" : "audio/mpeg";
    await sendFetchResponse(req, res, source, PRIVATE_STREAM_CACHE, contentType);
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleDemoCover(req, res, pageId) {
  if (handleOptions(req, res)) {
    return;
  }
  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }
  if (!pageId) {
    sendJson(req, res, 400, { error: "Missing demo page ID." });
    return;
  }

  try {
    enforceDemoReadRateLimit(req, "asset", DEMO_ASSET_LIMIT);
    const dataSourceId = ensureDemoConfigured();
    const item = ensurePublishedDemoPage(await retrievePage(pageId, { fresh: true }), dataSourceId);
    if (!item.coverUrl) {
      sendJson(req, res, 404, { error: "Demo cover not found." });
      return;
    }
    await sendCoverImage(
      req,
      res,
      coverCacheKey("demo", pageId, item.updatedAt),
      item.coverSourceUrl,
      async () => {
        const fresh = ensurePublishedDemoPage(await retrievePage(pageId, { fresh: true }), dataSourceId);
        return fresh.coverSourceUrl;
      },
    );
  } catch (error) {
    sendError(req, res, error);
  }
}

export async function handleDemoSubtitle(req, res, pageId, subtitleIndex) {
  if (handleOptions(req, res)) {
    return;
  }
  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "Method not allowed." });
    return;
  }
  const index = Number(subtitleIndex);
  if (!pageId || !Number.isInteger(index) || index < 0) {
    sendJson(req, res, 400, { error: "Missing demo page ID or subtitle index." });
    return;
  }

  try {
    enforceDemoReadRateLimit(req, "asset", DEMO_ASSET_LIMIT);
    const dataSourceId = ensureDemoConfigured();
    const item = ensurePublishedDemoPage(await retrievePage(pageId, { fresh: true }), dataSourceId, "video");
    const subtitle = item.subtitles[index];
    if (!subtitle?.sourceUrl) {
      sendJson(req, res, 404, { error: "Demo subtitle not found." });
      return;
    }
    const source = await fetchMediaSource(req, subtitle.sourceUrl, async () => {
      const fresh = ensurePublishedDemoPage(await retrievePage(pageId, { fresh: true }), dataSourceId, "video");
      return fresh.subtitles[index]?.sourceUrl || null;
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
  let response = await fetch(sourceUrl, request);
  if (isExpiredSourceResponse(response) && refreshSourceUrl) {
    const freshUrl = await refreshSourceUrl();
    if (freshUrl) {
      response = await fetch(freshUrl, request);
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
