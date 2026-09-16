import test from "node:test";
import assert from "node:assert/strict";
import {
  enforceUserWriteRateLimit,
  filterVideosForUser,
  normalizeProgressBody,
  rateLimitBucketId,
  requireAdmin,
  requireAuthenticatedUser,
  requireFeature,
  handleWishlist,
  setApiCors,
} from "../functions/server/auth.js";
import { handleVideoStream, handleVideos } from "../functions/server/handlers.js";

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

test("requireAuthenticatedUser rejects requests without a token or session cookie", async () => {
  await assert.rejects(
    () => requireAuthenticatedUser({ headers: {} }),
    /Sign in is required/,
  );
});

test("requireFeature blocks disabled feature flags", () => {
  assert.throws(
    () => requireFeature({ featureFlags: { music: false } }, "music"),
    /not allowed/,
  );
});

test("requireAdmin blocks non-admin profiles", () => {
  assert.throws(() => requireAdmin({ role: "user" }), /Admin access is required/);
});

test("filterVideosForUser applies selected video and series access", () => {
  const videos = [
    { id: "one", series: "A" },
    { id: "two", series: "B" },
    { id: "three", series: "" },
  ];

  assert.deepEqual(
    filterVideosForUser(videos, {
      featureFlags: { video: true },
      contentAccess: { mode: "videos", videoIds: ["two"] },
    }),
    [{ id: "two", series: "B" }],
  );

  assert.deepEqual(
    filterVideosForUser(videos, {
      featureFlags: { video: true },
      contentAccess: { mode: "series", series: ["A"] },
    }),
    [{ id: "one", series: "A" }],
  );
});

test("protected video route returns 401 before loading Notion data", async () => {
  const req = { headers: {}, method: "GET", url: "/api/videos" };
  const res = mockResponse();

  await handleVideos(req, res);

  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Sign in is required/);
});

test("protected video stream route returns 401 before loading Notion data", async () => {
  const req = { headers: {}, method: "GET", url: "/api/video-stream/video-id" };
  const res = mockResponse();

  await handleVideoStream(req, res, "video-id");

  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Sign in is required/);
});

test("protected wishlist route returns 401 before loading Firestore data", async () => {
  const req = { headers: {}, method: "GET", url: "/api/wishlist" };
  const res = mockResponse();

  await handleWishlist(req, res);

  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Sign in is required/);
});

test("normalizeProgressBody bounds client-provided strings", () => {
  const progress = normalizeProgressBody(
    {
      durationSeconds: 100,
      eventType: "x".repeat(80),
      positionSeconds: 50,
      series: "s".repeat(200),
      title: "t".repeat(300),
    },
    { email: "user@example.test", uid: "uid" },
    "video-id",
  );

  assert.equal(progress.title.length, 200);
  assert.equal(progress.series.length, 120);
  assert.equal(progress.eventType.length, 40);
  assert.equal(progress.percent, 50);
});

test("rate limit helper rejects writes after the configured bucket is full", async () => {
  const store = new Map();
  const db = {
    collection(collectionName) {
      return {
        doc(id) {
          return { collectionName, id };
        },
      };
    },
    async runTransaction(callback) {
      const transaction = {
        async get(ref) {
          const data = store.get(ref.id);
          return {
            exists: Boolean(data),
            data: () => data,
          };
        },
        set(ref, data) {
          store.set(ref.id, data);
        },
      };
      await callback(transaction);
    },
  };
  const user = { uid: "uid/with/slash" };

  await enforceUserWriteRateLimit(db, user, "wishlist", 1, 60_000, 120_000);
  await assert.rejects(
    () => enforceUserWriteRateLimit(db, user, "wishlist", 1, 60_000, 120_001),
    /Too many requests/,
  );

  assert.equal(rateLimitBucketId(user, "wishlist", 60_000, 120_000), "wishlist_uid_with_slash_2");
});

test("setApiCors does not reflect unknown origins when origins are wildcard configured", () => {
  const previous = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = "*";
  const res = mockResponse();

  setApiCors({ headers: { origin: "https://evil.example" } }, res);

  assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
  assert.equal(res.headers["Access-Control-Allow-Credentials"], undefined);
  if (previous === undefined) {
    delete process.env.ALLOWED_ORIGINS;
  } else {
    process.env.ALLOWED_ORIGINS = previous;
  }
});
