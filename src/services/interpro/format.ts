/**
 * @fileoverview Reversible JSON output with usable source URL and image indexes.
 * @module services/interpro/format
 */
import { markdown } from '@cyanheads/mcp-ts-core/utils';

/** Base64 prefixes of the image formats Wikipedia thumbnails arrive in, with their media types. */
const THUMBNAIL_SIGNATURES = [
  ['iVBORw0KGgo', 'image/png'],
  ['/9j/', 'image/jpeg'],
  ['R0lGOD', 'image/gif'],
] as const;
/** The whole string is standard base64, padded only at the end. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** The whole string is a base64 PNG, JPEG, or GIF data URI: the only data URI indexed as an image. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
/** An image file extension at the end of a URL path. */
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|svg|avif)$/i;

function thumbnailDataUri(item: string): string | undefined {
  if (!BASE64.test(item)) return undefined;
  const mediaType = THUMBNAIL_SIGNATURES.find(([prefix]) => item.startsWith(prefix))?.[1];
  return mediaType && `data:${mediaType};base64,${item}`;
}

/** Convert Wikipedia's base64 thumbnail strings to data URIs before constructing either output surface. */
export function normalizeImages<T>(value: T): T {
  if (Array.isArray(value)) return value.map(normalizeImages) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]: [string, unknown]) => [
        key,
        (key === 'thumbnail' && typeof item === 'string' && thumbnailDataUri(item)) ||
          normalizeImages(item),
      ]),
    ) as T;
  return value;
}

/**
 * Keep or drop the base64 `thumbnail` on each Wikipedia page of a detail record. Dropping it
 * removes only that key, so every other page field survives, and the returned notice states
 * what was removed and names `includeThumbnail: true` on `toolName` as the way to get it.
 */
export function projectWikipediaThumbnails<T extends Record<string, unknown>>(
  metadata: T,
  include: boolean,
  toolName: string,
): { metadata: T; notice?: string } {
  if (include) return { metadata };
  let count = 0;
  let bytes = 0;
  const strip = (page: unknown): unknown => {
    if (!page || typeof page !== 'object' || Array.isArray(page)) return page;
    const { thumbnail, ...rest } = page as Record<string, unknown>;
    if (typeof thumbnail !== 'string' || thumbnail === '') return page;
    count += 1;
    bytes += thumbnail.length;
    return rest;
  };
  const { wikipedia } = metadata;
  const pages = Array.isArray(wikipedia) ? wikipedia.map(strip) : strip(wikipedia);
  if (!count) return { metadata };
  const subject = count === 1 ? 'the Wikipedia thumbnail' : `${count} Wikipedia thumbnails`;
  return {
    metadata: { ...metadata, wikipedia: pages },
    notice: `Omitted ${subject} (${bytes.toLocaleString('en-US')} bytes of base64 image data); repeat ${toolName} with includeThumbnail: true to include ${count === 1 ? 'it' : 'them'}.`,
  };
}

/** Emit every field losslessly as compact JSON; source text remains inert inside a growing fence. */
export function formatInterpro(value: unknown): { type: 'text'; text: string }[] {
  const urls = new Set<string>();
  const images = new Set<string>();
  /**
   * Record a parseable URL. A whole-string value whose path has an image extension is also an
   * image; a URL found inside prose is only a link, since clients fetch images unprompted.
   */
  const addUrl = (candidate: string, whole: boolean): boolean => {
    try {
      const { pathname } = new URL(candidate);
      urls.add(candidate);
      if (whole && IMAGE_PATH.test(pathname)) images.add(candidate);
      return true;
    } catch {
      return false;
    }
  };
  const inspect = (item: unknown): void => {
    if (typeof item === 'string') {
      if (DATA_IMAGE.test(item)) {
        images.add(item);
        return;
      }
      if (/^https?:\/\//.test(item) && !/[\s\p{Cc}]/u.test(item) && addUrl(item, true)) return;
      for (const match of item.matchAll(/https?:\/\/[^\s<>"'\p{Cc}]+/gu)) addUrl(match[0], false);
    } else if (Array.isArray(item)) item.forEach(inspect);
    else if (item && typeof item === 'object') Object.values(item).forEach(inspect);
  };
  inspect(value);
  const json = JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const output = markdown().codeBlock(json, 'json');
  /**
   * CommonMark angle destinations retain parentheses, and entities decode to the original URL.
   * Whitespace and control characters, which no indexed URL holds, are percent-encoded as a
   * backstop so no destination can span a line.
   */
  const destination = (url: string) =>
    url
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\\/g, '&#92;')
      .replace(/[\s\p{Cc}]/gu, encodeURIComponent);
  if (urls.size)
    output
      .raw('\n\nSources and links:\n')
      .raw(
        [...urls].map((url, index) => `[Link ${index + 1}](<${destination(url)}>)`).join('\n\n'),
      );
  if (images.size)
    output
      .raw('\n\nImages:\n')
      .raw(
        [...images]
          .map((url, index) => `![Image ${index + 1}](<${destination(url)}>)`)
          .join('\n\n'),
      );
  return [{ type: 'text', text: output.build() }];
}
