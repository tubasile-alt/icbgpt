'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildQueryPlan,
  canonicalUnit,
  createAnalyticsEngine,
  parseGastosCsv
} = require('../lib/analytics');
const { makeCurrentCsv, makeEmbeddedData } = require('./fixtures');

const now = new Date('2026-08-27T12:00:00Z');

function makeEngine() {
  const embedded = makeEmbeddedData();
  const parsed = parseGastosCsv(makeCurrentCsv(), {
    now,
    knownUnits: embedded.gastoDetalhado.u
  });
  return createAnalyticsEngine(embedded, parsed, { now });
}

test('planeja comparação integrada do segundo trimestre e reconhece RP', () => {
  const plan = buildQueryPlan(
    'Compare atendimento, faturamento e gastos de RP no 2º trimestre de 2026',
    {
      latestAttendance: '2026-05',
      latestExpenses: '2026-04',
      knownUnits: ['Ribeirão Preto', 'Itaim Bibi'],
      now
    }
  );

  assert.equal(plan.includeAttendance, true);
  assert.equal(plan.includeExpenses, true);
  assert.deepEqual(plan.periods, ['2026-04', '2026-05', '2026-06']);
  assert.deepEqual(plan.units, ['Ribeirão Preto']);
  assert.equal(plan.groupBy, 'month_unit');
});

test('normaliza aliases RP e SP para as unidades reais', () => {
  const known = ['Ribeirão Preto', 'Itaim Bibi'];
  assert.equal(canonicalUnit('RP', known), 'Ribeirão Preto');
  assert.equal(canonicalUnit('SP', known), 'Itaim Bibi');

  const spPlan = buildQueryPlan('faturamento e gastos de SP em abril de 2026', {
    latestAttendance: '2026-05',
    latestExpenses: '2026-04',
    knownUnits: known,
    now
  });
  assert.deepEqual(spPlan.units, ['Itaim Bibi']);
});

test('não soma o retrato incorporado de 2026 com o Dropbox diário', () => {
  const result = makeEngine().query({
    question: 'gastos e faturamento em abril de 2026',
    periods: ['2026-04'],
    groupBy: 'month'
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].gastos, 1434.56);
  assert.equal(result.rows[0].faturamento, 15000);
  assert.equal(result.rows[0].saldoOperacionalSimplificado, 13565.44);
  assert.ok(result.rows[0].gastos < 900000);
});

test('usa o incorporado até 2025 e o CSV apenas desde 2026', () => {
  const engine = makeEngine();
  const historical = engine.query({
    question: 'gastos de RP em dezembro de 2025',
    periods: ['2025-12'],
    units: ['RP'],
    groupBy: 'month_unit',
    includeAttendance: false,
    includeExpenses: true
  });
  const current = engine.query({
    question: 'gastos de RP em abril de 2026',
    periods: ['2026-04'],
    units: ['RP'],
    groupBy: 'month_unit',
    includeAttendance: false,
    includeExpenses: true
  });

  assert.equal(historical.rows[0].gastos, 500);
  assert.deepEqual(historical.rows[0].fontesGastos, ['histórico incorporado até 2025']);
  assert.equal(current.rows[0].gastos, 1234.56);
  assert.deepEqual(current.rows[0].fontesGastos, ['Dropbox diário desde 2026']);
});

test('mantém dado ausente como null/NA, nunca como zero', () => {
  const result = makeEngine().query({
    question: 'atendimentos, faturamento e gastos de RP em maio de 2026',
    periods: ['2026-05'],
    units: ['RP'],
    groupBy: 'month_unit'
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].faturamento, 12000);
  assert.equal(result.rows[0].consultas, 6);
  assert.equal(result.rows[0].gastos, null);
  assert.equal(result.rows[0].saldoOperacionalSimplificado, null);
  assert.match(result.context, /2026-05\|Ribeirão Preto\|12\|6\|3\|2\|12000\|NA\|NA\|NA\|NA/);
});

test('endpoint lógico exclusivo de gastos não inclui métricas de atendimento', () => {
  const result = makeEngine().query({
    question: 'gastos de abril de 2026',
    periods: ['2026-04'],
    includeExpenses: true,
    includeAttendance: false,
    groupBy: 'month'
  });

  assert.equal(result.plan.includeAttendance, false);
  assert.equal(result.rows[0].faturamento, null);
  assert.equal(result.rows[0].gastos, 1434.56);
});

