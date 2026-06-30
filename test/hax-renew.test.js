import assert from 'node:assert/strict';
import test from 'node:test';
import { daysUntil, findExpiryDate } from '../scripts/expiry-parser.js';

test('parses hinted ISO expiry date', () => {
  const text = 'VPS Info\nExpired Date: 2026-07-03\nStatus: active';
  const date = findExpiryDate(text, new Date('2026-06-30T00:00:00Z'));

  assert.equal(date.toISOString().slice(0, 10), '2026-07-03');
});

test('parses Indonesian month name near expiry hint', () => {
  const text = 'Masa aktif VPS berakhir pada 5 Juli 2026.';
  const date = findExpiryDate(text, new Date('2026-06-30T00:00:00Z'));

  assert.equal(date.toISOString().slice(0, 10), '2026-07-05');
});

test('calculates remaining days from UTC day boundaries', () => {
  const now = new Date('2026-06-30T18:00:00Z');
  const expiry = new Date('2026-07-03T00:00:00Z');

  assert.equal(daysUntil(expiry, now), 3);
});

test('returns null when no date can be parsed', () => {
  const date = findExpiryDate('No expiry information is available.');

  assert.equal(date, null);
});
