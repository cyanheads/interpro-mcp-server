/**
 * @fileoverview One-pass protein sequence parsing and the UniParc-compatible MD5 digest.
 * @module services/sequence-scan/sequence
 */
import { createHash } from 'node:crypto';

/** Most characters one sequence argument may hold, FASTA header and line breaks included. */
export const MAX_SEQUENCE_CHARS = 100_000;

/** A parsed sequence, or the reason it cannot be scanned. */
export type ParsedSequence =
  | { readonly ok: true; readonly residues: string; readonly md5: string }
  | { readonly ok: false; readonly reason: 'empty_sequence' }
  | { readonly ok: false; readonly reason: 'multiple_sequences'; readonly position: number }
  | {
      readonly ok: false;
      readonly reason: 'invalid_residue';
      readonly position: number;
      readonly codePoint: number;
    };

const CR = 0x0d;
const LF = 0x0a;
const GT = 0x3e;
/** U+FEFF, the byte-order mark a text file saved as UTF-8 with BOM opens with. */
const BOM = 0xfeff;
const isWhitespace = (code: number) => code === 0x20 || code === 0x09 || code === CR || code === LF;
const isUpper = (code: number) => code >= 0x41 && code <= 0x5a;
const isLower = (code: number) => code >= 0x61 && code <= 0x7a;

/**
 * Read one protein sequence: an optional byte-order mark as the very first character, optional
 * leading whitespace, an optional single FASTA header line, then IUPAC residue letters (all 26,
 * case-insensitive) separated by any spaces, tabs, or line breaks. A `>` past the header starts a
 * second record; a byte-order mark anywhere else is an invalid residue. Each character is visited
 * once, so the cost is linear in the input. Positions are 1-based character offsets into the
 * argument, the skipped mark included.
 */
export function parseSequence(text: string): ParsedSequence {
  const residues = new Uint8Array(text.length);
  let count = 0;
  let index = text.charCodeAt(0) === BOM ? 1 : 0;
  while (index < text.length && isWhitespace(text.charCodeAt(index))) index++;
  if (text.charCodeAt(index) === GT) {
    while (index < text.length && text.charCodeAt(index) !== LF && text.charCodeAt(index) !== CR)
      index++;
  }
  for (; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (isUpper(code)) residues[count++] = code;
    else if (isLower(code)) residues[count++] = code - 0x20;
    else if (isWhitespace(code)) continue;
    else if (code === GT) return { ok: false, reason: 'multiple_sequences', position: index + 1 };
    else
      return {
        ok: false,
        reason: 'invalid_residue',
        position: index + 1,
        codePoint: text.codePointAt(index) ?? code,
      };
  }
  if (!count) return { ok: false, reason: 'empty_sequence' };
  const bytes = residues.subarray(0, count);
  return {
    ok: true,
    residues: Buffer.from(bytes).toString('latin1'),
    md5: createHash('md5').update(bytes).digest('hex').toUpperCase(),
  };
}

/** A code point as `U+XXXX`, so an invalid character is named without echoing it. */
export const codePointLabel = (codePoint: number) =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
