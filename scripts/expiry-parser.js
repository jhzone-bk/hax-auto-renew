const DATE_PATTERNS = [
  /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/g,
  /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/g,
  /\b(\d{1,2})\s+(Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December|Januari|Februari|Maret|Mei|Juni|Juli|Agustus|Agu|Oktober|Desember)\s+(\d{4})\b/gi
];

const MONTHS = new Map([
  ['jan', 0],
  ['january', 0],
  ['januari', 0],
  ['feb', 1],
  ['february', 1],
  ['februari', 1],
  ['mar', 2],
  ['march', 2],
  ['maret', 2],
  ['apr', 3],
  ['april', 3],
  ['may', 4],
  ['mei', 4],
  ['jun', 5],
  ['june', 5],
  ['juni', 5],
  ['jul', 6],
  ['july', 6],
  ['juli', 6],
  ['aug', 7],
  ['august', 7],
  ['agustus', 7],
  ['agu', 7],
  ['sep', 8],
  ['sept', 8],
  ['september', 8],
  ['oct', 9],
  ['october', 9],
  ['oktober', 9],
  ['nov', 10],
  ['november', 10],
  ['dec', 11],
  ['december', 11],
  ['desember', 11]
]);

const EXPIRY_HINT = /(expire|expired|expiry|expiration|valid until|due date|masa aktif|berakhir|kedaluwarsa|kadaluarsa|aktif sampai|tanggal expired|expired date)/i;

export function findExpiryDate(pageText, now = new Date()) {
  const candidates = collectDateCandidates(pageText);
  const hinted = candidates.filter((candidate) => EXPIRY_HINT.test(candidate.context));
  const usable = (hinted.length ? hinted : candidates)
    .filter((candidate) => candidate.date.getTime() >= startOfUtcDay(now).getTime())
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return usable[0]?.date ?? null;
}

export function daysUntil(expiryDate, now = new Date()) {
  const ms = startOfUtcDay(expiryDate).getTime() - startOfUtcDay(now).getTime();
  return Math.ceil(ms / 86_400_000);
}

function collectDateCandidates(text) {
  const candidates = [];

  for (const pattern of DATE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const date = parseMatchedDate(match);
      if (!date) continue;

      candidates.push({
        date,
        context: contextAround(text, match.index ?? 0, match[0].length)
      });
    }
  }

  return candidates;
}

function parseMatchedDate(match) {
  if (/^[A-Za-z]/.test(match[2] ?? '')) {
    return makeUtcDate(Number(match[3]), MONTHS.get(match[2].toLowerCase()), Number(match[1]));
  }

  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = Number(match[3]);

  if (match[1].length === 4) {
    return makeUtcDate(first, second - 1, third);
  }

  if (first > 12) {
    return makeUtcDate(third, second - 1, first);
  }

  if (second > 12) {
    return makeUtcDate(third, first - 1, second);
  }

  return makeUtcDate(third, second - 1, first);
}

function makeUtcDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return null;
  }

  return date;
}

function contextAround(text, index, length) {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + length + 80);
  return text.slice(start, end);
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
