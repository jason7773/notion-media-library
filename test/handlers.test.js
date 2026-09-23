import test from "node:test";
import assert from "node:assert/strict";
import { coverCacheKey, fetchMediaSource, handleDemoCatalog, handleDemoMediaAsset } from "../functions/server/handlers.js";
import { retrievePage } from "../functions/server/notion.js";

function mockResponse() {
  return {
    headers: {}, statusCode: 0, body: "",
    setHeader(name, value) { this.headers[name] = value; },
    end(body = "") { this.body = body; },
  };
}

test("demo catalogs return empty lists when their data source is not configured", async () => {
  const previous = process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID;
  delete process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID;
  try {
    const res = mockResponse();
    await handleDemoCatalog({ method: "GET", headers: {}, url: "/api/demo/albums", ip: "198.51.100.30" }, res, "albums");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), []);
  } finally {
    if (previous === undefined) delete process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID;
    else process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID = previous;
  }
});

test("demo source IDs that match a private source are disabled", async () => {
  const previousPrivate = process.env.NOTION_DATA_SOURCE_ID;
  const previousDemo = process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID;
  process.env.NOTION_DATA_SOURCE_ID = "shared-private-source";
  process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID = "shared-private-source";
  try {
    const res = mockResponse();
    await handleDemoCatalog({ method: "GET", headers: {}, url: "/api/demo/albums", ip: "198.51.100.31" }, res, "albums");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), []);
  } finally {
    if (previousPrivate === undefined) delete process.env.NOTION_DATA_SOURCE_ID; else process.env.NOTION_DATA_SOURCE_ID = previousPrivate;
    if (previousDemo === undefined) delete process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID; else process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID = previousDemo;
  }
});

