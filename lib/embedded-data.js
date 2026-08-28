'use strict';

const fs = require('node:fs');
const path = require('node:path');

function extractJsonAssignment(source, startMarker, endMarker) {
  const startAt = source.indexOf(startMarker);
  if (startAt < 0) throw new Error(`Marcador ausente no dashboard: ${startMarker.trim()}`);
  const valueStart = startAt + startMarker.length;
  const endAt = source.indexOf(endMarker, valueStart);
  if (endAt < 0) throw new Error(`Marcador final ausente no dashboard: ${endMarker.trim()}`);
  const segment = source.slice(valueStart, endAt);
  const semicolon = segment.lastIndexOf(';');
  if (semicolon < 0) throw new Error(`JSON incorporado sem terminador: ${startMarker.trim()}`);
  return JSON.parse(segment.slice(0, semicolon).trim());
}

function extractJsonStringAssignment(source, startMarker, endMarker) {
  const startAt = source.indexOf(startMarker);
  if (startAt < 0) throw new Error(`Marcador ausente no dashboard: ${startMarker.trim()}`);
  const valueStart = startAt + startMarker.length;
  const endAt = source.indexOf(endMarker, valueStart);
  if (endAt < 0) throw new Error(`Marcador final ausente no dashboard: ${endMarker.trim()}`);
  const literal = source.slice(valueStart, endAt).trim().replace(/;$/, '');
  return JSON.parse(literal);
}

function parseDreFromPayload(payload) {
  const legendLine = payload.match(/^## LEGENDA UNIDADES:\s*(.+)$/m)?.[1] || '';
  const units = new Map();
  for (const item of legendLine.split(';')) {
    const match = item.trim().match(/^(U\d+)=(.+)$/);
    if (match) units.set(match[1], match[2].trim());
  }

  const header = '## DRE MENSAL 2026 ';
  const sectionStart = payload.indexOf(header);
  if (sectionStart < 0) return { rows: [] };
  const bodyStart = payload.indexOf('\n', sectionStart) + 1;
  const nextSection = payload.indexOf('\n## ', bodyStart);
  const lines = payload.slice(bodyStart, nextSection < 0 ? payload.length : nextSection).split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    const columns = line.split('|');
    if (columns.length !== 10 || !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(columns[0])) continue;
    const numbers = columns.slice(2).map(Number);
    if (numbers.some(value => !Number.isFinite(value))) continue;
    rows.push({
      competencia: columns[0],
      unidade: units.get(columns[1]) || columns[1],
      receitaBruta: numbers[0],
      impostos: numbers[1],
      devolucoes: numbers[2],
      receitaLiquida: numbers[3],
      custosDespesas: numbers[4],
      ebitda: numbers[5],
      irpjCsll: numbers[6],
      lucroLiquido: numbers[7]
    });
  }
  return { rows };
}

function loadEmbeddedData(htmlPath = path.join(__dirname, '..', 'dashboard-icb.html')) {
  const source = fs.readFileSync(htmlPath, 'utf8');
  const payload = extractJsonStringAssignment(source, 'const PAYLOAD = ', '\n\n/* ================= PARSE DO PAYLOAD');
  return {
    gastos: extractJsonAssignment(source, 'const GASTOS = ', 'const GTONS = '),
    gastoDetalhado: extractJsonAssignment(source, 'const GDET = ', 'const ATD  = '),
    atendimentos: extractJsonAssignment(source, 'const ATD  = ', 'const MESNOME='),
    dre: parseDreFromPayload(payload)
  };
}

module.exports = {
  extractJsonAssignment,
  extractJsonStringAssignment,
  loadEmbeddedData,
  parseDreFromPayload
};
