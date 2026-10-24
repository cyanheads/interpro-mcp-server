/**
 * @fileoverview Fragment projection boundaries and CPU growth regression tests.
 * @module tests/services/interpro-description-text
 */
import { threadCpuUsage } from 'node:process';
import { describe, expect, it } from 'vitest';
import { descriptionText } from '@/services/interpro/description-text.js';

describe('description fragment text', () => {
  it.each([
    [
      '<p>α &amp; β</p><p>IPR000719 [[cite:PUB00003569]]</p>',
      'α & β\n\nIPR000719 [[cite:PUB00003569]]',
    ],
    ['<p>A<b>B</b>C<br>D<br/>E</p>', 'ABC\nD\nE'],
    ['<p>A<p>B<ul><li>C<li>D</ul>', 'A\n\nB\n\n- C\n- D'],
    ['<ol><li>one<ul><li>nested</li></ul></li><li>two</li></ol>', '- one\n- nested\n- two'],
    ['<table><tr><th>α</th><th>β</th></tr>\n<tr><td>1</td> <td>2</td></tr></table>', 'α\tβ\n1\t2'],
    ['<p>5 &lt; 10 &gt; 1, x&#178; &#x2212; y &alpha; &nbsp;z</p>', '5 < 10 > 1, x² − y α z'],
    [
      '<script>bad()<b>not text</b></script><p onmouseover="bad()">Visible</p><style>bad{}</style>',
      'Visible',
    ],
    ['<script/>not visible</script><style/>not visible</style><p>Visible', 'Visible'],
    ['<p>Visible<!--hidden--> text</p><script>unclosed', 'Visible text'],
    ['</ul></li><p>Visible</p><ul><li>one</li></ul>', 'Visible\n\n- one'],
    ['<p>A</p>\n\n<p>B</p>', 'A\n\nB'],
    ['text\n', 'text'],
    ['A\n\n\nB', 'A B'],
    [
      '<p><a href="/interpro/entry/InterPro/IPR000719/">kinase</a> <a href="/citation/PUB00003569">paper</a></p>',
      'kinase (IPR000719) paper (PUB00003569)',
    ],
    [
      '<a href="/IPR000719?cite=PUB00003569&amp;x=1">IPR000719 [[cite:PUB00003569]]</a>',
      'IPR000719 [[cite:PUB00003569]]',
    ],
    ['<a href="/IPR000719">unclosed', 'unclosed (IPR000719)'],
  ])('projects %s', (fragment, expected) => {
    expect(descriptionText(fragment)).toBe(expected);
  });

  it('keeps annotation order and all text instead of choosing an article', () => {
    expect(
      descriptionText([{ text: '<p>First</p>' }, { text: '<p>Second</p><ul><li>Third</li></ul>' }]),
    ).toBe('First\n\nSecond\n\n- Third');
  });

  const patterns = [
    (size: number) => '<'.repeat(size),
    (size: number) => '<p'.repeat(size / 2),
    (size: number) => '<div>'.repeat(Math.floor(size / 5)),
    (size: number) => '<ul><li>'.repeat(Math.floor(size / 8)),
    (size: number) => '<ul><li>x'.repeat(Math.floor(size / 9)),
    (size: number) => '&am'.repeat(Math.floor(size / 3)),
    (size: number) => `${'x'.repeat(size)}<br>`,
    (size: number) => 'x<br>'.repeat(Math.floor(size / 5)),
    (size: number) => `${'x'.repeat(size)}\n`,
    (size: number) => 'x\n'.repeat(Math.floor(size / 2)),
    (size: number) => `${' '.repeat(size)}\n<br>`,
    (size: number) =>
      `<a href="/IPR000719?ref=PUB00003569">${'IPR'.repeat(Math.floor(size / 3))}</a>`,
    (size: number) => `<a href="/PUB${'1'.repeat(size)}x">label</a>`,
  ];

  it.each(patterns.map((build, index) => [index, build] as const))(
    'keeps CPU growth below quadratic for fragment pattern %i',
    (_index, build) => {
      // Stay below Bun's large-string tier switch for the 64x ratio; bound larger inputs separately.
      for (let warm = 0; warm < 16; warm++) descriptionText(build(65536));
      const measure = (size: number) => {
        const fragment = build(size);
        const start = threadCpuUsage();
        for (let repeat = 0; repeat < 16; repeat++) descriptionText(fragment);
        const cpu = threadCpuUsage(start);
        return cpu.user + cpu.system;
      };
      const measurements: number[] = [];
      for (let size = 1024; size <= 65536; size *= 2) {
        const durationUs = measure(size);
        expect(durationUs).toBeLessThan(2_000_000);
        measurements.push(durationUs);
      }
      expect(measurements.at(-1) as number).toBeLessThan((measurements[0] as number) * 256);
      expect(measure(1_048_576)).toBeLessThan(4_000_000);
    },
  );
});
