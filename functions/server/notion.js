import { TtlCache } from "./cache.js";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = process.env.NOTION_VERSION || "2026-03-11";
const MAX_ATTEMPTS = 3;
const notionCache = new TtlCache({ maxEntries: 600 });

function ttlMs(name, fallbackMs) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 0) {
    return fallbackMs;
  }
  return value * 1000;
}

function catalogCacheTtlMs() {
  return ttlMs("NOTION_CATALOG_CACHE_SECONDS", 24 * 60 * 60 * 1000);
}

function demoCatalogCacheTtlMs() {
  return ttlMs("NOTION_DEMO_CACHE_SECONDS", 60 * 1000);
}

function pageCacheTtlMs() {
  return ttlMs("NOTION_PAGE_CACHE_SECONDS", 10 * 60 * 1000);
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notionRequest(path, options = {}) {
  const token = getRequiredEnv("NOTION_TOKEN");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${NOTION_API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (response.ok) {
      return response.json();
    }

    const details = await response.json().catch(() => ({}));
    const retryable = response.status === 429 || response.status === 503;
    if (retryable && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : attempt * 500;
      await wait(delay);
      continue;
    }

    const error = new Error(details.message || `Notion API request failed (${response.status})`);
    error.status = response.status;
    error.code = details.code;
    throw error;
  }
}

async function queryAllPagesFresh(dataSourceId) {
  const pages = [];
  let startCursor;

  do {
    const body = { page_size: 100 };
    if (startCursor) {
      body.start_cursor = startCursor;
    }

    const response = await notionRequest(`/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    pages.push(...response.results);
    startCursor = response.has_more ? response.next_cursor : undefined;
  } while (startCursor);

  return pages;
}

async function queryAllPages(dataSourceId) {
  return notionCache.getOrSet(
    `data-source:${dataSourceId}`,
    catalogCacheTtlMs(),
    () => queryAllPagesFresh(dataSourceId),
  );
}

async function queryAllPagesWithTtl(dataSourceId, ttl) {
  return notionCache.getOrSet(
    `data-source:${dataSourceId}`,
    ttl,
    () => queryAllPagesFresh(dataSourceId),
  );
}

export async function queryAllAlbums() {
  return queryAllPages(getRequiredEnv("NOTION_DATA_SOURCE_ID"));
}

export async function queryAllVideos() {
  return queryAllPages(getRequiredEnv("NOTION_VIDEO_DATA_SOURCE_ID"));
}

export async function queryAllDemoAlbums() {
  const dataSourceId = getDemoMusicDataSourceId();
  if (!dataSourceId) {
    return [];
  }
  return queryAllPagesWithTtl(dataSourceId, demoCatalogCacheTtlMs());
}

export async function queryAllDemoVideos() {
  const dataSourceId = getDemoVideoDataSourceId();
  if (!dataSourceId) {
    return [];
  }
  return queryAllPagesWithTtl(dataSourceId, demoCatalogCacheTtlMs());
}

export async function queryAllLegacyDemoMedia() {
  const dataSourceId = getLegacyDemoDataSourceId();
  if (!dataSourceId) return [];
  return queryAllPagesWithTtl(dataSourceId, demoCatalogCacheTtlMs());
}

export async function retrievePage(pageId, options = {}) {
  const key = `page:${pageId}`;
  const loader = () => notionRequest(`/pages/${encodeURIComponent(pageId)}`);
  if (options.fresh) {
    const page = await loader();
    return notionCache.set(key, page, pageCacheTtlMs());
  }
  return notionCache.getOrSet(key, pageCacheTtlMs(), loader);
}

export async function retrieveAllBlockChildren(blockId, options = {}) {
  const key = `blocks:${blockId}`;
  const loader = async () => {
    const blocks = [];
    let startCursor;

    do {
      const search = new URLSearchParams({ page_size: "100" });
      if (startCursor) {
        search.set("start_cursor", startCursor);
      }

      const response = await notionRequest(
        `/blocks/${encodeURIComponent(blockId)}/children?${search.toString()}`,
      );

      blocks.push(...response.results);
      startCursor = response.has_more ? response.next_cursor : undefined;
    } while (startCursor);

    return blocks;
  };

  if (options.fresh) {
    const blocks = await loader();
    return notionCache.set(key, blocks, pageCacheTtlMs());
  }
  return notionCache.getOrSet(key, pageCacheTtlMs(), loader);
}

export function getDataSourceId() {
  return getRequiredEnv("NOTION_DATA_SOURCE_ID");
}

export function getVideoDataSourceId() {
  return getRequiredEnv("NOTION_VIDEO_DATA_SOURCE_ID");
}

function normalizedDataSourceId(value) {
  return String(value || "").replaceAll("-", "").toLowerCase();
}

function getSafeDemoDataSourceId(name, otherDemoNames) {
  const value = String(process.env[name] || "").trim();
  const normalized = normalizedDataSourceId(value);
  if (!normalized) return "";
  const privateSources = [process.env.NOTION_DATA_SOURCE_ID, process.env.NOTION_VIDEO_DATA_SOURCE_ID];
  const demoSources = [otherDemoNames].flat().map((otherName) => process.env[otherName]);
  if ([...privateSources, ...demoSources].some((candidate) => normalizedDataSourceId(candidate) === normalized)) {
    return "";
  }
  return value;
}

export function getDemoMusicDataSourceId() {
  return getSafeDemoDataSourceId("NOTION_DEMO_MUSIC_DATA_SOURCE_ID", "NOTION_DEMO_VIDEO_DATA_SOURCE_ID");
}

export function getDemoVideoDataSourceId() {
  return getSafeDemoDataSourceId("NOTION_DEMO_VIDEO_DATA_SOURCE_ID", "NOTION_DEMO_MUSIC_DATA_SOURCE_ID");
}

export function getLegacyDemoDataSourceId() {
  return getSafeDemoDataSourceId(
    "NOTION_DEMO_DATA_SOURCE_ID",
    ["NOTION_DEMO_MUSIC_DATA_SOURCE_ID", "NOTION_DEMO_VIDEO_DATA_SOURCE_ID"],
  );
}
