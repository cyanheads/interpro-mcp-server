/**
 * @fileoverview Reversible JSON output with usable source URL and image indexes.
 * @module services/interpro/format
 */
import { markdown } from '@cyanheads/mcp-ts-core/utils';

/** Convert Wikipedia's PNG thumbnail strings before constructing either output surface. */
export function normalizeImages<T>(value: T): T {
  if (Array.isArray(value)) return value.map(normalizeImages) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]: [string, unknown]) => [
        key,
        key === 'thumbnail' && typeof item === 'string' && item.startsWith('iVBORw0KGgo')
          ? `data:image/png;base64,${item}`
          : normalizeImages(item),
      ]),
    ) as T;
  return value;
}

/** Emit every field losslessly; source text remains inert inside a growing JSON fence. */
export function formatInterpro(value: unknown): { type: 'text'; text: string }[] {
  const urls = new Set<string>();
  const images = new Set<string>();
  const inspect = (item: unknown): void => {
    if (typeof item === 'string') {
      if (/^data:image\/[A-Za-z0-9.+-]+[;,]/.test(item)) images.add(item);
      if (/^https?:\/\//.test(item) && !/[\s\p{Cc}]/u.test(item)) {
        try {
          const parsed = new URL(item);
          urls.add(item);
          if (/\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(parsed.pathname)) images.add(item);
          return;
        } catch {
          /* Embedded prose URLs are inspected below. */
        }
      }
      for (const match of item.matchAll(/https?:\/\/[^\s<>"'\p{Cc}]+/gu)) {
        const candidate = match[0];
        try {
          const parsed = new URL(candidate);
          urls.add(candidate);
          if (/\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(parsed.pathname)) images.add(candidate);
        } catch {
          /* A prose fragment is not a URL. */
        }
      }
    } else if (Array.isArray(item)) item.forEach(inspect);
    else if (item && typeof item === 'object') Object.values(item).forEach(inspect);
  };
  inspect(value);
  const json = JSON.stringify(value, null, 2)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const output = markdown().codeBlock(json, 'json');
  // CommonMark angle destinations retain parentheses; entities decode to the original URL.
  const destination = (url: string) =>
    url.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '&#92;');
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
