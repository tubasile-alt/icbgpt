'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  detectDelimiter,
  findColumn,
  normalizeText,
  parseDate,
  parseDelimited,
  parseMoney
} = require('../lib/csv');
const { parseGastosCsv } = require('../lib/analytics');
const { makeCurrentCsv } = require('./fixtures');

test('detecta o delimitador sem contar separadores dentro de aspas', () => {
  assert.equal(detectDelimiter('DATA2;DATA;"VALOR;BRUTO";UNIDADE'), ';');
  assert.equal(detectDelimiter('nome,valor,"observacao, longa"'), ',');
  assert.equal(detectDelimiter('nome\tvalor\tobservacao'), '\t');
});

test('lê campos com separador, quebra de linha e aspas escapadas', () => {
  const rows = parseDelimited([
    'nome,observacao,valor',
    '"Clínica, ICB","linha 1\nlinha 2","1.234,56"',
    '"José ""Z""",ok,10'
  ].join('\n'));

  assert.deepEqual(rows, [
    ['nome', 'observacao', 'valor'],
    ['Clínica, ICB', 'linha 1\nlinha 2', '1.234,56'],
    ['José "Z"', 'ok', '10']
  ]);
});

test('normaliza cabeçalhos e escolhe DATA, não DATA2', () => {
  const headers = [' DATA2 ', 'DÁTA', 'VALOR TOTAL'];
  assert.equal(normalizeText(headers[1]), 'data');
  assert.equal(findColumn(headers, ['data'], ['data']), 1);
  assert.equal(findColumn(headers, ['valor'], ['valor']), 2);
});

test('converte valores brasileiros e internacionais sem perder centavos', () => {
  assert.equal(parseMoney('R$ 1.234,56'), 1234.56);
  assert.equal(parseMoney('1.234.567,89'), 1234567.89);
  assert.equal(parseMoney('1,234.56'), 1234.56);
  assert.equal(parseMoney('1.234'), 1234);
  assert.equal(parseMoney('-25,40'), -25.4);
  assert.equal(parseMoney('sem valor'), null);
});

test('valida datas ISO, brasileiras e mensais', () => {
  assert.deepEqual(parseDate('2026-08-27').iso, '2026-08-27');
  assert.deepEqual(parseDate('27/08/2026').competencia, '2026-08');
  assert.deepEqual(parseDate('08/2026').iso, '2026-08-01');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('2026-13-01'), null);
});

test('CSV DATA2;DATA;VALOR aplica corte histórico, futuro e aliases', () => {
  const parsed = parseGastosCsv(makeCurrentCsv(), {
    now: new Date('2026-08-27T12:00:00Z'),
    knownUnits: ['Ribeirão Preto', 'Itaim Bibi']
  });

  assert.equal(parsed.meta.totalRows, 4);
  assert.equal(parsed.meta.acceptedRows, 2);
  assert.deepEqual(parsed.meta.rejected, {
    invalidDate: 0,
    invalidValue: 0,
    outsideCurrentWindow: 1,
    future: 1
  });
  assert.deepEqual(parsed.entries.map(row => ({
    data: row.data,
    valor: row.valor,
    unidade: row.unidade,
    categoria: row.categoria
  })), [
    { data: '2026-04-01', valor: 1234.56, unidade: 'Ribeirão Preto', categoria: 'Marketing; Performance' },
    { data: '2026-04-02', valor: 200, unidade: 'Itaim Bibi', categoria: 'Material' }
  ]);
});

test('rejeita CSV sem as colunas obrigatórias', () => {
  assert.throws(
    () => parseGastosCsv('DATA;CATEGORIA\n01/04/2026;Marketing'),
    /sem colunas obrigatórias de data\/valor/
  );
});

test('separa estornos, zeros e inválidos sem alterar o gasto bruto', () => {
  const parsed = parseGastosCsv([
    'DATA;VALOR;UNIDADE',
    '27/08/2026;100,00;RP',
    '27/08/2026;-25,40;RP',
    '27/08/2026;0;RP',
    '27/08/2026;sem valor;RP'
  ].join('\n'), {
    now: new Date('2026-08-27T12:00:00Z'),
    knownUnits: ['Ribeirão Preto']
  });

  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].valor, 100);
  assert.equal(parsed.meta.negativeAdjustmentRows, 1);
  assert.equal(parsed.meta.negativeAdjustmentTotal, -25.4);
  assert.equal(parsed.meta.zeroValueRows, 1);
  assert.equal(parsed.meta.rejected.invalidValue, 1);
});

test('corte diário respeita a data de São Paulo após 21h', () => {
  const parsed = parseGastosCsv([
    'DATA;VALOR',
    '27/08/2026;100',
    '28/08/2026;200'
  ].join('\n'), {
    // Em UTC já é dia 28, mas em São Paulo ainda é 27/08.
    now: new Date('2026-08-28T01:30:00Z')
  });

  assert.deepEqual(parsed.entries.map(row => row.data), ['2026-08-27']);
  assert.equal(parsed.meta.rejected.future, 1);
  assert.equal(parsed.meta.lastDate, '2026-08-27');
});
