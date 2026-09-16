import test from "node:test";
import assert from "node:assert/strict";
import { coverCacheKey, fetchMediaSource, handleDemo, handleDemoCover, handleDemoMedia, handleDemoSubtitle } from "../functions/server/handlers.js";
import { retrievePage } from "../functions/server/notion.js";

function mockResponse() {
  return {
    headers: {},
    statusCode: 0,
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body = "") {
      this.body = body;
    },
  };
}

test("demo catalog is disabled without a demo data source", async () => {
  const previous = process.env.NOTION_DEMO_DATA_SOURCE_ID;
  delete process.env.NOTION_DEMO_DATA_SOURCE_ID;
  const res = mockResponse();
  try {
    await handleDemo({ method: "GET", headers: {}, url: "/api/demo", ip: "198.51.100.30" }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { enabled: false, items: [] });
  } finally {
    if (previous === undefined) {
      delete process.env.NOTION_DEMO_DATA_SOURCE_ID;
    } else {
      process.env.NOTION_DEMO_DATA_SOURCE_ID = previous;
    }
  }
});

test("demo asset routes stay unavailable when the demo data source is not configured", async () => {
  const previous = process.env.NOTION_DEMO_DATA_SOURCE_ID;
  delete process.env.NOTION_DEMO_DATA_SOURCE_ID;
  try {
    for (const handler of [
      (req, res) => handleDemoMedia(req, res, "page-id"),
      (req, res) => handleDemoCover(req, res, "page-id"),
      (req, res) => handleDemoSubtitle(req, res, "page-id", "0"),
    ]) {
      const res = mockResponse();
      await handler({ method: "GET", headers: {}, url: "/api/demo", ip: "198.51.100.40" }, res);
      assert.equal(res.statusCode, 404);
    }
  } finally {
    if (previous === undefined) delete process.env.NOTION_DEMO_DATA_SOURCE_ID;
    else process.env.NOTION_DEMO_DATA_SOURCE_ID = previous;
  }
});

test("demo catalog returns only published items from the demo data source", async () => {
  const previousFetch = global.fetch;
  const previousToken = process.env.NOTION_TOKEN;
  const previousDataSource = process.env.NOTION_DEMO_DATA_SOURCE_ID;
  const dataSourceId = `demo-source-${Date.now()}`;
  process.env.NOTION_TOKEN = "test-token";
  process.env.NOTION_DEMO_DATA_SOURCE_ID = dataSourceId;
  global.fetch = async (url) => {
    assert.match(String(url), new RegExp(`/data_sources/${dataSourceId}/query$`));
    return new Response(JSON.stringify({
      results: [
        {
          id: "hidden",
          properties: {
            Name: { title: [{ plain_text: "Hidden" }] },
            Type: { select: { name: "Music" } },
            Published: { checkbox: false },
            Media: { files: [{ type: "file", name: "hidden.mp3", file: { url: "https://example.test/hidden.mp3" } }] },
          },
        },
        {
          id: "published",
          properties: {
            Name: { title: [{ plain_text: "Published" }] },
            Type: { select: { name: "Music" } },
            Published: { checkbox: true },
            Media: { files: [{ type: "file", name: "published.mp3", file: { url: "https://example.test/published.mp3" } }] },
          },
        },
      ],
      has_more: false,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const res = mockResponse();
    await handleDemo({ method: "GET", headers: {}, url: "/api/demo", ip: `198.51.100.${Date.now() % 200}` }, res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.enabled, true);
    assert.deepEqual(payload.items.map((item) => item.id), ["published"]);
    assert.equal(payload.items[0].media.url, "/api/demo/media/published");
    assert.equal(payload.items[0].media.sourceUrl, undefined);
    assert.equal(payload.items[0].sourceUrl, null);
  } finally {
    global.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = previousToken;
    if (previousDataSource === undefined) delete process.env.NOTION_DEMO_DATA_SOURCE_ID;
    else process.env.NOTION_DEMO_DATA_SOURCE_ID = previousDataSource;
  }
});

test("fetchMediaSource forwards range requests and retries expired signed URLs", async () => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return new Response("expired", { status: 403 });
    }
    return new Response("ok", {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": "bytes 10-11/100",
      },
    });
  };

  try {
    const response = await fetchMediaSource(
      { headers: { range: "bytes=10-11" }, method: "GET" },
      "https://notion.example/old",
      async () => "https://notion.example/new",
    );

    assert.equal(response.status, 206);
    assert.deepEqual(
      calls.map((call) => call.url),
      ["https://notion.example/old", "https://notion.example/new"],
    );
    assert.equal(calls[0].options.headers.Range, "bytes=10-11");
    assert.equal(calls[1].options.headers.Range, "bytes=10-11");
  } finally {
    global.fetch = previousFetch;
  }
});

test("cover cache keys stay stable across changing signed URLs", () => {
  assert.equal(
    coverCacheKey("video", "page-id", "2026-06-03T12:00:00.000Z"),
    "video:page-id:2026-06-03T12:00:00.000Z",
  );
});

test("retrievePage fresh option bypasses and replaces stale cache entries", async () => {
  const previousFetch = global.fetch;
  const previousToken = process.env.NOTION_TOKEN;
  const pageId = `fresh-page-${Date.now()}`;
  let calls = 0;

  process.env.NOTION_TOKEN = "test-token";
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: pageId, revision: calls }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const first = await retrievePage(pageId);
    const cached = await retrievePage(pageId);
    const fresh = await retrievePage(pageId, { fresh: true });
    const cachedFresh = await retrievePage(pageId);

    assert.equal(first.revision, 1);
    assert.equal(cached.revision, 1);
    assert.equal(fresh.revision, 2);
    assert.equal(cachedFresh.revision, 2);
    assert.equal(calls, 2);
  } finally {
    global.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.NOTION_TOKEN;
    } else {
      process.env.NOTION_TOKEN = previousToken;
    }
  }
});
