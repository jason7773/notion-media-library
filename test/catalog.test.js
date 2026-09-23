import test from "node:test";
import assert from "node:assert/strict";
import {
  mapAlbum,
  mapLibraryTracks,
  mapLegacyDemoAlbum,
  mapLegacyDemoTrack,
  mapLegacyDemoVideo,
  mapTracks,
  mapVideo,
  isPublishedPage,
  pageBelongsToDataSource,
} from "../functions/server/catalog.js";
import { parseFlacMetadata } from "../functions/server/flac.js";

test("demo publication gate accepts only an explicit Published checkbox", () => {
  assert.equal(isPublishedPage({ properties: { Published: { checkbox: true } } }), true);
  assert.equal(isPublishedPage({ properties: { Published: { checkbox: false } } }), false);
  assert.equal(isPublishedPage({ properties: {} }), false);
});

test("mapAlbum reads expected Notion properties", () => {
  const album = mapAlbum({
    id: "album-id",
    properties: {
      Name: { title: [{ plain_text: "Example Track" }] },
      Artist: { rich_text: [{ plain_text: "Example Artist" }] },
      Year: { number: 2024 },
      Genre: { select: { name: "K-Pop" } },
      Cover: { files: [{ type: "file", file: { url: "https://example.test/cover" } }] },
    },
  });

  assert.deepEqual(album, {
    id: "album-id",
    title: "Example Track",
    artist: "Example Artist",
    year: 2024,
    genre: "K-Pop",
    cover: "https://example.test/cover",
    coverVersion: null,
  });
});

test("demo album, track, video, and subtitle URLs use the shared catalog model", () => {
  const album = mapAlbum({
    id: "demo-album",
    last_edited_time: "2026-09-23",
    properties: {
      Name: { title: [{ plain_text: "Demo Album" }] },
      Cover: { files: [{ type: "file", file: { url: "https://example.test/cover.jpg" } }] },
    },
  }, { demo: true });
  assert.equal(album.coverUrl, "/api/demo/cover/demo-album");

  const tracks = mapTracks([{
    id: "track-one",
    type: "audio",
    audio: { name: "track.mp3", external: { url: "https://example.test/track.mp3" } },
  }], { demo: true, albumId: "demo-album" });
  assert.equal(tracks[0].url, "/api/demo/track/demo-album/track-one");
  assert.equal(tracks[0].format, "mp3");

  const video = mapVideo({
    id: "demo-video",
    last_edited_time: "2026-09-23",
    properties: {
      Name: { title: [{ plain_text: "Demo Video" }] },
      Cover: { files: [{ type: "file", name: "cover.jpg", file: { url: "https://example.test/cover.jpg" } }] },
      Video: { files: [{ type: "file", name: "demo.mp4", file: { url: "https://example.test/demo.mp4" } }] },
      Subtitles: { files: [{ type: "file", name: "demo.zh-Hant.vtt", file: { url: "https://example.test/demo.vtt" } }] },
    },
  }, { proxyVideo: true, proxySubtitles: true, demo: true, apiPrefix: "/api/demo" });
  assert.equal(video.video.url, "/api/demo/video-stream/demo-video?v=2026-09-23");
  assert.equal(video.coverUrl, "/api/demo/video-cover/demo-video");
  assert.equal(video.subtitles[0].url, "/api/demo/video-subtitle/demo-video/0?v=2026-09-23");
});

test("legacy Demo Media rows adapt to the shared album, track, and video models", () => {
  const basePage = {
    id: "legacy-item",
    last_edited_time: "2026-09-24T00:00:00Z",
    properties: {
      Name: { title: [{ plain_text: "Legacy sample" }] },
      Artist: { rich_text: [{ plain_text: "Demo artist" }] },
      Published: { checkbox: true },
      Cover: { files: [{ type: "file", name: "cover.jpg", file: { url: "https://example.test/cover.jpg" } }] },
    },
  };
  const musicPage = {
    ...basePage,
    properties: {
      ...basePage.properties,
      Type: { select: { name: "Music" } },
      Media: { files: [{ type: "file", name: "sample.mp3", file: { url: "https://example.test/sample.mp3" } }] },
    },
  };
  const album = mapLegacyDemoAlbum(musicPage);
  const track = mapLegacyDemoTrack(musicPage, album);
  assert.equal(album.coverUrl, "/api/demo/cover/legacy-item");
  assert.equal(track.id, "legacy-item");
  assert.equal(track.url, "/api/demo/track/legacy-item/legacy-item");

  const video = mapLegacyDemoVideo({
    ...basePage,
    properties: {
      ...basePage.properties,
      Type: { select: { name: "Video" } },
      Media: { files: [{ type: "file", name: "sample.mp4", file: { url: "https://example.test/sample.mp4" } }] },
      Subtitles: { files: [{ type: "file", name: "sample.zh-Hant.vtt", file: { url: "https://example.test/sample.vtt" } }] },
    },
  });
  assert.equal(video.video.url, "/api/demo/video-stream/legacy-item?v=2026-09-24T00%3A00%3A00Z");
  assert.equal(video.subtitles[0].url, "/api/demo/video-subtitle/legacy-item/0?v=2026-09-24T00%3A00%3A00Z");
});

