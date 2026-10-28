/**
 * @fileoverview Protein sequence parsing, UniParc MD5 parity, and linear-time scanning.
 * @module tests/services/sequence-scan-sequence
 */
import { describe, expect, it } from 'vitest';
import { codePointLabel, parseSequence } from '@/services/sequence-scan/sequence.js';
import sequences from './fixtures/sequence-scan/sequences.json' with { type: 'json' };

describe('parseSequence', () => {
  it.each([
    ['calmodulin P0DP23', sequences.calmodulin, 'EBD0AA0BC77B635530A6938487B7099B'],
    ['AKT1 P31749', sequences.akt1, '1620296E269940B19BAFA78CA71E003A'],
    ['calmodulin variant', sequences.calmodulinVariant, '6A4866B2B971131F9DA9B818F1E3508B'],
    ['AKT1 variant', sequences.akt1Variant, 'CBBF4B5F4FB746E5B01D6F31F9ADAE55'],
  ])('reproduces the UniParc / InterProScan MD5 of %s', (_name, sequence, md5) => {
    expect(parseSequence(sequence)).toEqual({ ok: true, residues: sequence, md5 });
  });

  it('reads a FASTA header line, lowercase residues, and mixed line breaks as the same sequence', () => {
    const wrapped = sequences.calmodulin.toLowerCase().replace(/(.{60})/g, '$1\r\n');
    for (const text of [
      sequences.calmodulinFasta,
      `\n\t >query description\r\n${wrapped}\n`,
      `  ${sequences.calmodulin.slice(0, 10)} \t${sequences.calmodulin.slice(10)}\r`,
    ])
      expect(parseSequence(text)).toEqual({
        ok: true,
        residues: sequences.calmodulin,
        md5: 'EBD0AA0BC77B635530A6938487B7099B',
      });
  });

  it.each([
    ['raw residues', sequences.calmodulin],
    ['a FASTA record', sequences.calmodulinFasta],
    ['leading whitespace and a header', `\n >query\r\n${sequences.calmodulin}\n`],
  ])('skips one leading byte-order mark before %s', (_shape, text) => {
    const expected = {
      ok: true,
      residues: sequences.calmodulin,
      md5: 'EBD0AA0BC77B635530A6938487B7099B',
    };
    expect(parseSequence(text)).toEqual(expected);
    expect(parseSequence(`\u{feff}${text}`)).toEqual(expected);
  });

  it('reads a byte-order mark alone as an empty sequence', () => {
    expect(parseSequence('\u{feff}')).toEqual({ ok: false, reason: 'empty_sequence' });
  });

  it.each([
    ['inside the residues', 'MK\u{feff}V', 3],
    ['after leading whitespace', ' \u{feff}MKV', 2],
    ['as a second leading mark', '\u{feff}\u{feff}MKV', 2],
    ['after a FASTA header', '>h\n\u{feff}MKV', 4],
  ])('rejects a byte-order mark %s as invalid_residue', (_where, text, position) => {
    expect(parseSequence(text)).toEqual({
      ok: false,
      reason: 'invalid_residue',
      position,
      codePoint: 0xfeff,
    });
  });

  it('accepts every IUPAC protein letter, B, J, O, U, X, and Z included', () => {
    const result = parseSequence('abcdefghijklmnopqrstuvwxyz');
    expect(result).toMatchObject({ ok: true, residues: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
  });

  it.each(['', '   \r\n\t', '>only a header', '>header\n  \n'])('rejects %j as empty', (text) => {
    expect(parseSequence(text)).toEqual({ ok: false, reason: 'empty_sequence' });
  });

  it.each([
    ['MKV*', 4, 0x2a],
    ['MK-V', 3, 0x2d],
    ['1 MKVL', 1, 0x31],
    ['>h\nMKVé', 7, 0xe9],
    ['MK\u{1f9ec}V', 3, 0x1f9ec],
  ])('rejects %j at the first non-residue character', (text, position, codePoint) => {
    expect(parseSequence(text)).toEqual({
      ok: false,
      reason: 'invalid_residue',
      position,
      codePoint,
    });
  });

  it('names an invalid character by code point rather than echoing it', () => {
    expect(codePointLabel(0x2a)).toBe('U+002A');
    expect(codePointLabel(0x1f9ec)).toBe('U+1F9EC');
  });

  it.each([
    ['>a\nMKV\n>b\nMKV', 8],
    ['MKV\n>b\nMKV', 5],
    ['>a\nMKV>b', 7],
  ])('rejects multi-record FASTA %j', (text, position) => {
    expect(parseSequence(text)).toEqual({ ok: false, reason: 'multiple_sequences', position });
  });
});

describe('parseSequence cost', () => {
  const cpuMicros = (run: () => void) => {
    let best = Number.POSITIVE_INFINITY;
    for (let batch = 0; batch < 3; batch++) {
      const before = process.threadCpuUsage();
      for (let call = 0; call < 8; call++) run();
      const spent = process.threadCpuUsage(before);
      best = Math.min(best, spent.user + spent.system);
    }
    return Math.max(best, 1);
  };

  it.each([
    ['one long residue line ending in a break', (n: number) => `${'A'.repeat(n - 1)}\n`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
    ['one long header line', (n: number) => `>${'h'.repeat(n - 3)}\nM`],
  ])('stays linear for %s from 5k to 320k characters', (_shape, build) => {
    parseSequence(build(5_000));
    const times: number[] = [];
    for (let size = 5_000; size <= 320_000; size *= 2) {
      const text = build(size);
      expect(text).toHaveLength(size);
      const micros = cpuMicros(() => parseSequence(text));
      // Eight calls on 320k characters take a few milliseconds; a quadratic scan takes seconds.
      expect(micros, `${size} characters`).toBeLessThan(500_000);
      times.push(micros);
    }
    expect((times.at(-1) as number) / (times[0] as number)).toBeLessThan(256);
  });
});
