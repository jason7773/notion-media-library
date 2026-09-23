function readPlainText(items = []) {
  return items.map((item) => item.plain_text || "").join("").trim();
}

function readFileUrl(item) {
  if (!item?.type) {
    return null;
  }
  return item[item.type]?.url || null;
}

function readFileName(item) {
  if (!item?.type) {
    return "";
  }
  return item.name || item[item.type]?.url?.split("/").pop() || "";
}

function readProperty(properties, name) {
  return properties?.[name];
}

function readSelectNames(property) {
  if (property?.select?.name) {
    return [property.select.name];
  }
  if (Array.isArray(property?.multi_select)) {
    return property.multi_select.map((item) => item.name).filter(Boolean);
  }
  return [];
}

function parseSubtitleLanguage(fileName) {
  const normalized = fileName.toLowerCase();
  const languageMatch = normalized.match(/(?:^|[._ -])(zh-hant|zh_hant|zh-tw|zh_tw|zh-hk|zh_hk|zh-hans|zh_hans|zh-cn|zh_cn|eng|en|jpn|ja|kor|ko|chs|cht|sc|tc|zh|cn|tw)(?:[._ -]|$)/);
  const code = languageMatch?.[1] || "und";
  const labels = {
    "zh-hant": "繁體中文",
    "zh_hant": "繁體中文",
    "zh-tw": "繁體中文",
    "zh_tw": "繁體中文",
    "zh-hk": "繁體中文",
    "zh_hk": "繁體中文",
    "zh-hans": "簡體中文",
    "zh_hans": "簡體中文",
    "zh-cn": "簡體中文",
    "zh_cn": "簡體中文",
    zh: "中文",
    cn: "簡體中文",
    chs: "簡體中文",
    sc: "簡體中文",
    tw: "繁體中文",
    cht: "繁體中文",
    tc: "繁體中文",
    eng: "English",
    en: "English",
    jpn: "日本語",
    ja: "日本語",
    kor: "한국어",
    ko: "한국어",
    und: fileName.replace(/\.vtt$/i, "") || "Subtitle",
  };
  const srclang =
    code === "zh-hant" ||
    code === "zh_hant" ||
    code === "zh-tw" ||
    code === "zh_tw" ||
    code === "zh-hk" ||
    code === "zh_hk" ||
    code === "tw" ||
    code === "cht" ||
    code === "tc"
      ? "zh-Hant"
      : code === "zh-hans" ||
          code === "zh_hans" ||
          code === "zh-cn" ||
          code === "zh_cn" ||
          code === "cn" ||
          code === "chs" ||
          code === "sc"
        ? "zh-Hans"
        : code === "eng"
          ? "en"
          : code === "jpn"
            ? "ja"
            : code === "kor"
              ? "ko"
        : code;
  return { label: labels[code] || labels.und, srclang };
}

export function isFlacBlock(block) {
  return block.type === "file" && block.file?.name?.toLowerCase().endsWith(".flac");
}

export function mapAlbum(page, options = {}) {
  const properties = page.properties || {};
  const title = readPlainText(readProperty(properties, "Name")?.title);
  const artist = readPlainText(readProperty(properties, "Artist")?.rich_text);
  const cover = readFileUrl(readProperty(properties, "Cover")?.files?.[0]);

  return {
    id: page.id,
    title: title || "Untitled album",
    artist: artist || "Unknown artist",
    year: readProperty(properties, "Year")?.number ?? null,
    genre: readProperty(properties, "Genre")?.select?.name || null,
    cover,
    ...(options.demo && cover ? { coverUrl: `/api/demo/cover/${encodeURIComponent(page.id)}` } : {}),
    coverVersion: page.last_edited_time || null,
  };
}

function buildSubtitleUrl(pageId, index, version, apiPrefix = "/api") {
  const search = new URLSearchParams({ v: version || "1" });
  return `${apiPrefix}/video-subtitle/${encodeURIComponent(pageId)}/${index}?${search.toString()}`;
}

function buildVideoStreamUrl(pageId, version, apiPrefix = "/api") {
  const search = new URLSearchParams({ v: version || "1" });
  return `${apiPrefix}/video-stream/${encodeURIComponent(pageId)}?${search.toString()}`;
}