test("mapTracks keeps audio blocks in page order and supports external URLs", () => {
  const tracks = mapTracks([
    {
      id: "one",
      type: "audio",
      audio: {
        caption: [{ plain_text: "1. Example Track" }],
        type: "file",
        file: { url: "https://example.test/one.flac" },
      },
    },
    { id: "paragraph", type: "paragraph", paragraph: {} },
    {
      id: "two",
      type: "audio",
      audio: {
        caption: [],
        type: "external",
        external: { url: "https://example.test/two.flac" },
      },
    },
  ]);

  assert.deepEqual(tracks, [
    { id: "one", title: "1. Example Track", url: "https://example.test/one.flac", format: "audio" },
    { id: "two", title: "Track 2", url: "https://example.test/two.flac", format: "audio" },
  ]);
});

test("mapTracks supports FLAC file blocks uploaded to an album page", () => {
  const tracks = mapTracks([
    {
      id: "flac-one",
      type: "file",
      file: {
        name: "1. Example Track.flac",
        type: "file",
        file: { url: "https://example.test/example-track.flac" },
      },
    },
    {
      id: "document",
      type: "file",
      file: {
        name: "booklet.pdf",
        type: "file",
        file: { url: "https://example.test/booklet.pdf" },
      },
    },
  ]);

  assert.deepEqual(tracks, [
    {
      id: "flac-one",
      title: "1. Example Track.flac",
      url: "https://example.test/example-track.flac",
      format: "flac",
    },
  ]);
});

test("mapVideo reads MP4 and WebVTT file properties", () => {
  const video = mapVideo({
    id: "video-id",
    last_edited_time: "2026-06-03T12:00:00.000Z",
    properties: {
      Name: { title: [{ plain_text: "Example Video 1" }] },
      Year: { number: 2001 },
      Genre: { multi_select: [{ name: "Fantasy" }, { name: "Adventure" }] },
      Series: { rich_text: [{ plain_text: "Example Series" }] },
      "Series Order": { number: 1 },
      Cover: { files: [{ type: "file", file: { url: "https://example.test/poster.jpg" } }] },
      Video: {
        files: [
          {
            name: "harry-potter-1.en.mp4",
            type: "file",
            file: { url: "https://example.test/movie.mp4" },
          },
        ],
      },
      Subtitles: {
        files: [
          {
            name: "harry-potter-1.zh-Hant.vtt",
            type: "file",
            file: { url: "https://example.test/zh.vtt" },
          },
          {
            name: "Example Series 1.eng.vtt",
            type: "file",
            file: { url: "https://example.test/en.vtt" },
          },
          {
            name: "Example Series 1.zh-tw.vtt",
            type: "file",
            file: { url: "https://example.test/zh-tw.vtt" },
          },
          {
            name: "notes.txt",
            type: "file",
            file: { url: "https://example.test/notes.txt" },
          },
        ],
      },
      "Audio Language": { select: { name: "English" } },
      Runtime: { number: 159 },
      Status: { select: { name: "Ready" } },
    },
  });

  assert.deepEqual(video, {
    id: "video-id",
    title: "Example Video 1",
    year: 2001,
    genres: ["Fantasy", "Adventure"],
    genre: "Fantasy",
    series: "Example Series",
    seriesOrder: 1,
    cover: "https://example.test/poster.jpg",
    createdAt: null,
    coverVersion: "2026-06-03T12:00:00.000Z",
    updatedAt: "2026-06-03T12:00:00.000Z",
    video: {
      name: "harry-potter-1.en.mp4",
      url: "https://example.test/movie.mp4",
    },
    subtitles: [
      {
        name: "harry-potter-1.zh-Hant.vtt",
        url: "https://example.test/zh.vtt",
        label: "繁體中文",
        srclang: "zh-Hant",
      },
      {
        name: "Example Series 1.eng.vtt",
        url: "https://example.test/en.vtt",
        label: "English",
        srclang: "en",
      },
      {
        name: "Example Series 1.zh-tw.vtt",
        url: "https://example.test/zh-tw.vtt",
        label: "繁體中文",
        srclang: "zh-Hant",
      },
    ],
    audioLanguage: "English",
    runtime: 159,
    status: "Ready",
  });
});

