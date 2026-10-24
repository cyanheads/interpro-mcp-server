/**
 * @fileoverview Readable projection of InterPro HTML description fragments.
 * @module services/interpro/description-text
 */
import { Tokenizer } from 'htmlparser2';

const PARAGRAPHS = new Set([
  'p',
  'div',
  'section',
  'article',
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'dl',
]);
const REFERENCES = /\b(?:IPR[0-9]{6}|PUB[0-9]+)\b/gi;

/** Decode description fragments without executing markup or changing the source description. */
export function descriptionText(description: unknown): string | undefined {
  const fragments =
    typeof description === 'string'
      ? [description]
      : Array.isArray(description)
        ? description.flatMap((item: unknown) =>
            item && typeof item === 'object' && 'text' in item && typeof item.text === 'string'
              ? [item.text]
              : [],
          )
        : [];
  const rendered = fragments
    .map((fragment) => {
      const chunks: string[] = [];
      let pending = '';
      let bullet = false;
      let listDepth = 0;
      let suppressed: string | undefined;
      let openingTag = '';
      let attributeName = '';
      let attributeChunks: string[] = [];
      let href: string | undefined;
      let anchor: { href: string; text: string[] } | undefined;
      const boundary = (separator: string) => {
        const rank = (value: string) =>
          value === '\n\n' ? 4 : value === '\n' ? 3 : value === '\t' ? 2 : value === ' ' ? 1 : 0;
        if (rank(separator) > rank(pending)) pending = separator;
      };
      const open = (name: string) => {
        if (name === 'script' || name === 'style') suppressed = name;
        if (suppressed) return;
        if (name === 'a') {
          closeAnchor();
          if (href) anchor = { href, text: [] };
        }
        if (name === 'ul' || name === 'ol') {
          if (!listDepth) boundary('\n\n');
          listDepth += 1;
        } else if (name === 'li') {
          boundary('\n');
          bullet = true;
        } else if (PARAGRAPHS.has(name)) boundary('\n\n');
        else if (name === 'br' || name === 'tr' || name === 'dt' || name === 'dd') boundary('\n');
      };
      const append = (value: string) => {
        if (suppressed) return;
        anchor?.text.push(value);
        const normalized = value.replace(/[\t\n\f\r ]+/g, ' ');
        const text = normalized.trim();
        if (text) {
          if (chunks.length) chunks.push(pending || (normalized.startsWith(' ') ? ' ' : ''));
          if (bullet) chunks.push('- ');
          chunks.push(text);
          pending = normalized.endsWith(' ') ? ' ' : '';
          bullet = false;
        } else if (normalized) boundary(' ');
      };
      const closeAnchor = () => {
        if (!anchor) return;
        const visible = new Set(
          [...anchor.text.join('').matchAll(REFERENCES)].map(([token]) => token.toUpperCase()),
        );
        const references = new Set(
          [...anchor.href.matchAll(REFERENCES)].map(([token]) => token.toUpperCase()),
        );
        anchor = undefined;
        const missing = [...references].filter((token) => !visible.has(token));
        if (missing.length) append(` (${missing.join(', ')})`);
      };
      const close = (name: string) => {
        if (name === suppressed) {
          suppressed = undefined;
          return;
        }
        if (suppressed) return;
        if (name === 'a') closeAnchor();
        if (name === 'ul' || name === 'ol') {
          listDepth = Math.max(0, listDepth - 1);
          boundary(listDepth ? '\n' : '\n\n');
        } else if (name === 'li') {
          bullet = false;
          boundary('\n');
        } else if (PARAGRAPHS.has(name)) boundary('\n\n');
        else if (name === 'tr' || name === 'dt' || name === 'dd') boundary('\n');
        else if (name === 'td' || name === 'th') boundary('\t');
      };
      /** Token callbacks need no open-element stack; even deeply nested fragments stay streaming. */
      const tokenizer = new Tokenizer(
        { decodeEntities: true },
        {
          onopentagname(start, end) {
            openingTag = fragment.slice(start, end).toLowerCase();
            href = undefined;
          },
          onopentagend() {
            open(openingTag);
          },
          onselfclosingtag() {
            open(openingTag);
            if (openingTag !== 'script' && openingTag !== 'style') close(openingTag);
          },
          onclosetag(start, end) {
            close(fragment.slice(start, end).toLowerCase());
          },
          ontext(start, end) {
            append(fragment.slice(start, end));
          },
          ontextentity(codepoint) {
            append(String.fromCodePoint(codepoint));
          },
          onattribdata(start, end) {
            if (attributeName === 'href') attributeChunks.push(fragment.slice(start, end));
          },
          onattribentity(codepoint) {
            if (attributeName === 'href') attributeChunks.push(String.fromCodePoint(codepoint));
          },
          onattribend() {
            if (attributeName === 'href') href = attributeChunks.join('');
          },
          onattribname(start, end) {
            attributeName = fragment.slice(start, end).toLowerCase();
            attributeChunks = [];
          },
          oncdata() {},
          oncomment() {},
          ondeclaration() {},
          onprocessinginstruction() {},
          onend() {
            closeAnchor();
          },
        },
      );
      tokenizer.write(fragment);
      tokenizer.end();
      return chunks.join('');
    })
    .filter(Boolean);
  return rendered.length ? rendered.join('\n\n') : undefined;
}