export function mapVideo(page, options = {}) {
  const {
    includeProxyVideoUrl = false,
    proxySubtitles = false,
    proxyVideo = false,
    demo = false,
    apiPrefix = "/api",
  } = options;
  const properties = page.properties || {};
  const title = readPlainText(readProperty(properties, "Name")?.title);
  const cover = readFileUrl(readProperty(properties, "Cover")?.files?.[0]);
  const videoFile =
    readProperty(properties, "Video")?.files?.[0] ||
    readProperty(properties, "Vedio")?.files?.[0];
  const subtitleFiles = readProperty(properties, "Subtitles")?.files || [];
  const genres = readSelectNames(readProperty(properties, "Genre"));
  const series =
    readProperty(properties, "Series")?.select?.name ||
    readPlainText(readProperty(properties, "Series")?.rich_text) ||
    null;
  const audioLanguage =
    readProperty(properties, "Audio Language")?.select?.name ||
    readPlainText(readProperty(properties, "Audio Language")?.rich_text) ||
    null;

  return {
    id: page.id,
    title: title || "Untitled video",
    year: readProperty(properties, "Year")?.number ?? null,
    genres,
    genre: genres[0] || null,
    series,
    seriesOrder: readProperty(properties, "Series Order")?.number ?? null,
    cover,
    ...(demo && cover ? { coverUrl: `${apiPrefix}/video-cover/${encodeURIComponent(page.id)}` } : {}),
    createdAt: page.created_time || null,
    coverVersion: page.last_edited_time || null,
    updatedAt: page.last_edited_time || null,
    video: videoFile
      ? {
          name: readFileName(videoFile),
          ...(includeProxyVideoUrl || proxyVideo
            ? { proxyUrl: buildVideoStreamUrl(page.id, page.last_edited_time, apiPrefix) }
            : {}),
          url: proxyVideo
            ? buildVideoStreamUrl(page.id, page.last_edited_time, apiPrefix)
            : readFileUrl(videoFile),
        }
      : null,
    subtitles: subtitleFiles
      .filter((file) => readFileName(file).toLowerCase().endsWith(".vtt") && readFileUrl(file))
      .map((file, index) => {
        const name = readFileName(file);
        const sourceUrl = readFileUrl(file);
        return {
          name,
          url: proxySubtitles
            ? buildSubtitleUrl(page.id, index, page.last_edited_time, apiPrefix)
            : sourceUrl,
          ...parseSubtitleLanguage(name),
        };
      }),
    audioLanguage,
    runtime: readProperty(properties, "Runtime")?.number ?? null,
    status: readProperty(properties, "Status")?.select?.name || null,
  };
}

export function mapTrack(block, index, options = {}) {
  const media = block[block.type];
  const sourceUrl = readFileUrl(media);
  const fileName = media.name || "";
  const extension = fileName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || null;
  return {
    id: block.id,
    title: readPlainText(media.caption) || media.name || `Track ${index + 1}`,
    url: options.demo && options.albumId
      ? `/api/demo/track/${encodeURIComponent(options.albumId)}/${encodeURIComponent(block.id)}`
      : sourceUrl,
    format: extension || block.type,
  };
}

export function mapAlbums(pages, options = {}) {
  return pages
    .map((page) => mapAlbum(page, options))
    .sort((a, b) => (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title));
}

export function mapVideos(pages, options = {}) {
  return pages
    .map((page) => mapVideo(page, options))
    .sort((a, b) => (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title));
}

export function mapTracks(blocks, options = {}) {
  return blocks
    .filter(
      (block) =>
        block.type === "audio" ||
        isFlacBlock(block),
    )
    .map((block, index) => mapTrack(block, index, options))
    .filter((track) => track.url);
}

export function mapLibraryTracks(album, blocks, options = {}) {
  return mapTracks(blocks, { ...options, albumId: album.id }).map(({ url, ...track }) => ({
    ...track,
    album,
  }));
}

export function isPublishedPage(page) {
  return page?.properties?.Published?.checkbox === true;
}

export function pageBelongsToDataSource(page, dataSourceId) {
  const parent = page.parent;
  if (!parent) {
    return false;
  }

  const expectedId = dataSourceId.replaceAll("-", "");

  if (parent.type === "data_source_id") {
    return parent.data_source_id.replaceAll("-", "") === expectedId;
  }

  // Kept for older Notion API versions.
  return (
    parent.type === "database_id" &&
    parent.database_id.replaceAll("-", "") === expectedId
  );
}