test("mapVideo accepts legacy misspelled Vedio file property", () => {
  const video = mapVideo({
    id: "video-id",
    properties: {
      Name: { title: [{ plain_text: "Example Series" }] },
      Series: { select: { name: "Example Series" } },
      Vedio: {
        files: [
          {
            name: "harry-potter.mp4",
            type: "file",
            file: { url: "https://example.test/harry-potter.mp4" },
          },
        ],
      },
    },
  });

  assert.deepEqual(video.video, {
    name: "harry-potter.mp4",
    url: "https://example.test/harry-potter.mp4",
  });
  assert.equal(video.series, "Example Series");
});

test("mapVideo can return proxied subtitle URLs for the browser", () => {
  const video = mapVideo(
    {
      id: "video-id",
      last_edited_time: "2026-06-03T12:00:00.000Z",
      properties: {
        Name: { title: [{ plain_text: "Movie" }] },
        Subtitles: {
          files: [
            {
              name: "movie.en.vtt",
              type: "file",
              file: { url: "https://example.test/movie.en.vtt" },
            },
          ],
        },
      },
    },
    { proxySubtitles: true },
  );

  assert.equal(
    video.subtitles[0].url,
    "/api/video-subtitle/video-id/0?v=2026-06-03T12%3A00%3A00.000Z",
  );
});

test("mapVideo can return a proxied video stream URL for the browser", () => {
  const video = mapVideo(
    {
      id: "video-id",
      last_edited_time: "2026-06-03T12:00:00.000Z",
      properties: {
        Name: { title: [{ plain_text: "Movie" }] },
        Video: {
          files: [
            {
              name: "movie.mp4",
              type: "file",
              file: { url: "https://example.test/movie.mp4" },
            },
          ],
        },
      },
    },
    { proxyVideo: true },
  );

  assert.deepEqual(video.video, {
    name: "movie.mp4",
    proxyUrl: "/api/video-stream/video-id?v=2026-06-03T12%3A00%3A00.000Z",
    url: "/api/video-stream/video-id?v=2026-06-03T12%3A00%3A00.000Z",
  });
});

test("mapVideo can include a proxy fallback while keeping direct playback URL", () => {
  const video = mapVideo(
    {
      id: "video-id",
      last_edited_time: "2026-06-03T12:00:00.000Z",
      properties: {
        Name: { title: [{ plain_text: "Movie" }] },
        Video: {
          files: [
            {
              name: "movie.mp4",
              type: "file",
              file: { url: "https://example.test/movie.mp4" },
            },
          ],
        },
      },
    },
    { includeProxyVideoUrl: true },
  );

  assert.deepEqual(video.video, {
    name: "movie.mp4",
    proxyUrl: "/api/video-stream/video-id?v=2026-06-03T12%3A00%3A00.000Z",
    url: "https://example.test/movie.mp4",
  });
});

test("mapVideo recognizes common Chinese subtitle language codes", () => {
  const video = mapVideo({
    id: "video-id",
    properties: {
      Name: { title: [{ plain_text: "Movie" }] },
      Subtitles: {
        files: [
          { name: "movie.chs.vtt", type: "file", file: { url: "https://example.test/chs.vtt" } },
          { name: "movie.cht.vtt", type: "file", file: { url: "https://example.test/cht.vtt" } },
          { name: "movie.sc.vtt", type: "file", file: { url: "https://example.test/sc.vtt" } },
          { name: "movie.tc.vtt", type: "file", file: { url: "https://example.test/tc.vtt" } },
          { name: "movie.zh-hk.vtt", type: "file", file: { url: "https://example.test/zh-hk.vtt" } },
        ],
      },
    },
  });

  assert.deepEqual(
    video.subtitles.map((subtitle) => [subtitle.label, subtitle.srclang]),
    [
      ["簡體中文", "zh-Hans"],
      ["繁體中文", "zh-Hant"],
      ["簡體中文", "zh-Hans"],
      ["繁體中文", "zh-Hant"],
      ["繁體中文", "zh-Hant"],
    ],
  );
});

