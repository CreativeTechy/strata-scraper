import { describe, expect, it } from 'vitest';
import { attentionFirst, keepRowOrder, sourceNeedsAttention } from '../runSourceOrder.js';

const names = (rows) => rows.map((row) => row.source);

describe('sourceNeedsAttention', () => {
  it('flags every row that would not get the OK badge', () => {
    expect(sourceNeedsAttention({ source: 'a' })).toBe(false);
    expect(sourceNeedsAttention({ source: 'a', fetch_note: null, http_status: null, issue: null })).toBe(false);
    expect(sourceNeedsAttention({ source: 'a', issue: { code: 'setupLinkedin' } })).toBe(true);
    expect(sourceNeedsAttention({ source: 'a', network_blocked: true })).toBe(true);
    expect(sourceNeedsAttention({ source: 'a', http_status: 404 })).toBe(true);
    expect(sourceNeedsAttention({ source: 'a', fetch_note: 'HTTP 429' })).toBe(true);
  });
});

describe('attentionFirst', () => {
  it('moves 0-article failures off the tail of a scraped-desc ranking', () => {
    const rows = [
      { source: 'big', scraped: 50 },
      { source: 'mid', scraped: 20 },
      { source: 'limited', scraped: 9, fetch_note: 'HTTP 429' },
      { source: 'small', scraped: 3 },
      { source: 'blocked', scraped: 0, network_blocked: true, http_status: 403 },
      { source: 'missing', scraped: 0, http_status: 404 },
    ];
    expect(names(attentionFirst(rows))).toEqual(['limited', 'blocked', 'missing', 'big', 'mid', 'small']);
  });

  it('does not mutate its input', () => {
    const rows = [{ source: 'ok' }, { source: 'bad', fetch_note: 'x' }];
    attentionFirst(rows);
    expect(names(rows)).toEqual(['ok', 'bad']);
  });
});

describe('keepRowOrder', () => {
  it('keeps known rows in place when a poll re-ranks them', () => {
    const previous = [{ source: 'a', scraped: 5 }, { source: 'b', scraped: 4 }, { source: 'c', scraped: 3 }];
    const polled = [{ source: 'c', scraped: 9 }, { source: 'a', scraped: 6 }, { source: 'b', scraped: 4 }];
    const result = keepRowOrder(previous, polled);
    expect(names(result)).toEqual(['a', 'b', 'c']);
    // ...but carries the fresh counts.
    expect(result.find((row) => row.source === 'c').scraped).toBe(9);
  });

  it('appends sources seen for the first time, in server order', () => {
    const previous = [{ source: 'a' }, { source: 'b' }];
    const polled = [{ source: 'new2' }, { source: 'b' }, { source: 'new1' }, { source: 'a' }];
    expect(names(keepRowOrder(previous, polled))).toEqual(['a', 'b', 'new2', 'new1']);
  });

  it('drops rows the server no longer returns', () => {
    expect(names(keepRowOrder([{ source: 'a' }, { source: 'gone' }], [{ source: 'a' }]))).toEqual(['a']);
  });

  it('uses server order on the first load', () => {
    expect(names(keepRowOrder([], [{ source: 'x' }, { source: 'y' }]))).toEqual(['x', 'y']);
  });
});