test('não calcula indicadores cruzados quando a cobertura mensal por unidade difere', () => {
  const result = makeEngine().query({
    question: 'ranking por unidade de faturamento e gastos em abril e maio de 2026',
    periods: ['2026-04', '2026-05'],
    groupBy: 'unit'
  });
  const rp = result.rows.find(row => row.unidade === 'Ribeirão Preto');

  assert.deepEqual(rp.competenciasAtendimento, ['2026-04', '2026-05']);
  assert.deepEqual(rp.competenciasGastos, ['2026-04']);
  assert.equal(rp.coberturaComparavel, false);
  assert.equal(rp.gastoSobreFaturamentoPct, null);
  assert.equal(rp.saldoOperacionalSimplificado, null);
  assert.match(result.context, /indicadores cruzados dessas linhas ficaram como NA/);
});

test('interpreta mês/ano e trimestre em múltiplos anos', () => {
  const august = buildQueryPlan('gastos em 08/2026', {
    latestAttendance: '2026-05', latestExpenses: '2026-08', now
  });
  assert.deepEqual(august.periods, ['2026-08']);

  const quarters = buildQueryPlan('compare o 2º trimestre de 2025 e 2026', {
    latestAttendance: '2026-05', latestExpenses: '2026-08', now
  });
  assert.deepEqual(quarters.periods, ['2025-04', '2025-05', '2025-06', '2026-04', '2026-05', '2026-06']);
});

test('entrega recortes compactos de categoria, profissional e DRE quando solicitados', () => {
  const embedded = makeEmbeddedData();
  const csv = [
    'DATA;VALOR;CATEGORIA;UNIDADE;TIPO DE GASTO;FUNCIONARIO',
    '01/04/2026;100;MARKETING;RP;ANUNCIO;ANA'
  ].join('\n');
  const parsed = parseGastosCsv(csv, { now, knownUnits: embedded.gastoDetalhado.u });
  const engine = createAnalyticsEngine(embedded, parsed, { now });

  const category = engine.query({ question: 'gastos por categoria marketing em abril de 2026' });
  assert.equal(category.expenseBreakdown[0].label, 'MARKETING');
  assert.equal(category.expenseBreakdown[0].valor, 100);

  const professional = engine.query({ question: 'resultado do profissional A em RP em abril de 2026' });
  assert.equal(professional.professionalBreakdown[0].profissional, 'Profissional A');

  const dre = engine.query({ question: 'DRE e EBITDA de RP em abril de 2026' });
  assert.equal(dre.rows[0].ebitda, 3500);
  assert.equal(dre.rows[0].lucroLiquido, 3200);
  assert.match(dre.context, /EBITDA_R\$/);
});

test('tolera erros de digitação em médico, cirurgia e Porto Alegre', () => {
  const embedded = makeEmbeddedData();
  embedded.atendimentos.u.push('Porto Alegre');
  embedded.atendimentos.p.push('Médico Porto Alegre');
  embedded.atendimentos.r.push(
    ['2605', 2, -1, 20, 20000, 0, 0],
    ['2605', 2, 1, 10, 2, 4, 1]
  );
  const parsed = parseGastosCsv(makeCurrentCsv(), { now, knownUnits: embedded.gastoDetalhado.u });
  const result = createAnalyticsEngine(embedded, parsed, { now }).query({
    question: 'Calcule a conversão de cada Medco d eportpmalegre baseado número de consulta e número de corugia'
  });

  assert.deepEqual(result.plan.units, ['Porto Alegre']);
  assert.equal(result.plan.attendanceDimension, 'professional');
  assert.equal(result.professionalBreakdown.length, 1);
  assert.equal(result.professionalBreakdown[0].profissional, 'Médico Porto Alegre');
  assert.equal(result.professionalBreakdown[0].conversaoConsultaCirurgiaPct, 40);
  assert.match(result.context, /conversao_consulta_cirurgia_pct/);
});

