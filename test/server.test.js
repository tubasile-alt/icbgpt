'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp, sanitizeMessages } = require('../server');
const { makeCurrentCsv, makeEmbeddedData } = require('./fixtures');

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function postJson(base, pathname, body) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function makeOptions(overrides = {}) {
  return {
    embeddedData: makeEmbeddedData(),
    fetchDropboxCSV: async () => makeCurrentCsv(),
    now: new Date('2026-08-27T12:00:00Z'),
    cacheTtlMs: 60_000,
    ...overrides
  };
}

test('status, consulta integrada e endpoint legado compartilham o cache', async t => {
  let loads = 0;
  const app = createApp(makeOptions({
    fetchDropboxCSV: async () => {
      loads++;
      return makeCurrentCsv();
    }
  }));
  const base = await listen(t, app);

  const statusResponse = await fetch(`${base}/api/analytics/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.latestAttendance, '2026-05');
  assert.equal(status.latestExpenses, '2026-04');
  assert.equal(status.gastosCsv.acceptedRows, 2);

  const integratedResponse = await postJson(base, '/api/analise-integrada', {
    question: 'Compare atendimento, faturamento e gastos de RP no 2º trimestre de 2026'
  });
  assert.equal(integratedResponse.status, 200);
  const integrated = await integratedResponse.json();
  assert.deepEqual(integrated.plan.units, ['Ribeirão Preto']);
  assert.equal(integrated.rows.find(row => row.competencia === '2026-04').gastos, 1234.56);
  assert.equal(integrated.source.cache, 'hit');

  const legacyResponse = await fetch(`${base}/api/dropbox-summary`);
  assert.equal(legacyResponse.status, 200);
  assert.match(legacyResponse.headers.get('content-type'), /^text\/plain/);
  assert.match(await legacyResponse.text(), /RECORTE ANALÍTICO INTEGRADO/);
  assert.equal(loads, 1);
});

test('endpoints exclusivos forçam a fonte correta', async t => {
  const base = await listen(t, createApp(makeOptions()));

  const gastosResponse = await postJson(base, '/api/gastos/query', {
    question: 'abril de 2026',
    includeAttendance: true,
    periods: ['2026-04']
  });
  const gastos = await gastosResponse.json();
  assert.equal(gastosResponse.status, 200);
  assert.equal(gastos.plan.includeExpenses, true);
  assert.equal(gastos.plan.includeAttendance, false);
  assert.equal(gastos.rows[0].faturamento, null);

  const atendimentosResponse = await postJson(base, '/api/atendimentos/query', {
    question: 'abril de 2026',
    includeExpenses: true,
    periods: ['2026-04']
  });
  const atendimentos = await atendimentosResponse.json();
  assert.equal(atendimentosResponse.status, 200);
  assert.equal(atendimentos.plan.includeExpenses, false);
  assert.equal(atendimentos.plan.includeAttendance, true);
  assert.equal(atendimentos.rows[0].gastos, null);
});

test('API aceita contexto estruturado e mantém filtros entre perguntas', async t => {
  const base = await listen(t, createApp(makeOptions()));
  const firstResponse = await postJson(base, '/api/analise-integrada', {
    question: 'Panorama de RP em abril de 2026'
  });
  const first = await firstResponse.json();
  const followUpResponse = await postJson(base, '/api/analise-integrada', {
    question: 'E os gastos?',
    conversationContext: first.conversationContext
  });
  const followUp = await followUpResponse.json();

  assert.equal(followUpResponse.status, 200);
  assert.deepEqual(followUp.plan.units, ['Ribeirão Preto']);
  assert.deepEqual(followUp.plan.periods, ['2026-04']);
  assert.deepEqual(followUp.inheritedContext, ['unidade', 'período']);
});

test('API rejeita contexto conversacional adulterado', async t => {
  const base = await listen(t, createApp(makeOptions()));
  const response = await postJson(base, '/api/analise-integrada', {
    question: 'E os gastos?',
    conversationContext: { periods: ['2026-99'], units: ['RP'] }
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Períodos do contexto inválidos/);
});

test('CSV bruto fica oculto por padrão e pode ser habilitado explicitamente', async t => {
  const disabledBase = await listen(t, createApp(makeOptions()));
  const disabled = await fetch(`${disabledBase}/api/dropbox-data`);
  assert.equal(disabled.status, 404);
  assert.deepEqual(await disabled.json(), { error: 'Endpoint de dados brutos desabilitado' });

  const enabledBase = await listen(t, createApp(makeOptions({ enableRawDataEndpoint: true })));
  const enabled = await fetch(`${enabledBase}/api/dropbox-data`);
  assert.equal(enabled.status, 200);
  assert.match(await enabled.text(), /^DATA2;DATA;VALOR;/);
});

test('sanitizeMessages limita histórico, preserva instrução e rejeita contexto gigante', () => {
  const messages = [
    { role: 'system', content: '  instrução  ' },
    ...Array.from({ length: 11 }, (_, index) => ({ role: 'user', content: `mensagem-${index}` }))
  ];
  const sanitized = sanitizeMessages(messages);

  assert.equal(sanitized.length, 10);
  assert.deepEqual(sanitized[0], { role: 'system', content: 'instrução' });
  assert.equal(sanitized[1].content, 'mensagem-2');
  assert.equal(sanitized.at(-1).content, 'mensagem-10');
  assert.throws(() => sanitizeMessages([{ role: 'user', content: 'x'.repeat(80_001) }]), /acima do limite seguro/);
  assert.throws(() => sanitizeMessages([]), /lista não vazia/);
  assert.throws(() => sanitizeMessages([{ role: 'tool', content: 'inválida' }]), /mensagens válidas/);
});

test('chat aplica limites de saída e mantém o formato compatível da resposta', async t => {
  const requests = [];
  const base = await listen(t, createApp(makeOptions({
    openAIRequest: async body => {
      requests.push(body);
      return {
        choices: [{ message: { content: 'Resposta curta' } }],
        usage: { prompt_tokens: 20, completion_tokens: 3 }
      };
    }
  })));

  const tooLarge = await postJson(base, '/api/chat', {
    messages: [{ role: 'user', content: 'x'.repeat(80_001) }]
  });
  assert.equal(tooLarge.status, 400);
  assert.match((await tooLarge.json()).error, /acima do limite seguro/);
  assert.equal(requests.length, 0);

  const response = await postJson(base, '/api/chat', {
    messages: [{ role: 'user', content: 'Faça um resumo' }],
    max_tokens: 99999
  });
  assert.equal(response.status, 200);
  assert.equal(requests[0].max_tokens, 1200);
  assert.equal(requests[0].temperature, 0.2);
  assert.equal(requests[0].model, 'gpt-4o');
  assert.deepEqual(await response.json(), {
    content: [{ type: 'text', text: 'Resposta curta' }],
    usage: { prompt_tokens: 20, completion_tokens: 3 }
  });

  const minimum = await postJson(base, '/api/chat', {
    messages: [{ role: 'user', content: 'Oi' }],
    max_tokens: 1
  });
  assert.equal(minimum.status, 200);
  assert.equal(requests[1].max_tokens, 100);
});

test('chat rejeita corpo inválido antes de chamar o provedor', async t => {
  let calls = 0;
  const base = await listen(t, createApp(makeOptions({
    openAIRequest: async () => {
      calls++;
      return { choices: [{ message: { content: 'não deveria chamar' } }] };
    }
  })));

  const response = await postJson(base, '/api/chat', { messages: [] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /lista não vazia/);
  assert.equal(calls, 0);
});

test('falha inicial do Dropbox usa apenas o snapshot 2026 claramente identificado', async t => {
  const base = await listen(t, createApp(makeOptions({
    fetchDropboxCSV: async () => { throw new Error('Dropbox fora'); }
  })));

  const statusResponse = await fetch(`${base}/api/analytics/status`);
  const status = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.equal(status.latestExpenses, '2026-04');
  assert.equal(status.source.cache, 'snapshot');
  assert.equal(status.source.stale, true);

  const response = await postJson(base, '/api/gastos/query', {
    question: 'gastos de RP em abril de 2026',
    periods: ['2026-04'],
    units: ['RP'],
    groupBy: 'month_unit'
  });
  const result = await response.json();
  assert.equal(result.rows[0].gastos, 900000);
  assert.deepEqual(result.rows[0].fontesGastos, ['fotografia incorporada de 2026 (contingência)']);
  assert.match(result.context, /fotografia incorporada de gastos de 2026/);
});

test('CSV malformado não substitui cache válido e refresh público não ignora TTL', async t => {
  let clock = 1_000;
  let calls = 0;
  const base = await listen(t, createApp(makeOptions({
    clock: () => clock,
    cacheTtlMs: 50,
    fetchDropboxCSV: async () => {
      calls++;
      return calls === 1 ? makeCurrentCsv() : 'ARQUIVO;SEM;COLUNAS\n1;2;3';
    }
  })));

  const first = await fetch(`${base}/api/analytics/status`);
  assert.equal(first.status, 200);
  assert.equal(calls, 1);

  const blockedForce = await fetch(`${base}/api/analytics/status?refresh=1`);
  assert.equal(blockedForce.status, 200);
  assert.equal(calls, 1);

  clock += 51;
  const staleResponse = await fetch(`${base}/api/analytics/status`);
  const stale = await staleResponse.json();
  assert.equal(staleResponse.status, 200);
  assert.equal(calls, 2);
  assert.equal(stale.latestExpenses, '2026-04');
  assert.equal(stale.source.stale, true);
  assert.equal(stale.source.cache, 'stale');
});