test("demo music catalog exposes only published albums belonging to its source", async () => {
  const previousFetch = global.fetch;
  const previousToken = process.env.NOTION_TOKEN;
  const previousSource = process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID;
  const dataSourceId = `demo-music-${Date.now()}`;
  process.env.NOTION_TOKEN = "test-token";
  process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID = dataSourceId;
  global.fetch = async (url) => {
    assert.match(String(url), new RegExp(`/data_sources/${dataSourceId}/query$`));
    return new Response(JSON.stringify({ results: [
      { id: "published", parent: { type: "data_source_id", data_source_id: dataSourceId }, properties: { Name: { title: [{ plain_text: "Published Album" }] }, Published: { checkbox: true } } },
      { id: "hidden", parent: { type: "data_source_id", data_source_id: dataSourceId }, properties: { Name: { title: [{ plain_text: "Hidden Album" }] }, Published: { checkbox: false } } },
      { id: "foreign", parent: { type: "data_source_id", data_source_id: "other-source" }, properties: { Name: { title: [{ plain_text: "Foreign Album" }] }, Published: { checkbox: true } } },
    ], has_more: false }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const res = mockResponse();
    await handleDemoCatalog({ method: "GET", headers: {}, url: "/api/demo/albums", ip: `198.51.100.${Date.now() % 200}` }, res, "albums");
    const albums = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(albums.map((album) => album.id), ["published"]);
    assert.equal(albums[0].coverUrl, undefined);
  } finally {
    global.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.NOTION_TOKEN; else process.env.NOTION_TOKEN = previousToken;
    if (previousSource === undefined) delete process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID; else process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID = previousSource;
  }
});

test("legacy Demo Media is used when dedicated demo sources are not configured", async () => {
  const previousFetch = global.fetch;
  const previousToken = process.env.NOTION_TOKEN;
  const previousLegacy = process.env.NOTION_DEMO_DATA_SOURCE_ID;
  const previousMusic = process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID;
  const previousVideo = process.env.NOTION_DEMO_VIDEO_DATA_SOURCE_ID;
  const dataSourceId = `legacy-demo-${Date.now()}`;
  process.env.NOTION_TOKEN = "test-token";
  process.env.NOTION_DEMO_DATA_SOURCE_ID = dataSourceId;
  delete process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID;
  delete process.env.NOTION_DEMO_VIDEO_DATA_SOURCE_ID;
  global.fetch = async (url) => {
    assert.match(String(url), new RegExp(`/data_sources/${dataSourceId}/query$`));
    return new Response(JSON.stringify({ results: [
      {
        id: "legacy-music",
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        properties: {
          Name: { title: [{ plain_text: "Legacy song" }] },
          Type: { select: { name: "Music" } },
          Published: { checkbox: true },
          Media: { files: [{ type: "file", name: "song.mp3", file: { url: "https://notion.example/song.mp3" } }] },
        },
      },
      {
        id: "legacy-video",
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        properties: {
          Name: { title: [{ plain_text: "Legacy video" }] },
          Type: { select: { name: "Video" } },
          Published: { checkbox: true },
          Media: { files: [{ type: "file", name: "video.mp4", file: { url: "https://notion.example/video.mp4" } }] },
        },
      },
      {
        id: "hidden",
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        properties: {
          Name: { title: [{ plain_text: "Hidden" }] },
          Type: { select: { name: "Music" } },
          Published: { checkbox: false },
          Media: { files: [{ type: "file", name: "hidden.mp3", file: { url: "https://notion.example/hidden.mp3" } }] },
        },
      },
    ], has_more: false }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const albumResponse = mockResponse();
    await handleDemoCatalog({ method: "GET", headers: {}, url: "/api/demo/albums", ip: "198.51.100.60" }, albumResponse, "albums");
    assert.deepEqual(JSON.parse(albumResponse.body).map((item) => item.id), ["legacy-music"]);
    const videoResponse = mockResponse();
    await handleDemoCatalog({ method: "GET", headers: {}, url: "/api/demo/videos", ip: "198.51.100.61" }, videoResponse, "videos");
    assert.deepEqual(JSON.parse(videoResponse.body).map((item) => item.id), ["legacy-video"]);
  } finally {
    global.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.NOTION_TOKEN; else process.env.NOTION_TOKEN = previousToken;
    if (previousLegacy === undefined) delete process.env.NOTION_DEMO_DATA_SOURCE_ID; else process.env.NOTION_DEMO_DATA_SOURCE_ID = previousLegacy;
    if (previousMusic === undefined) delete process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID; else process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID = previousMusic;
    if (previousVideo === undefined) delete process.env.NOTION_DEMO_VIDEO_DATA_SOURCE_ID; else process.env.NOTION_DEMO_VIDEO_DATA_SOURCE_ID = previousVideo;
  }
});

test("demo video catalog exposes only published videos from its separate source with proxied assets", async () => {
  const previousFetch = global.fetch;
  const previousToken = process.env.NOTION_TOKEN;
  const previousMusicSource = process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID;
  const previousVideoSource = process.env.NOTION_DEMO_VIDEO_DATA_SOURCE_ID;
  const dataSourceId = `demo-video-${Date.now()}`;
  process.env.NOTION_TOKEN = "test-token";
  process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID = `${dataSourceId}-music`;
  process.env.NOTION_DEMO_VIDEO_DATA_SOURCE_ID = dataSourceId;
  global.fetch = async (url) => {
    assert.match(String(url), new RegExp(`/data_sources/${dataSourceId}/query$`));
    return new Response(JSON.stringify({ results: [
      {
        id: "published-video",
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        last_edited_time: "2026-09-23T00:00:00Z",
        properties: {
          Name: { title: [{ plain_text: "Published video" }] },
          Published: { checkbox: true },
          Video: { files: [{ type: "file", name: "sample.mp4", file: { url: "https://notion.example/sample.mp4" } }] },
          Cover: { files: [{ type: "file", name: "cover.png", file: { url: "https://notion.example/cover.png" } }] },
          Subtitles: { files: [{ type: "file", name: "sample.en.vtt", file: { url: "https://notion.example/sample.en.vtt" } }] },
        },
      },
      {
        id: "unpublished-video",
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        properties: { Name: { title: [{ plain_text: "Hidden" }] }, Published: { checkbox: false } },
      },
      {
        id: "foreign-video",
        parent: { type: "data_source_id", data_source_id: "foreign-source" },
        properties: { Name: { title: [{ plain_text: "Foreign" }] }, Published: { checkbox: true } },
      },
    ], has_more: false }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const res = mockResponse();
    await handleDemoCatalog({ method: "GET", headers: {}, url: "/api/demo/videos", ip: `198.51.100.${(Date.now() + 1) % 200}` }, res, "videos");
    const videos = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(videos.map((video) => video.id), ["published-video"]);
    assert.equal(videos[0].video.url, "/api/demo/video-stream/published-video?v=2026-09-23T00%3A00%3A00Z");
    assert.equal(videos[0].coverUrl, "/api/demo/video-cover/published-video");
    assert.equal(videos[0].subtitles[0].url, "/api/demo/video-subtitle/published-video/0?v=2026-09-23T00%3A00%3A00Z");
  } finally {
    global.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.NOTION_TOKEN; else process.env.NOTION_TOKEN = previousToken;
    if (previousMusicSource === undefined) delete process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID; else process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID = previousMusicSource;
    if (previousVideoSource === undefined) delete process.env.NOTION_DEMO_VIDEO_DATA_SOURCE_ID; else process.env.NOTION_DEMO_VIDEO_DATA_SOURCE_ID = previousVideoSource;
  }
});

test("demo media rejects unpublished and cross-source pages before streaming", async () => {
  const previousFetch = global.fetch;
  const previousToken = process.env.NOTION_TOKEN;
  const previousSource = process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID;
  const sourceId = "demo-music-security";
  process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID = sourceId;
  process.env.NOTION_TOKEN = "test-token";
  const makePage = (parentId, published) => ({
    id: "demo-album", parent: { type: "data_source_id", data_source_id: parentId },
    properties: { Published: { checkbox: published } },
  });
  try {
    for (const [parentId, published] of [["other-source", true], [sourceId, false]]) {
      global.fetch = async () => new Response(JSON.stringify(makePage(parentId, published)), { status: 200, headers: { "Content-Type": "application/json" } });
      const res = mockResponse();
      await handleDemoMediaAsset({ method: "GET", headers: {}, url: "/api/demo/track/demo-album/block-id", ip: `198.51.100.${published ? 41 : 42}` }, res, "music", "demo-album", "block-id");
      assert.equal(res.statusCode, 404);
    }
  } finally {
    global.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.NOTION_TOKEN; else process.env.NOTION_TOKEN = previousToken;
    if (previousSource === undefined) delete process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID; else process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID = previousSource;
  }
});

test("fetchMediaSource forwards range requests and retries expired signed URLs", async () => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response("expired", { status: 403 });
    return new Response("ok", { status: 206, headers: { "Accept-Ranges": "bytes", "Content-Range": "bytes 10-11/100" } });
  };
  try {
    const response = await fetchMediaSource({ headers: { range: "bytes=10-11" }, method: "GET" }, "https://notion.example/old", async () => "https://notion.example/new");
    assert.equal(response.status, 206);
    assert.deepEqual(calls.map((call) => call.url), ["https://notion.example/old", "https://notion.example/new"]);
    assert.equal(calls[0].options.headers.Range, "bytes=10-11");
    assert.equal(calls[1].options.headers.Range, "bytes=10-11");
  } finally { global.fetch = previousFetch; }
});

test("fetchMediaSource falls back to a ranged GET when HEAD is rejected", async () => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response("head forbidden", { status: 403 });
    return new Response(null, { status: 206, headers: { "Accept-Ranges": "bytes", "Content-Range": "bytes 0-0/100", "Content-Length": "1" } });
  };
  try {
    const response = await fetchMediaSource({ headers: {}, method: "HEAD" }, "https://notion.example/media", null);
    assert.equal(response.status, 206);
    assert.equal(calls[0].options.method, "HEAD");
    assert.equal(calls[1].options.method, "GET");
    assert.equal(calls[1].options.headers.Range, "bytes=0-0");
  } finally { global.fetch = previousFetch; }
});

test("cover cache keys stay stable across changing signed URLs", () => {
  assert.equal(coverCacheKey("video", "page-id", "2026-06-03T12:00:00.000Z"), "video:page-id:2026-06-03T12:00:00.000Z");
});

test("retrievePage fresh option bypasses and replaces stale cache entries", async () => {
  const previousFetch = global.fetch;
  const previousToken = process.env.NOTION_TOKEN;
  const pageId = `fresh-page-${Date.now()}`;
  let calls = 0;
  process.env.NOTION_TOKEN = "test-token";
  global.fetch = async () => new Response(JSON.stringify({ id: pageId, revision: ++calls }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const first = await retrievePage(pageId);
    const cached = await retrievePage(pageId);
    const fresh = await retrievePage(pageId, { fresh: true });
    const cachedFresh = await retrievePage(pageId);
    assert.deepEqual([first.revision, cached.revision, fresh.revision, cachedFresh.revision, calls], [1, 1, 2, 2, 2]);
  } finally {
    global.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.NOTION_TOKEN; else process.env.NOTION_TOKEN = previousToken;
  }
});