test('entrega visão completa do CEO com os cinco indicadores gerenciais', () => {
  const result = makeEngine().query({
    question: 'Me dê uma visão do CEO para RP em abril de 2026'
  });

  assert.equal(result.plan.executiveKpis, true);
  assert.equal(result.plan.includeAttendance, true);
  assert.equal(result.plan.includeExpenses, true);
  assert.equal(result.plan.includeFinancials, true);
  assert.equal(result.plan.expenseDimension, 'category');
  assert.deepEqual(result.plan.periods, ['2026-04']);
  assert.deepEqual(result.plan.units, ['Ribeirão Preto']);
  assert.equal(result.executiveSummary.leadsRecebidos, 10);
  assert.equal(result.executiveSummary.cirurgiasRealizadas, 1);
  assert.equal(result.executiveSummary.investimentoMarketing, 1234.56);
  assert.ok(Math.abs(result.executiveSummary.custoPorLead - 123.456) < 1e-9);
  assert.equal(result.executiveSummary.conversaoLeadCirurgiaPct, 10);
  assert.equal(result.executiveSummary.receitaLiquidaDre, 9500);
  assert.equal(result.executiveSummary.ticketMedioLiquidoPorTransplante, 9500);
  assert.equal(result.executiveSummary.custoTotalDre, 6000);
  assert.equal(result.executiveSummary.gastosCaixaDropbox, 1234.56);
  assert.equal(result.executiveSummary.cacAproximadoPorCirurgia, 1234.56);
  assert.match(result.context, /## VISÃO DO CEO/);
  assert.match(result.context, /Custo total da unidade \(DRE\)_R\$\|6000/);
  assert.match(result.context, /não somar novamente os gastos do Dropbox/);
});

test('visão do CEO sem período usa o último mês completo comum às bases', () => {
  const plan = buildQueryPlan('Visão do CEO de RP', {
    latestAttendance: '2026-05',
    latestExpenses: '2026-04',
    knownUnits: ['Ribeirão Preto'],
    now
  });

  assert.deepEqual(plan.periods, ['2026-04']);
  assert.equal(plan.includeFinancials, true);

  const pastedQuestions = buildQueryPlan(
    'Leads recebidos no mês, CAC e marketing, conversão em cirurgia, ticket médio líquido e custo total da unidade',
    { latestAttendance: '2026-05', latestExpenses: '2026-04', latestFinancials: '2026-04', now }
  );
  assert.equal(pastedQuestions.executiveKpis, true);
  assert.deepEqual(pastedQuestions.periods, ['2026-04']);
});

test('mapeia hospitais para PAGAMENTO HOSPITAL na pergunta exata do usuário', () => {
  const embedded = makeEmbeddedData();
  embedded.atendimentos.u.push('Porto Alegre');
  embedded.gastoDetalhado.u.push('Porto Alegre');
  embedded.gastoDetalhado.t.push('PAGAMENTO HOSPITAL');
  const csv = [
    'DATA;VALOR;FORMA DE PAGAMENTO;TIPO DE GASTO;CUSTO;CATEGORIA;UNIDADE;FUNCIONARIO',
    '10/06/2026;63000;INTERNET BANKING;PAGAMENTO HOSPITAL;VARIAVEL;CIRURGIA;POA;OPERACIONAL',
    '11/06/2026;1000;INTERNET BANKING;MATERIAL;VARIAVEL;CIRURGIA;POA;OPERACIONAL'
  ].join('\n');
  const parsed = parseGastosCsv(csv, { now, knownUnits: embedded.gastoDetalhado.u });
  const result = createAnalyticsEngine(embedded, parsed, { now }).query({
    question: 'Em Porto Alegre qual valor dos gastos com hospitais'
  });

  assert.equal(result.plan.includeExpenses, true);
  assert.equal(result.plan.includeAttendance, false);
  assert.equal(result.plan.expenseDimension, 'type');
  assert.deepEqual(result.plan.expenseLabels, ['PAGAMENTO HOSPITAL']);
  assert.equal(result.expenseBreakdown.length, 1);
  assert.equal(result.expenseBreakdown[0].label, 'PAGAMENTO HOSPITAL');
  assert.equal(result.expenseBreakdown[0].valor, 63000);
  assert.match(result.context, /PAGAMENTO HOSPITAL\|63000/);
});
