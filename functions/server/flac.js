import { TtlCache } from "./cache.js";

const INITIAL_RANGE_END = 262143;
const MAX_METADATA_BYTES = 1048576;
const METADATA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const metadataCache = new TtlCache({ maxEntries: 300 });

function readUint24BE(buffer, offset) {
  return (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
}

function parseContentRange(value) {
  const match = value?.match(/^bytes \d+-\d+\/(\d+)$/i);
  return match ? Number(match[1]) : null;
}

function decodeUtf8(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("utf8");
}

function parseVorbisComments(buffer) {
  let offset = 0;
  if (buffer.length < 8) {
    return {};
  }

  const vendorLength = buffer.readUInt32LE(offset);
  offset += 4 + vendorLength;
  if (offset + 4 > buffer.length) {
    return {};
  }

  const commentCount = buffer.readUInt32LE(offset);
  offset += 4;
  const tags = {};

  for (let index = 0; index < commentCount; index += 1) {
    if (offset + 4 > buffer.length) {
      break;
    }
    const length = buffer.readUInt32LE(offset);
    offset += 4;
    if (offset + length > buffer.length) {
      break;
    }

    const comment = decodeUtf8(buffer, offset, length);
    offset += length;
    const separator = comment.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = comment.slice(0, separator).toLowerCase();
    const value = comment.slice(separator + 1);
    tags[key] = tags[key] ? `${tags[key]}; ${value}` : value;
  }

  return tags;
}

function parseStreamInfo(buffer) {
  if (buffer.length < 34) {
    throw new Error("Invalid FLAC STREAMINFO block.");
  }

  let packed = 0n;
  for (const byte of buffer.subarray(10, 18)) {
    packed = (packed << 8n) | BigInt(byte);
  }

  const sampleRate = Number(packed >> 44n);
  const channels = Number((packed >> 41n) & 0x7n) + 1;
  const bitsPerSample = Number((packed >> 36n) & 0x1fn) + 1;
  const totalSamples = Number(packed & 0xfffffffffn);

  return {
    sampleRate,
    channels,
    bitsPerSample,
    totalSamples,
    duration: sampleRate ? totalSamples / sampleRate : null,
  };
}

export function parseFlacMetadata(buffer, fileSize = null) {
  if (buffer.subarray(0, 4).toString("ascii") !== "fLaC") {
    throw new Error("The selected file is not a valid FLAC file.");
  }

  let offset = 4;
  let streamInfo;
  let tags = {};
  let isLast = false;

  while (!isLast && offset + 4 <= buffer.length) {
    const firstByte = buffer[offset];
    isLast = Boolean(firstByte & 0x80);
    const blockType = firstByte & 0x7f;
    const blockLength = readUint24BE(buffer, offset + 1);
    const blockStart = offset + 4;
    const blockEnd = blockStart + blockLength;

    if (blockEnd > buffer.length) {
      break;
    }

    if (blockType === 0) {
      streamInfo = parseStreamInfo(buffer.subarray(blockStart, blockEnd));
    } else if (blockType === 4) {
      tags = parseVorbisComments(buffer.subarray(blockStart, blockEnd));
    }

    offset = blockEnd;
  }

  if (!streamInfo) {
    throw new Error("FLAC STREAMINFO metadata is missing.");
  }

  const bitrate =
    fileSize && streamInfo.duration
      ? Math.round((fileSize * 8) / streamInfo.duration / 1000)
      : null;

  return {
    codec: "FLAC",
    lossless: true,
    fileSize,
    bitrate,
    ...streamInfo,
    tags,
  };
}

async function fetchMetadataRange(url, end) {
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${end}` },
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`Unable to inspect FLAC metadata (${response.status}).`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  const fileSize =
    parseContentRange(response.headers.get("content-range")) ||
    Number(response.headers.get("content-length")) ||
    null;

  return { body, fileSize };
}

async function inspectFlacFresh(url) {
  let rangeEnd = INITIAL_RANGE_END;

  while (rangeEnd < MAX_METADATA_BYTES) {
    const result = await fetchMetadataRange(url, rangeEnd);
    try {
      return parseFlacMetadata(result.body, result.fileSize);
    } catch (error) {
      if (!error.message.includes("STREAMINFO")) {
        throw error;
      }
      rangeEnd = Math.min(rangeEnd * 2 + 1, MAX_METADATA_BYTES);
    }
  }

  const result = await fetchMetadataRange(url, MAX_METADATA_BYTES - 1);
  return parseFlacMetadata(result.body, result.fileSize);
}

export async function inspectFlac(url, options = {}) {
  const cacheKey = options.cacheKey || url;
  return metadataCache.getOrSet(
    `flac:${cacheKey}`,
    METADATA_CACHE_TTL_MS,
    () => inspectFlacFresh(url),
  );
}
