'use strict';

function detectDelimiter(headerLine) {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const delimiter of candidates) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < headerLine.length; i++) {
      const char = headerLine[i];
      if (char === '"') {
        if (quoted && headerLine[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (!quoted && char === delimiter) {
        count++;
      }
    }
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function parseDelimited(text, delimiter) {
  if (typeof text !== 'string') throw new TypeError('CSV precisa ser texto');
  const clean = text.replace(/^\uFEFF/, '');
  const selected = delimiter || detectDelimiter(clean.split(/\r?\n/, 1)[0] || '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (quoted) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === selected) {
      row.push(field.trim());
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && clean[i + 1] === '\n') i++;
      row.push(field.trim());
      field = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field.trim());
    if (row.some(value => value !== '')) rows.push(row);
  }

  return rows;
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let raw = String(value ?? '')
    .replace(/R\$/gi, '')
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '');
  if (!raw) return null;

  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) raw = raw.replace(/\./g, '').replace(',', '.');
    else raw = raw.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const decimals = raw.length - lastComma - 1;
    raw = decimals > 0 && decimals <= 2 ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  } else if (lastDot >= 0) {
    const decimals = raw.length - lastDot - 1;
    if (decimals === 3 && /^-?\d{1,3}(\.\d{3})+$/.test(raw)) raw = raw.replace(/\./g, '');
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value) {
  const raw = String(value ?? '').trim();
  let year;
  let month;
  let day;
  let match;

  if ((match = raw.match(/^(\d{4})[-/]([01]?\d)(?:[-/]([0-3]?\d))?/))) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3] || 1);
  } else if ((match = raw.match(/^([0-3]?\d)[-/]([01]?\d)[-/](\d{4})/))) {
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  } else if ((match = raw.match(/^([01]?\d)[-/](\d{4})/))) {
    day = 1;
    month = Number(match[1]);
    year = Number(match[2]);
  } else {
    return null;
  }

  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { iso, competencia: iso.slice(0, 7), date };
}

function findColumn(headers, exactNames, partialNames = exactNames) {
  const normalized = headers.map(normalizeText);
  for (const name of exactNames.map(normalizeText)) {
    const index = normalized.indexOf(name);
    if (index >= 0) return index;
  }
  return normalized.findIndex(header => partialNames.map(normalizeText).some(name => header.includes(name)) && !/\d$/.test(header));
}

module.exports = {
  detectDelimiter,
  findColumn,
  normalizeText,
  parseDate,
  parseDelimited,
  parseMoney
};
