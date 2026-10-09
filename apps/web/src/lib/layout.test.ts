import { describe, expect, it } from 'vitest';
import { layoutDay } from './layout';

const seg = (id: string, start: number, end: number) => ({ item: id, start, end });
const summary = (xs: ReturnType<typeof layoutDay<string>>) =>
  Object.fromEntries(xs.map((p) => [p.item, `${p.col}/${p.cols}`]));

describe('layoutDay', () => {
  it('keeps non-overlapping events full width', () => {
    expect(summary(layoutDay([seg('a', 540, 600), seg('b', 600, 660)]))).toEqual({
      a: '0/1',
      b: '0/1',
    });
  });

  it('puts overlapping events side by side and reuses freed columns', () => {
    // a 9:00-10:00, b 9:30-11:00, c 10:00-10:30 (fits under a), d 12:00 alone
    expect(
      summary(
        layoutDay([seg('a', 540, 600), seg('b', 570, 660), seg('c', 600, 630), seg('d', 720, 780)]),
      ),
    ).toEqual({ a: '0/2', b: '1/2', c: '0/2', d: '0/1' });
  });

  it('gives very short events a minimum height for overlap purposes', () => {
    const out = layoutDay([seg('a', 600, 600), seg('b', 610, 640)]);
    expect(summary(out)).toEqual({ a: '0/2', b: '1/2' });
  });
});
