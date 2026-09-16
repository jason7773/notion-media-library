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

function readRichTextProperty(properties, name) {
  return readPlainText(readProperty(properties, name)?.rich_text);
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

function readFileProperty(properties, name) {
  return readProperty(properties, name)?.files?.[0] || null;
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

export function mapAlbum(page) {
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
    coverVersion: page.last_edited_time || null,
  };
}

function buildSubtitleUrl(pageId, index, version) {
  const search = new URLSearchParams({ v: version || "1" });
  return `/api/video-subtitle/${encodeURIComponent(pageId)}/${index}?${search.toString()}`;
}

function buildVideoStreamUrl(pageId, version) {
  const search = new URLSearchParams({ v: version || "1" });
  return `/api/video-stream/${encodeURIComponent(pageId)}?${search.toString()}`;
}

export function mapVideo(page, options = {}) {
  const {
    includeProxyVideoUrl = false,
    proxySubtitles = false,
    proxyVideo = false,
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
    createdAt: page.created_time || null,
    coverVersion: page.last_edited_time || null,
    updatedAt: page.last_edited_time || null,
    video: videoFile
      ? {
          name: readFileName(videoFile),
          ...(includeProxyVideoUrl || proxyVideo
            ? { proxyUrl: buildVideoStreamUrl(page.id, page.last_edited_time) }
            : {}),
          url: proxyVideo
            ? buildVideoStreamUrl(page.id, page.last_edited_time)
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
            ? buildSubtitleUrl(page.id, index, page.last_edited_time)
            : sourceUrl,
          ...parseSubtitleLanguage(name),
        };
      }),
    audioLanguage,
    runtime: readProperty(properties, "Runtime")?.number ?? null,
    status: readProperty(properties, "Status")?.select?.name || null,
  };
}

export function mapTrack(block, index) {
  const media = block[block.type];
  const fileName = media.name || "";
  const extension = fileName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || null;
  return {
    id: block.id,
    title: readPlainText(media.caption) || media.name || `Track ${index + 1}`,
    url: readFileUrl(media),
    format: extension || block.type,
  };
}

function buildDemoAssetUrl(kind, pageId, index) {
  const encodedPageId = encodeURIComponent(pageId);
  if (kind === "subtitle") {
    return `/api/demo/subtitle/${encodedPageId}/${index}`;
  }
  return `/api/demo/${kind}/${encodedPageId}`;
}

export function mapDemoItem(page, options = {}) {
  const properties = page?.properties || {};
  const published = readProperty(properties, "Published")?.checkbox === true;
  const type = String(readProperty(properties, "Type")?.select?.name || "").trim().toLowerCase();
  if (!published || !["music", "video"].includes(type)) {
    return null;
  }

  const mediaFile = readFileProperty(properties, "Media");
  const mediaUrl = readFileUrl(mediaFile);
  if (!mediaFile || !mediaUrl) {
    return null;
  }

  const title = readPlainText(readProperty(properties, "Name")?.title).trim();
  if (!title) {
    return null;
  }

  const coverFile = readFileProperty(properties, "Cover");
  const coverSourceUrl = readFileUrl(coverFile);

  const fileName = readFileName(mediaFile);
  const extension = fileName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "";
  const allowed = type === "video"
    ? new Set(["mp4", "webm", "m4v"])
    : new Set(["flac", "mp3", "m4a", "ogg", "oga", "wav", "aac"]);
  if (!allowed.has(extension)) {
    return null;
  }

  const subtitleFiles = readProperty(properties, "Subtitles")?.files || [];
  const subtitles = type === "video"
    ? subtitleFiles
        .filter((file) => readFileName(file).toLowerCase().endsWith(".vtt") && readFileUrl(file))
        .map((file, index) => ({
          name: readFileName(file),
          ...parseSubtitleLanguage(readFileName(file)),
          url: buildDemoAssetUrl("subtitle", page.id, index),
          ...(options.includeSourceUrls ? { sourceUrl: readFileUrl(file) } : {}),
        }))
    : [];

  return {
    id: page.id,
    title,
    type,
    artist: readRichTextProperty(properties, "Artist") || null,
    description: readRichTextProperty(properties, "Description") || null,
    credit: readRichTextProperty(properties, "Credit") || null,
    sourceUrl: readProperty(properties, "Source URL")?.url || null,
    order: readProperty(properties, "Order")?.number ?? null,
    coverUrl: coverSourceUrl
      ? buildDemoAssetUrl("cover", page.id)
      : null,
    ...(options.includeSourceUrls && coverSourceUrl
      ? { coverSourceUrl }
      : {}),
    media: {
      name: fileName || "demo-media",
      url: buildDemoAssetUrl("media", page.id),
      ...(options.includeSourceUrls ? { sourceUrl: mediaUrl } : {}),
    },
    subtitles,
    updatedAt: page.last_edited_time || null,
  };
}

export function mapDemoItems(pages) {
  return pages
    .map((page) => mapDemoItem(page))
    .filter(Boolean)
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title));
}

export function mapAlbums(pages) {
  return pages
    .map(mapAlbum)
    .sort((a, b) => (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title));
}

export function mapVideos(pages, options = {}) {
  return pages
    .map((page) => mapVideo(page, options))
    .sort((a, b) => (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title));
}

export function mapTracks(blocks) {
  return blocks
    .filter(
      (block) =>
        block.type === "audio" ||
        isFlacBlock(block),
    )
    .map(mapTrack)
    .filter((track) => track.url);
}

export function mapLibraryTracks(album, blocks) {
  return mapTracks(blocks).map(({ url, ...track }) => ({
    ...track,
    album,
  }));
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