test("mapVideo filters subtitle entries without usable Notion URLs before proxying", () => {
  const video = mapVideo(
    {
      id: "video-id",
      properties: {
        Name: { title: [{ plain_text: "Movie" }] },
        Subtitles: {
          files: [
            {
              name: "broken.en.vtt",
              type: "file",
              file: {},
            },
            {
              name: "movie.zh-Hant.vtt",
              type: "file",
              file: { url: "https://example.test/movie.zh.vtt" },
            },
          ],
        },
      },
    },
    { proxySubtitles: true },
  );

  assert.equal(video.subtitles.length, 1);
  assert.equal(video.subtitles[0].url, "/api/video-subtitle/video-id/0?v=1");
});

test("mapLibraryTracks strips temporary URLs and keeps album context", () => {
  const album = { id: "album-id", title: "Example Track", artist: "Example Artist" };
  const tracks = mapLibraryTracks(album, [
    {
      id: "flac-one",
      type: "file",
      file: {
        name: "1. Example Track.flac",
        type: "file",
        file: { url: "https://example.test/example-track.flac" },
      },
    },
  ]);

  assert.deepEqual(tracks, [
    {
      id: "flac-one",
      title: "1. Example Track.flac",
      format: "flac",
      album,
    },
  ]);
});

test("pageBelongsToDataSource rejects pages outside the configured catalog", () => {
  assert.equal(
    pageBelongsToDataSource(
      { parent: { type: "data_source_id", data_source_id: "catalog-id" } },
      "catalog-id",
    ),
    true,
  );
  assert.equal(
    pageBelongsToDataSource(
      { parent: { type: "data_source_id", data_source_id: "different-id" } },
      "catalog-id",
    ),
    false,
  );
  assert.equal(
    pageBelongsToDataSource(
      {
        parent: {
          type: "data_source_id",
          data_source_id: "01234567-89ab-cdef-0123-456789abcdef",
        },
      },
      "0123456789abcdef0123456789abcdef",
    ),
    true,
  );
});

test("parseFlacMetadata reads STREAMINFO and Vorbis comments", () => {
  const streamInfo = Buffer.alloc(34);
  const sampleRate = 96000n;
  const channelsMinusOne = 1n;
  const bitsPerSampleMinusOne = 23n;
  const totalSamples = sampleRate * 180n;
  let packed =
    (sampleRate << 44n) |
    (channelsMinusOne << 41n) |
    (bitsPerSampleMinusOne << 36n) |
    totalSamples;

  for (let offset = 17; offset >= 10; offset -= 1) {
    streamInfo[offset] = Number(packed & 0xffn);
    packed >>= 8n;
  }

  const comments = ["TITLE=Example Track", "ARTIST=Example Artist", "GENRE=K-Pop"];
  const vendor = Buffer.from("test-suite");
  const commentBuffers = comments.map((comment) => Buffer.from(comment));
  const vorbis = Buffer.alloc(
    4 + vendor.length + 4 + commentBuffers.reduce((total, comment) => total + 4 + comment.length, 0),
  );

  let offset = 0;
  vorbis.writeUInt32LE(vendor.length, offset);
  offset += 4;
  vendor.copy(vorbis, offset);
  offset += vendor.length;
  vorbis.writeUInt32LE(commentBuffers.length, offset);
  offset += 4;
  for (const comment of commentBuffers) {
    vorbis.writeUInt32LE(comment.length, offset);
    offset += 4;
    comment.copy(vorbis, offset);
    offset += comment.length;
  }

  const block = (type, body, isLast = false) =>
    Buffer.concat([
      Buffer.from([
        (isLast ? 0x80 : 0) | type,
        (body.length >> 16) & 0xff,
        (body.length >> 8) & 0xff,
        body.length & 0xff,
      ]),
      body,
    ]);

  const flac = Buffer.concat([
    Buffer.from("fLaC"),
    block(0, streamInfo),
    block(4, vorbis, true),
  ]);
  const metadata = parseFlacMetadata(flac, 54000000);

  assert.deepEqual(metadata, {
    codec: "FLAC",
    lossless: true,
    fileSize: 54000000,
    bitrate: 2400,
    sampleRate: 96000,
    channels: 2,
    bitsPerSample: 24,
    totalSamples: 17280000,
    duration: 180,
    tags: {
      title: "Example Track",
      artist: "Example Artist",
      genre: "K-Pop",
    },
  });
});
