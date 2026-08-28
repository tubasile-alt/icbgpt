'use strict';

const {
  findColumn,
  normalizeText,
  parseDate,
  parseDelimited,
  parseMoney
} = require('./csv');

const HISTORICAL_CUTOFF = '2025-12';
const CURRENT_START = '2026-01';
const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

const MONTHS = {
  janeiro: 1, jan: 1,
  fevereiro: 2, fev: 2,
  marco: 3, mar: 3,
  abril: 4, abr: 4,
  maio: 5, mai: 5,
  junho: 6, jun: 6,
  julho: 7, jul: 7,
  agosto: 8, ago: 8,
  setembro: 9, set: 9,
  outubro: 10, out: 10,
  novembro: 11, nov: 11,
  dezembro: 12, dez: 12
};

const UNIT_ALIASES = {
  af: 'Anália Franco',
  analia: 'Anália Franco',
  barra: 'Barra-RJ',
  bh: 'Belo Horizonte',
  bsb: 'Brasília',
  brasilia: 'Brasília',
  cg: 'Campo Grande',
  cgr: 'Campo Grande',
  cba: 'Cuiabá',
  ctb: 'Curitiba',
  fln: 'Florianópolis',
  floripa: 'Florianópolis',
  fort: 'Fortaleza',
  gyn: 'Goiânia',
  gru: 'Guarulhos',
  itaim: 'Itaim Bibi',
  sp: 'Itaim Bibi',
  'sao paulo': 'Itaim Bibi',
  jve: 'Joinville',
  jp: 'João Pessoa',
  jpa: 'João Pessoa',
  jdi: 'Jundiaí',
  lda: 'Londrina',
  mao: 'Manaus',
  poa: 'Porto Alegre',
  rec: 'Recife',
  rp: 'Ribeirão Preto',
  ribeirao: 'Ribeirão Preto',
  rj: 'Rio de Janeiro',
  rio: 'Rio de Janeiro',
  ssa: 'Salvador',
  sjc: 'São José dos Campos',
  slz: 'São Luís',
  udi: 'Uberlândia',
  vix: 'Vitória'
};

function canonicalUnit(value, knownUnits = []) {
  const raw = String(value ?? '').trim();
  if (!raw) return '(sem unidade)';
  const normalized = normalizeText(raw).replace(/[^a-z0-9]+/g, ' ').trim();
  if (UNIT_ALIASES[normalized]) return UNIT_ALIASES[normalized];
  const exact = knownUnits.find(unit => normalizeText(unit).replace(/[^a-z0-9]+/g, ' ').trim() === normalized);
  return exact || raw.replace(/\s+/g, ' ');
}

function businessDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const get = type => Number(parts.find(part => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function businessCompetencia(now = new Date()) {
  const { year, month } = businessDateParts(now);
  return `${year}-${String(month).padStart(2, '0')}`;
}

function parseGastosCsv(text, { now = new Date(), knownUnits = [] } = {}) {
  const rows = parseDelimited(text);
  if (rows.length < 2) throw new Error('CSV de gastos vazio');
  const headers = rows[0];
  const indexes = {
    data: findColumn(headers, ['data'], ['data', 'date', 'dt']),
    valor: findColumn(headers, ['valor'], ['valor', 'value', 'vlr', 'amount', 'total']),
    categoria: findColumn(headers, ['categoria'], ['categoria', 'category', 'cat']),
    unidade: findColumn(headers, ['unidade'], ['unidade', 'unit', 'filial', 'loja', 'cidade']),
    tipo: findColumn(headers, ['tipo de gasto'], ['tipo de gasto', 'tipo', 'type', 'subtipo']),
    formaPagamento: findColumn(headers, ['forma de pagamento'], ['forma de pagamento', 'pagamento', 'payment']),
    custo: findColumn(headers, ['custo'], ['custo', 'fixo variavel']),
    funcionario: findColumn(headers, ['funcionario'], ['funcionario', 'colaborador', 'employee'])
  };
  if (indexes.data < 0 || indexes.valor < 0) {
    throw new Error(`CSV de gastos sem colunas obrigatórias de data/valor: ${headers.join(', ')}`);
  }

  const todayParts = businessDateParts(now);
  const today = new Date(Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day, 23, 59, 59));
  const entries = [];
  const rejected = { invalidDate: 0, invalidValue: 0, outsideCurrentWindow: 0, future: 0 };
  let negativeAdjustmentRows = 0;
  let negativeAdjustmentTotal = 0;
  let zeroValueRows = 0;
  for (const columns of rows.slice(1)) {
    const parsedDate = parseDate(columns[indexes.data]);
    if (!parsedDate) {
      rejected.invalidDate++;
      continue;
    }
    if (parsedDate.date > today) {
      rejected.future++;
      continue;
    }
    if (parsedDate.competencia < CURRENT_START) {
      rejected.outsideCurrentWindow++;
      continue;
    }
    const valor = parseMoney(columns[indexes.valor]);
    if (!Number.isFinite(valor)) {
      rejected.invalidValue++;
      continue;
    }
    if (valor === 0) {
      zeroValueRows++;
      continue;
    }
    if (valor < 0) {
      negativeAdjustmentRows++;
      negativeAdjustmentTotal += valor;
      continue;
    }
    entries.push({
      data: parsedDate.iso,
      competencia: parsedDate.competencia,
      valor,
      unidade: canonicalUnit(indexes.unidade >= 0 ? columns[indexes.unidade] : '', knownUnits),
      categoria: String(indexes.categoria >= 0 ? columns[indexes.categoria] || 'N/A' : 'N/A').trim(),
      tipo: String(indexes.tipo >= 0 ? columns[indexes.tipo] || 'N/A' : 'N/A').trim(),
      formaPagamento: String(indexes.formaPagamento >= 0 ? columns[indexes.formaPagamento] || 'N/A' : 'N/A').trim(),
      custo: String(indexes.custo >= 0 ? columns[indexes.custo] || 'N/A' : 'N/A').trim(),
      funcionario: String(indexes.funcionario >= 0 ? columns[indexes.funcionario] || 'N/A' : 'N/A').trim()
    });
  }

  return {
    entries,
    meta: {
      totalRows: rows.length - 1,
      acceptedRows: entries.length,
      rejected,
      negativeAdjustmentRows,
      negativeAdjustmentTotal,
      zeroValueRows,
      firstCompetencia: entries.length ? entries.reduce((min, row) => row.competencia < min ? row.competencia : min, entries[0].competencia) : null,
      lastCompetencia: entries.length ? entries.reduce((max, row) => row.competencia > max ? row.competencia : max, entries[0].competencia) : null,
      lastDate: entries.length ? entries.reduce((max, row) => row.data > max ? row.data : max, entries[0].data) : null
    }
  };
}

function toCompetencia(shortYm) {
  return `20${shortYm.slice(0, 2)}-${shortYm.slice(2, 4)}`;
}

function addMonths(competencia, amount) {
  const [year, month] = competencia.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthRange(start, end) {
  const result = [];
  for (let current = start; current <= end; current = addMonths(current, 1)) result.push(current);
  return result;
}

function latestCompetencia(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function previousCompleteMonth(latest, now = new Date()) {
  if (!latest) return null;
  const current = businessCompetencia(now);
  return latest >= current ? addMonths(current, -1) : latest;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsToken(text, token) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`).test(text);
}

function editDistance(left, right) {
  const a = String(left);
  const b = String(right);
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

function mentionsApproximate(normalizedQuestion, target, maxDistance = 1) {
  return (normalizedQuestion.match(/[a-z0-9]+/g) || []).some(word =>
    Math.abs(word.length - target.length) <= maxDistance && editDistance(word, target) <= maxDistance
  );
}

function detectUnits(normalizedQuestion, knownUnits) {
  const found = new Set();
  for (const unit of knownUnits) {
    const normalized = normalizeText(unit);
    if (normalized.length > 2 && normalizedQuestion.includes(normalized)) found.add(unit);
  }
  for (const [alias, unit] of Object.entries(UNIT_ALIASES)) {
    if (mentionsToken(normalizedQuestion, normalizeText(alias))) found.add(unit);
  }
  if (!found.size) {
    const words = normalizedQuestion.match(/[a-z0-9]+/g) || [];
    let best = null;
    for (const word of words) {
      if (word.length < 6) continue;
      for (const unit of knownUnits) {
        const compactUnit = normalizeText(unit).replace(/[^a-z0-9]/g, '');
        if (compactUnit.length < 6 || Math.abs(word.length - compactUnit.length) > 3) continue;
        const distance = editDistance(word, compactUnit);
        if (distance <= 3 && (!best || distance < best.distance)) best = { unit, distance, tied: false };
        else if (best && distance === best.distance && unit !== best.unit) best.tied = true;
      }
    }
    if (best && !best.tied) found.add(best.unit);
  }
  return [...found];
}

function detectKnownLabels(normalizedQuestion, labels) {
  return labels.filter(label => {
    const normalized = normalizeText(label);
    return normalized.length >= 4 && normalizedQuestion.includes(normalized);
  });
}

function buildQueryPlan(question, {
  latestAttendance,
  latestExpenses,
  latestFinancials,
  knownUnits = [],
  knownCategories = [],
  knownTypes = [],
  knownExpenseEmployees = [],
  knownProfessionals = [],
  now = new Date()
} = {}) {
  const normalized = normalizeText(question);
  const expenseWords = /gasto|despesa|custo|categoria|pagamento|fornecedor|funcionario|colaborador|folha|salario|imposto|marketing|locomocao|hospita/;
  const attendanceWords = /atendimento|lead|consulta|retorno|cirurgia|faturamento|receita|dre|ebitda|medico|profissional|conversao/;
  const financialWords = /\bdre\b|ebitda|lucro|receita liquida|margem ebitda|irpj|csll|devolucao/;
  const executiveKpis = /visao (?:do )?ceo|painel (?:do )?ceo|indicadores? executiv|resumo executiv/.test(normalized)
    || (/lead/.test(normalized) && /marketing|cac/.test(normalized) && /conversao/.test(normalized)
      && /ticket/.test(normalized) && /custo total|principais custos/.test(normalized));
  let includeExpenses = expenseWords.test(normalized);
  let includeFinancials = financialWords.test(normalized);
  const mentionsProfessional = /medico|profissional|cirurgiao/.test(normalized)
    || mentionsApproximate(normalized, 'medico')
    || mentionsApproximate(normalized, 'cirurgiao');
  const mentionsSurgery = /cirurgia/.test(normalized) || mentionsApproximate(normalized, 'cirurgia');
  let includeAttendance = attendanceWords.test(normalized) || includeFinancials || mentionsProfessional || mentionsSurgery;
  if (executiveKpis) includeExpenses = includeAttendance = includeFinancials = true;
  if (!includeExpenses && !includeAttendance) includeExpenses = includeAttendance = true;

  const latestForSources = [
    includeAttendance && latestAttendance,
    includeExpenses && latestExpenses,
    includeFinancials && latestFinancials
  ].filter(Boolean).sort()[0];
  const reference = latestForSources || businessCompetencia(now);
  const currentCalendar = businessCompetencia(now);
  const completeReference = previousCompleteMonth(reference, now) || reference;
  const units = detectUnits(normalized, knownUnits);
  const categories = detectKnownLabels(normalized, knownCategories);
  const hospitalTypes = /hospita/.test(normalized)
    ? knownTypes.filter(label => normalizeText(label).includes('hospital'))
    : [];
  const types = [...new Set([...detectKnownLabels(normalized, knownTypes), ...hospitalTypes])];
  const expenseEmployees = detectKnownLabels(normalized, knownExpenseEmployees);
  const professionals = detectKnownLabels(normalized, knownProfessionals);
  let expenseDimension = null;
  if (/tipo de gasto|subtipo|hospita/.test(normalized)) expenseDimension = 'type';
  else if (/forma de pagamento|meio de pagamento/.test(normalized)) expenseDimension = 'payment';
  else if (/funcionario|colaborador/.test(normalized) || expenseEmployees.length) expenseDimension = 'employee';
  else if (/custo fixo|custo variavel|fixo vs|fixo e variavel/.test(normalized)) expenseDimension = 'cost';
  else if (/categoria|marketing|salario|imposto|locomocao/.test(normalized) || categories.length) expenseDimension = 'category';
  else if (types.length) expenseDimension = 'type';
  if (executiveKpis) expenseDimension = 'category';
  const attendanceDimension = mentionsProfessional ? 'professional' : null;
  const professionalPeriod = attendanceDimension && /por ano e por mes|por mes|mensal|mes a mes/.test(normalized) ? 'month' : null;
  const unsupportedDimensions = [];
  if (/fornecedor/.test(normalized)) unsupportedDimensions.push('A base de gastos disponível não possui uma coluna confiável de fornecedor.');
  const periods = new Set();
  const explicitYears = [...new Set(normalized.match(/20\d{2}/g) || [])];
  const hasNamedPeriod = Object.keys(MONTHS).some(name => mentionsToken(normalized, name));
  const explicitPeriod = explicitYears.length > 0 || hasNamedPeriod
    || /trimestre|semestre|mes atual|este mes|mes corrente|ultimo mes|mes passado|ultimos 12 meses|ultimo ano|12 meses/.test(normalized);

  for (const match of normalized.matchAll(/(20\d{2})[-/](1[0-2]|0?[1-9])(?!\d)/g)) {
    periods.add(`${match[1]}-${String(Number(match[2])).padStart(2, '0')}`);
  }

  for (const match of normalized.matchAll(/(1[0-2]|0?[1-9])\/(20\d{2})/g)) {
    periods.add(`${match[2]}-${String(Number(match[1])).padStart(2, '0')}`);
  }

  const explicitRange = normalized.match(/(20\d{2})[-/](1[0-2]|0?[1-9])(?!\d)\s*(?:a|ate|-)\s*(20\d{2})[-/](1[0-2]|0?[1-9])(?!\d)/);
  if (explicitRange) {
    const start = `${explicitRange[1]}-${String(Number(explicitRange[2])).padStart(2, '0')}`;
    const end = `${explicitRange[3]}-${String(Number(explicitRange[4])).padStart(2, '0')}`;
    if (start <= end && monthRange(start, end).length <= 120) {
      for (const competencia of monthRange(start, end)) periods.add(competencia);
    }
  }

  let namedMonths = [];
  for (const [name, number] of Object.entries(MONTHS)) {
    if (mentionsToken(normalized, name)) namedMonths.push(number);
  }
  namedMonths = [...new Set(namedMonths)];
  if (namedMonths.length) {
    const years = explicitYears.length ? explicitYears : [reference.slice(0, 4)];
    const isNamedRange = /\b(?:de|entre)\b.+\b(?:a|ate|e)\b/.test(normalized) && namedMonths.length >= 2;
    for (const year of years) {
      const selectedMonths = isNamedRange
        ? Array.from({ length: Math.max(...namedMonths) - Math.min(...namedMonths) + 1 }, (_, index) => Math.min(...namedMonths) + index)
        : namedMonths;
      for (const month of selectedMonths) periods.add(`${year}-${String(month).padStart(2, '0')}`);
    }
  }

  const quarterWords = { primeiro: 1, segundo: 2, terceiro: 3, quarto: 4 };
  const quarterMatch = normalized.match(/(?:^|\s)([1-4])(?:o|º|°)?\s*(?:tri|trimestre)/);
  const quarterWordMatch = normalized.match(/(?:primeiro|segundo|terceiro|quarto)\s+trimestre/);
  const selectedQuarter = quarterMatch ? Number(quarterMatch[1]) : quarterWordMatch ? quarterWords[quarterWordMatch[0].split(' ')[0]] : null;
  if (selectedQuarter) {
    const years = explicitYears.length ? explicitYears : [reference.slice(0, 4)];
    const startMonth = (selectedQuarter - 1) * 3 + 1;
    for (const year of years) for (let month = startMonth; month < startMonth + 3; month++) periods.add(`${year}-${String(month).padStart(2, '0')}`);
  } else if (/ultimo trimestre|ultimos 3 meses|trimestre/.test(normalized)) {
    const end = completeReference;
    for (let offset = -2; offset <= 0; offset++) periods.add(addMonths(end, offset));
  }

  if (/segundo semestre|2(?:o|º|°)? semestre/.test(normalized)) {
    const years = explicitYears.length ? explicitYears : [reference.slice(0, 4)];
    for (const year of years) for (let month = 7; month <= 12; month++) periods.add(`${year}-${String(month).padStart(2, '0')}`);
  } else if (/primeiro semestre|1(?:o|º|°)? semestre|semestre/.test(normalized)) {
    const years = explicitYears.length ? explicitYears : [reference.slice(0, 4)];
    for (const year of years) for (let month = 1; month <= 6; month++) periods.add(`${year}-${String(month).padStart(2, '0')}`);
  }

  if (/mes atual|este mes|mes corrente/.test(normalized)) periods.add(currentCalendar);
  if (/ultimo mes|mes passado/.test(normalized)) periods.add(completeReference);
  if (/ultimos 12 meses|ultimo ano|12 meses/.test(normalized)) {
    for (let offset = -11; offset <= 0; offset++) periods.add(addMonths(completeReference, offset));
  }

  if (!periods.size && explicitYears.length) {
    for (const year of explicitYears) for (let month = 1; month <= 12; month++) {
      periods.add(`${year}-${String(month).padStart(2, '0')}`);
    }
  }

  if (!periods.size) {
    if (executiveKpis) periods.add(completeReference);
    else for (let offset = -5; offset <= 0; offset++) periods.add(addMonths(reference, offset));
  }

  let groupBy = 'month';
  if (units.length) groupBy = 'month_unit';
  else if (/por unidade|entre unidades|qual unidade|quais unidades|ranking.*unidade|filiais/.test(normalized)) groupBy = 'unit';

  return {
    question,
    includeExpenses,
    includeAttendance,
    includeFinancials,
    executiveKpis,
    periods: [...periods].sort(),
    units,
    groupBy,
    expenseDimension,
    expenseLabels: executiveKpis ? [] : expenseDimension === 'category' ? categories : expenseDimension === 'type' ? types : expenseDimension === 'employee' ? expenseEmployees : [],
    attendanceDimension,
    professionalPeriod,
    professionalLabels: professionals,
    unsupportedDimensions,
    explicit: {
      units: units.length > 0,
      period: explicitPeriod,
      metrics: expenseWords.test(normalized) || attendanceWords.test(normalized) || financialWords.test(normalized) || executiveKpis,
      compareUnits: /compar|versus|\bvs\b/.test(normalized),
      clearUnits: /todas as unidades|toda a rede|rede inteira|consolidado geral|sem filtro de unidade/.test(normalized),
      reset: /nova analise|novo assunto|limpar contexto|zerar contexto|recomecar/.test(normalized)
    }
  };
}

function mergeConversationPlan(inferred, previous = {}) {
  const explicit = inferred.explicit || {};
  if (!previous || explicit.reset) return { plan: inferred, inherited: [] };
  const inherited = [];
  let units = inferred.units;
  if (explicit.clearUnits) units = [];
  else if (explicit.units && explicit.compareUnits) {
    units = [...new Set([...(previous.units || []), ...inferred.units])];
    if ((previous.units || []).length) inherited.push('unidade anterior para comparação');
  } else if (!explicit.units && Array.isArray(previous.units)) {
    units = previous.units;
    if (units.length) inherited.push('unidade');
  }

  let periods = inferred.periods;
  if (!explicit.period && Array.isArray(previous.periods) && previous.periods.length) {
    periods = previous.periods;
    inherited.push('período');
  }

  const metricFields = [
    'includeExpenses', 'includeAttendance', 'includeFinancials', 'executiveKpis',
    'expenseDimension', 'expenseLabels', 'attendanceDimension', 'professionalPeriod', 'professionalLabels'
  ];
  const metricState = {};
  if (!explicit.metrics) {
    for (const field of metricFields) {
      if (previous[field] !== undefined) metricState[field] = previous[field];
    }
    if (Object.keys(metricState).length) inherited.push('assunto');
  }

  let groupBy = inferred.groupBy;
  if (units.length) groupBy = 'month_unit';
  else if (/por unidade|entre unidades|ranking.*unidade|filiais/.test(normalizeText(inferred.question))) groupBy = 'unit';
  else groupBy = 'month';

  return {
    plan: { ...inferred, ...metricState, units, periods, groupBy },
    inherited
  };
}

function conversationContextFromPlan(plan) {
  return {
    units: plan.units,
    periods: plan.periods,
    includeExpenses: plan.includeExpenses,
    includeAttendance: plan.includeAttendance,
    includeFinancials: plan.includeFinancials,
    executiveKpis: plan.executiveKpis,
    expenseDimension: plan.expenseDimension,
    expenseLabels: plan.expenseLabels,
    attendanceDimension: plan.attendanceDimension,
    professionalPeriod: plan.professionalPeriod,
    professionalLabels: plan.professionalLabels,
    groupBy: plan.groupBy
  };
}

function groupKey(competencia, unidade, groupBy) {
  if (groupBy === 'unit') return unidade;
  if (groupBy === 'month_unit') return `${competencia}|${unidade}`;
  return competencia;
}

function filterMatches(row, plan) {
  if (!plan.periods.includes(row.competencia)) return false;
  if (plan.units.length && !plan.units.includes(row.unidade)) return false;
  return true;
}

function queryAtendimentos(atd, plan) {
  const byUnitMonth = new Map();
  for (const row of atd.r) {
    const competencia = toCompetencia(row[0]);
    const unidade = atd.u[row[1]];
    const key = `${competencia}|${unidade}`;
    if (!byUnitMonth.has(key)) {
      byUnitMonth.set(key, {
        competencia,
        unidade,
        leads: 0,
        faturamento: 0,
        consultas: 0,
        retornos: 0,
        cirurgias: 0,
        hasUnitTotals: false,
        hasProfessionalDetails: false
      });
    }
    const target = byUnitMonth.get(key);
    if (row[2] === -1) {
      target.leads += Number(row[3]) || 0;
      target.faturamento += Number(row[4]) || 0;
      target.hasUnitTotals = true;
    } else {
      target.consultas += Number(row[3]) || 0;
      target.retornos += Number(row[4]) || 0;
      target.cirurgias += Number(row[5]) || 0;
      target.hasProfessionalDetails = true;
    }
  }

  const grouped = new Map();
  for (const row of byUnitMonth.values()) {
    if (!filterMatches(row, plan)) continue;
    const key = groupKey(row.competencia, row.unidade, plan.groupBy);
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        competencia: plan.groupBy === 'unit' ? null : row.competencia,
        unidade: plan.groupBy === 'month' ? null : row.unidade,
        leads: 0,
        faturamento: 0,
        consultas: 0,
        retornos: 0,
        cirurgias: 0,
        hasUnitTotals: false,
        hasProfessionalDetails: false,
        competenciasAtendimento: new Set(),
        hasAtendimento: true
      });
    }
    const target = grouped.get(key);
    target.leads += row.leads;
    target.faturamento += row.faturamento;
    target.consultas += row.consultas;
    target.retornos += row.retornos;
    target.cirurgias += row.cirurgias;
    target.hasUnitTotals ||= row.hasUnitTotals;
    target.hasProfessionalDetails ||= row.hasProfessionalDetails;
    target.competenciasAtendimento.add(row.competencia);
  }
  return [...grouped.values()].map(row => ({
    ...row,
    leads: row.hasUnitTotals ? row.leads : null,
    faturamento: row.hasUnitTotals ? row.faturamento : null,
    consultas: row.hasProfessionalDetails ? row.consultas : null,
    retornos: row.hasProfessionalDetails ? row.retornos : null,
    cirurgias: row.hasProfessionalDetails ? row.cirurgias : null,
    competenciasAtendimento: [...row.competenciasAtendimento].sort()
  }));
}

function queryGastos(embedded, currentRows, plan) {
  const grouped = new Map();
  const warnings = [];
  const add = ({ competencia, unidade, valor, lancamentos, source }) => {
    const canonical = canonicalUnit(unidade, embedded.gastoDetalhado.u);
    const candidate = { competencia, unidade: canonical };
    if (!filterMatches(candidate, plan)) return;
    const key = groupKey(competencia, canonical, plan.groupBy);
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        competencia: plan.groupBy === 'unit' ? null : competencia,
        unidade: plan.groupBy === 'month' ? null : canonical,
        gastos: 0,
        lancamentos: 0,
        lancamentosKnown: true,
        hasGastos: true,
        competenciasGastos: new Set(),
        fontesGastos: new Set()
      });
    }
    const target = grouped.get(key);
    target.gastos += valor;
    if (Number.isFinite(lancamentos)) target.lancamentos += lancamentos;
    else target.lancamentosKnown = false;
    target.competenciasGastos.add(competencia);
    target.fontesGastos.add(source);
  };

  const needsUnitDetail = plan.groupBy !== 'month' || plan.units.length > 0;
  if (needsUnitDetail) {
    if (plan.periods.some(period => period <= HISTORICAL_CUTOFF)) {
      warnings.push('O detalhamento histórico por unidade/tipo foi incorporado com valores arredondados por grupo; pequenas diferenças de centavos frente ao total mensal são esperadas.');
    }
    if (plan.periods.some(period => period < '2024-01')) {
      warnings.push('O histórico de gastos incorporado anterior a 2024 não preserva detalhamento mensal por unidade.');
    }
    for (const row of embedded.gastoDetalhado.r) {
      const competencia = toCompetencia(row[0]);
      if (competencia > HISTORICAL_CUTOFF) continue;
      add({
        competencia,
        unidade: embedded.gastoDetalhado.u[row[1]],
        valor: Number(row[3]) || 0,
        lancamentos: Number(row[4]) || 0,
        source: 'histórico incorporado até 2025'
      });
    }
  } else {
    for (const row of embedded.gastos.porMes) {
      if (row.ym > HISTORICAL_CUTOFF) continue;
      add({
        competencia: row.ym,
        unidade: '(todas)',
        valor: Number(row.v) || 0,
        lancamentos: Number(row.n) || 0,
        source: 'histórico incorporado até 2025'
      });
    }
  }

  for (const row of currentRows) {
    add({
      competencia: row.competencia,
      unidade: row.unidade,
      valor: row.valor,
      lancamentos: Object.prototype.hasOwnProperty.call(row, 'lancamentos') ? row.lancamentos : 1,
      source: row.source || 'Dropbox diário desde 2026'
    });
  }

  return {
    rows: [...grouped.values()].map(row => ({
      ...row,
      lancamentos: row.lancamentosKnown ? row.lancamentos : null,
      competenciasGastos: [...row.competenciasGastos].sort(),
      fontesGastos: [...row.fontesGastos]
    })),
    warnings
  };
}

function queryDre(dre, plan, knownUnits = []) {
  const grouped = new Map();
  const fields = ['receitaBrutaDre', 'impostosDre', 'devolucoesDre', 'receitaLiquida', 'custosDespesasDre', 'ebitda', 'irpjCsll', 'lucroLiquido'];
  for (const source of dre?.rows || []) {
    const row = {
      competencia: source.competencia,
      unidade: canonicalUnit(source.unidade, knownUnits)
    };
    if (!filterMatches(row, plan)) continue;
    const key = groupKey(row.competencia, row.unidade, plan.groupBy);
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        competencia: plan.groupBy === 'unit' ? null : row.competencia,
        unidade: plan.groupBy === 'month' ? null : row.unidade,
        receitaBrutaDre: 0,
        impostosDre: 0,
        devolucoesDre: 0,
        receitaLiquida: 0,
        custosDespesasDre: 0,
        ebitda: 0,
        irpjCsll: 0,
        lucroLiquido: 0,
        competenciasDre: new Set(),
        hasDre: true
      });
    }
    const target = grouped.get(key);
    const values = {
      receitaBrutaDre: source.receitaBruta,
      impostosDre: source.impostos,
      devolucoesDre: source.devolucoes,
      receitaLiquida: source.receitaLiquida,
      custosDespesasDre: source.custosDespesas,
      ebitda: source.ebitda,
      irpjCsll: source.irpjCsll,
      lucroLiquido: source.lucroLiquido
    };
    for (const field of fields) target[field] += Number(values[field]) || 0;
    target.competenciasDre.add(row.competencia);
  }
  return [...grouped.values()].map(row => ({
    ...row,
    competenciasDre: [...row.competenciasDre].sort(),
    margemEbitdaPct: safeRatio(row.ebitda, row.receitaBrutaDre, 100)
  }));
}

function queryExpenseBreakdown(embedded, currentRows, plan) {
  if (!plan.includeExpenses || !plan.expenseDimension) return { rows: [], warnings: [] };
  const warnings = [];
  const grouped = new Map();
  const requestedLabels = new Set((plan.expenseLabels || []).map(normalizeText));
  const add = (label, valor, lancamentos, source) => {
    const cleanLabel = String(label || 'N/A').trim() || 'N/A';
    if (requestedLabels.size && !requestedLabels.has(normalizeText(cleanLabel))) return;
    if (!grouped.has(cleanLabel)) {
      grouped.set(cleanLabel, { label: cleanLabel, valor: 0, lancamentos: 0, countKnown: true, sources: new Set() });
    }
    const target = grouped.get(cleanLabel);
    target.valor += Number(valor) || 0;
    if (Number.isFinite(lancamentos)) target.lancamentos += lancamentos;
    else target.countKnown = false;
    target.sources.add(source);
  };

  const hasHistoricalPeriods = plan.periods.some(period => period <= HISTORICAL_CUTOFF);
  if (plan.expenseDimension === 'category' && hasHistoricalPeriods) {
    if (plan.units.length) {
      warnings.push('A base histórica não preserva categoria por unidade; o detalhe por categoria inclui apenas o período atual do Dropbox para esse filtro.');
    } else {
      for (const row of embedded.gastos.mesCategoria || []) {
        if (row.ym <= HISTORICAL_CUTOFF && plan.periods.includes(row.ym)) {
          add(row.cat, row.v, null, 'histórico incorporado até 2025');
        }
      }
    }
  } else if (plan.expenseDimension === 'type' && hasHistoricalPeriods) {
    for (const row of embedded.gastoDetalhado.r) {
      const competencia = toCompetencia(row[0]);
      const unidade = embedded.gastoDetalhado.u[row[1]];
      if (competencia > HISTORICAL_CUTOFF || !filterMatches({ competencia, unidade }, plan)) continue;
      add(embedded.gastoDetalhado.t[row[2]], Number(row[3]) || 0, Number(row[4]) || 0, 'histórico incorporado até 2025 (aproximado)');
    }
  } else if (hasHistoricalPeriods && ['payment', 'cost', 'employee'].includes(plan.expenseDimension)) {
    warnings.push('Forma de pagamento, classificação fixo/variável e funcionário não estão disponíveis no histórico com granularidade mensal; o detalhe mostra somente o Dropbox desde 2026.');
  }

  const currentField = {
    category: 'categoria',
    type: 'tipo',
    payment: 'formaPagamento',
    cost: 'custo',
    employee: 'funcionario'
  }[plan.expenseDimension];
  let unavailableCurrentDetail = false;
  for (const row of currentRows) {
    if (!filterMatches(row, plan)) continue;
    if (!row[currentField] || row[currentField] === 'N/A') {
      unavailableCurrentDetail = true;
      continue;
    }
    add(row[currentField], row.valor, 1, 'Dropbox diário desde 2026');
  }
  if (unavailableCurrentDetail) warnings.push('O snapshot de contingência não preserva esse detalhamento de gastos; reconecte o Dropbox para consultar a dimensão atual.');

  const limit = requestedLabels.size ? 30 : 10;
  return {
    rows: [...grouped.values()]
      .map(row => ({ ...row, lancamentos: row.countKnown ? row.lancamentos : null, sources: [...row.sources] }))
      .sort((a, b) => b.valor - a.valor)
      .slice(0, limit),
    warnings
  };
}

function queryProfessionalBreakdown(atd, plan) {
  if (!plan.includeAttendance || plan.attendanceDimension !== 'professional') return [];
  const grouped = new Map();
  const requested = new Set((plan.professionalLabels || []).map(normalizeText));
  for (const row of atd.r) {
    if (row[2] < 0) continue;
    const competencia = toCompetencia(row[0]);
    const unidade = atd.u[row[1]];
    if (!filterMatches({ competencia, unidade }, plan)) continue;
    const profissional = atd.p[row[2]];
    if (requested.size && !requested.has(normalizeText(profissional))) continue;
    const monthly = plan.professionalPeriod === 'month';
    const key = `${monthly ? competencia + '|' : ''}${unidade}|${profissional}`;
    if (!grouped.has(key)) {
      grouped.set(key, { competencia: monthly ? competencia : null, unidade, profissional, consultas: 0, retornos: 0, cirurgias: 0 });
    }
    const target = grouped.get(key);
    target.consultas += Number(row[3]) || 0;
    target.retornos += Number(row[4]) || 0;
    target.cirurgias += Number(row[5]) || 0;
  }
  return [...grouped.values()]
    .map(row => ({ ...row, conversaoConsultaCirurgiaPct: safeRatio(row.cirurgias, row.consultas, 100) }))
    .sort((a, b) => plan.professionalPeriod === 'month'
      ? `${a.competencia}|${a.unidade}|${a.profissional}`.localeCompare(`${b.competencia}|${b.unidade}|${b.profissional}`)
      : b.cirurgias - a.cirurgias || b.consultas - a.consultas)
    .slice(0, plan.professionalPeriod === 'month' ? 60 : requested.size ? 30 : 10);
}

function safeRatio(numerator, denominator, multiplier = 1) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    ? numerator / denominator * multiplier
    : null;
}

function mergeIntegrated(attendanceRows, expenseRows, financialRows, plan) {
  const merged = new Map();
  const ensure = row => {
    if (!merged.has(row.key)) {
      merged.set(row.key, {
        key: row.key,
        competencia: row.competencia ?? null,
        unidade: row.unidade ?? null,
        leads: null,
        consultas: null,
        retornos: null,
        cirurgias: null,
        faturamento: null,
        gastos: null,
        lancamentos: null,
        receitaBrutaDre: null,
        impostosDre: null,
        devolucoesDre: null,
        receitaLiquida: null,
        custosDespesasDre: null,
        ebitda: null,
        irpjCsll: null,
        lucroLiquido: null,
        margemEbitdaPct: null,
        hasAtendimento: false,
        hasGastos: false,
        hasDre: false
      });
    }
    return merged.get(row.key);
  };

  for (const row of attendanceRows) Object.assign(ensure(row), row);
  for (const row of expenseRows) Object.assign(ensure(row), row);
  for (const row of financialRows) Object.assign(ensure(row), row);

  return [...merged.values()].map(row => {
    const attendanceCoverage = row.competenciasAtendimento || [];
    const expenseCoverage = row.competenciasGastos || [];
    const comparableCoverage = plan.groupBy !== 'unit' || !plan.includeAttendance || !plan.includeExpenses
      || (attendanceCoverage.length === expenseCoverage.length && attendanceCoverage.every((period, index) => period === expenseCoverage[index]));
    return {
      ...row,
      coberturaComparavel: comparableCoverage,
      gastoSobreFaturamentoPct: comparableCoverage ? safeRatio(row.gastos, row.faturamento, 100) : null,
      gastoPorLead: comparableCoverage ? safeRatio(row.gastos, row.leads) : null,
      gastoPorConsulta: comparableCoverage ? safeRatio(row.gastos, row.consultas) : null,
      faturamentoPorCirurgia: safeRatio(row.faturamento, row.cirurgias),
      saldoOperacionalSimplificado: comparableCoverage && Number.isFinite(row.faturamento) && Number.isFinite(row.gastos)
        ? row.faturamento - row.gastos
        : null
    };
  }).sort((a, b) => {
    if (plan.groupBy === 'unit') return (b.faturamento || b.gastos || 0) - (a.faturamento || a.gastos || 0);
    return `${a.competencia}|${a.unidade || ''}`.localeCompare(`${b.competencia}|${b.unidade || ''}`);
  });
}

function formatNumber(value, decimals = 0) {
  if (!Number.isFinite(value)) return 'NA';
  return Number(value.toFixed(decimals)).toString();
}

function buildExecutiveSummary(rows, expenseBreakdown) {
  const sum = field => {
    const values = rows.map(row => row[field]).filter(Number.isFinite);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const marketingRows = expenseBreakdown.filter(row => normalizeText(row.label).includes('marketing'));
  const investimentoMarketing = marketingRows.length
    ? marketingRows.reduce((total, row) => total + row.valor, 0)
    : null;
  const leadsRecebidos = sum('leads');
  const cirurgiasRealizadas = sum('cirurgias');
  const receitaLiquidaDre = sum('receitaLiquida');

  return {
    leadsRecebidos,
    cirurgiasRealizadas,
    investimentoMarketing,
    custoPorLead: safeRatio(investimentoMarketing, leadsRecebidos),
    conversaoLeadCirurgiaPct: safeRatio(cirurgiasRealizadas, leadsRecebidos, 100),
    receitaLiquidaDre,
    ticketMedioLiquidoPorTransplante: safeRatio(receitaLiquidaDre, cirurgiasRealizadas),
    custoTotalDre: sum('custosDespesasDre'),
    gastosCaixaDropbox: sum('gastos'),
    faturamentoAtendimentos: sum('faturamento'),
    cacAproximadoPorCirurgia: safeRatio(investimentoMarketing, cirurgiasRealizadas)
  };
}

function formatContext(result, maxRows = 50) {
  const { plan, rows, expenseBreakdown = [], professionalBreakdown = [], professionalSummary = [], executiveSummary, inheritedContext = [], meta, warnings } = result;
  const selected = rows.slice(0, maxRows);
  const headers = [
    'competencia', 'unidade', 'leads', 'consultas', 'retornos', 'cirurgias', 'faturamento_R$',
    'gastos_R$', 'lancamentos_gastos', 'gastos_sobre_faturamento_pct', 'gasto_por_lead_R$', 'saldo_operacional_simplificado_R$'
  ];
  if (plan.groupBy === 'unit') headers.push('cobertura_atendimentos', 'cobertura_gastos');
  if (plan.includeFinancials) {
    headers.push('receita_bruta_DRE_R$', 'receita_liquida_DRE_R$', 'custos_despesas_DRE_R$', 'EBITDA_R$', 'margem_EBITDA_pct', 'lucro_liquido_DRE_R$');
  }
  const lines = [
    '## RECORTE ANALÍTICO INTEGRADO',
    `Contexto efetivo: ${plan.units.length ? plan.units.join(', ') : 'todas as unidades'} · ${plan.periods[0]} a ${plan.periods.at(-1)}.`,
    inheritedContext.length ? `Filtros herdados da conversa: ${inheritedContext.join(', ')}.` : 'Filtros definidos pela pergunta atual.',
    `Período solicitado: ${plan.periods[0]} a ${plan.periods.at(-1)}`,
    `Agrupamento: ${plan.groupBy === 'unit' ? 'unidade no período' : plan.groupBy === 'month_unit' ? 'mês e unidade' : 'mês'}`,
    `Fontes consultadas: ${[plan.includeAttendance && 'Controle de Atendimentos (incorporado)', plan.includeFinancials && 'DRE (incorporada)', plan.includeExpenses && 'Gastos (histórico até 2025 + Dropbox desde 2026)'].filter(Boolean).join('; ')}`,
    `Atualidade disponível: atendimentos ${meta.latestAttendance || 'NA'}; DRE ${meta.latestFinancials || 'NA'}; gastos ${meta.latestExpenses || 'NA'}`,
    'Faturamento/receita é competência operacional; a base de gastos é caixa. Custos/despesas da DRE e gastos do Dropbox não são a mesma métrica. Saldo operacional simplificado não é lucro contábil.',
    plan.includeExpenses
      ? `Definição de gastos atuais: bruto realizado, sem zeros, sem ${meta.gastosCsv.negativeAdjustmentRows || 0} estorno(s) negativos e sem ${meta.gastosCsv.rejected?.future || 0} lançamento(s) futuro(s). Última data realizada no CSV: ${meta.gastosCsv.lastDate || 'NA'}.`
      : '',
    '',
    headers.join('|')
  ];

  for (const row of selected) {
    const values = [
      row.competencia || 'PERIODO',
      row.unidade || 'TODAS',
      formatNumber(row.leads),
      formatNumber(row.consultas),
      formatNumber(row.retornos),
      formatNumber(row.cirurgias),
      formatNumber(row.faturamento, 2),
      formatNumber(row.gastos, 2),
      formatNumber(row.lancamentos),
      formatNumber(row.gastoSobreFaturamentoPct, 2),
      formatNumber(row.gastoPorLead, 2),
      formatNumber(row.saldoOperacionalSimplificado, 2)
    ];
    if (plan.groupBy === 'unit') {
      values.push((row.competenciasAtendimento || []).join(',') || 'NA', (row.competenciasGastos || []).join(',') || 'NA');
    }
    if (plan.includeFinancials) {
      values.push(
        formatNumber(row.receitaBrutaDre, 2),
        formatNumber(row.receitaLiquida, 2),
        formatNumber(row.custosDespesasDre, 2),
        formatNumber(row.ebitda, 2),
        formatNumber(row.margemEbitdaPct, 2),
        formatNumber(row.lucroLiquido, 2)
      );
    }
    lines.push(values.join('|'));
  }

  if (executiveSummary) {
    lines.push(
      '',
      '## VISÃO DO CEO',
      'Comece a resposta por este resumo executivo e responda todos os indicadores, mantendo NA quando a base não permitir o cálculo.',
      'indicador|valor|definicao',
      `Leads recebidos|${formatNumber(executiveSummary.leadsRecebidos)}|Contatos novos registrados no Controle de Atendimentos`,
      `Investimento em marketing_R$|${formatNumber(executiveSummary.investimentoMarketing, 2)}|Gastos realizados em categorias cujo nome contém marketing`,
      `Custo por lead (CPL)_R$|${formatNumber(executiveSummary.custoPorLead, 2)}|Investimento em marketing dividido pelos leads recebidos`,
      `Cirurgias realizadas|${formatNumber(executiveSummary.cirurgiasRealizadas)}|Cirurgias registradas no Controle de Atendimentos`,
      `Conversão lead para cirurgia_pct|${formatNumber(executiveSummary.conversaoLeadCirurgiaPct, 2)}|Cirurgias divididas pelos leads recebidos`,
      `Receita líquida DRE_R$|${formatNumber(executiveSummary.receitaLiquidaDre, 2)}|Receita líquida contábil da DRE`,
      `Ticket médio líquido por transplante_R$|${formatNumber(executiveSummary.ticketMedioLiquidoPorTransplante, 2)}|Receita líquida da DRE dividida pelas cirurgias`,
      `Custo total da unidade (DRE)_R$|${formatNumber(executiveSummary.custoTotalDre, 2)}|Custos e despesas totais da DRE; não somar novamente os gastos do Dropbox`,
      `Gastos realizados no caixa_R$|${formatNumber(executiveSummary.gastosCaixaDropbox, 2)}|Saídas realizadas na base diária de gastos; visão de caixa, não custo adicional à DRE`,
      `CAC aproximado por cirurgia_R$|${formatNumber(executiveSummary.cacAproximadoPorCirurgia, 2)}|Marketing dividido pelas cirurgias; aproximação gerencial sem atribuição individual por paciente`,
      'Observação: CPL e CAC aproximado dependem da classificação das despesas de marketing. O ticket usa receita líquida DRE/cirurgias e deve ser apresentado como estimativa se as bases tiverem critérios de competência diferentes.'
    );
  }

  if (expenseBreakdown.length) {
    const title = { category: 'CATEGORIA', type: 'TIPO DE GASTO', payment: 'FORMA DE PAGAMENTO', cost: 'FIXO/VARIÁVEL', employee: 'FUNCIONÁRIO' }[plan.expenseDimension];
    lines.push('', `## DETALHE DE GASTOS POR ${title}`, 'item|valor_R$|lancamentos|fonte');
    for (const row of expenseBreakdown) {
      lines.push(`${row.label}|${formatNumber(row.valor, 2)}|${formatNumber(row.lancamentos)}|${row.sources.join(', ')}`);
    }
  }

  if (professionalSummary.length) {
    lines.push('', '## TOTAL DO PERÍODO POR PROFISSIONAL', 'unidade|profissional|consultas|retornos|cirurgias|conversao_consulta_cirurgia_pct');
    for (const row of professionalSummary) {
      lines.push(`${row.unidade}|${row.profissional}|${row.consultas}|${row.retornos}|${row.cirurgias}|${formatNumber(row.conversaoConsultaCirurgiaPct, 2)}`);
    }
  }

  if (professionalBreakdown.length) {
    lines.push('', plan.professionalPeriod === 'month' ? '## ATENDIMENTO MENSAL POR PROFISSIONAL' : '## ATENDIMENTO POR PROFISSIONAL (TOP 10 OU NOMES SOLICITADOS)');
    lines.push(plan.professionalPeriod === 'month'
      ? 'competencia|unidade|profissional|consultas|retornos|cirurgias|conversao_consulta_cirurgia_pct'
      : 'unidade|profissional|consultas|retornos|cirurgias|conversao_consulta_cirurgia_pct');
    for (const row of professionalBreakdown) {
      lines.push(`${plan.professionalPeriod === 'month' ? row.competencia + '|' : ''}${row.unidade}|${row.profissional}|${row.consultas}|${row.retornos}|${row.cirurgias}|${formatNumber(row.conversaoConsultaCirurgiaPct, 2)}`);
    }
  }

  const allWarnings = [...warnings];
  if (rows.length > selected.length) allWarnings.push(`O recorte tinha ${rows.length} linhas; foram enviadas as ${selected.length} primeiras.`);
  if (plan.groupBy !== 'unit' && plan.periods.some(period => !rows.some(row => row.competencia === period))) {
    allWarnings.push('Existem competências solicitadas sem dados em uma ou mais fontes. NA significa dado indisponível, não zero.');
  }
  if (allWarnings.length) {
    lines.push('', '## AVISOS DE QUALIDADE');
    for (const warning of [...new Set(allWarnings)]) lines.push(`- ${warning}`);
  }
  return lines.join('\n');
}

function createAnalyticsEngine(embedded, parsedCurrentGastos, { now = new Date() } = {}) {
  const knownUnits = [...new Set([...embedded.atendimentos.u, ...embedded.gastoDetalhado.u])];
  const knownCategories = [...new Set([
    ...(embedded.gastos.porCategoria || []).map(row => row.k),
    ...parsedCurrentGastos.entries.map(row => row.categoria)
  ])];
  const knownTypes = [...new Set([...(embedded.gastoDetalhado.t || []), ...parsedCurrentGastos.entries.map(row => row.tipo)])];
  const knownExpenseEmployees = [...new Set(parsedCurrentGastos.entries.map(row => row.funcionario).filter(value => value && value !== 'N/A'))];
  const knownProfessionals = embedded.atendimentos.p || [];
  const latestAttendance = latestCompetencia(embedded.atendimentos.r.map(row => toCompetencia(row[0])));
  const latestFinancials = latestCompetencia((embedded.dre?.rows || []).map(row => row.competencia));
  const latestExpenses = latestCompetencia([
    ...embedded.gastos.porMes.filter(row => row.ym <= HISTORICAL_CUTOFF).map(row => row.ym),
    ...parsedCurrentGastos.entries.map(row => row.competencia)
  ]);

  const query = input => {
    const requested = input || {};
    const inferred = buildQueryPlan(requested.question || '', {
      latestAttendance,
      latestExpenses,
      latestFinancials,
      knownUnits,
      knownCategories,
      knownTypes,
      knownExpenseEmployees,
      knownProfessionals,
      now
    });
    const conversational = mergeConversationPlan(inferred, requested.conversationContext);
    const plan = {
      ...conversational.plan,
      includeExpenses: typeof requested.includeExpenses === 'boolean' ? requested.includeExpenses : conversational.plan.includeExpenses,
      includeAttendance: typeof requested.includeAttendance === 'boolean' ? requested.includeAttendance : conversational.plan.includeAttendance,
      includeFinancials: typeof requested.includeFinancials === 'boolean' ? requested.includeFinancials : conversational.plan.includeFinancials,
      periods: Array.isArray(requested.periods) && requested.periods.length
        ? [...new Set(requested.periods)].sort()
        : conversational.plan.periods,
      units: Array.isArray(requested.units) && requested.units.length
        ? requested.units.map(unit => canonicalUnit(unit, knownUnits))
        : conversational.plan.units,
      groupBy: ['month', 'month_unit', 'unit'].includes(requested.groupBy) ? requested.groupBy : conversational.plan.groupBy
    };

    const attendance = plan.includeAttendance ? queryAtendimentos(embedded.atendimentos, plan) : [];
    const expenses = plan.includeExpenses
      ? queryGastos(embedded, parsedCurrentGastos.entries, plan)
      : { rows: [], warnings: [] };
    const financials = plan.includeFinancials ? queryDre(embedded.dre, plan, knownUnits) : [];
    const rows = mergeIntegrated(attendance, expenses.rows, financials, plan);
    const expenseDetail = queryExpenseBreakdown(embedded, parsedCurrentGastos.entries, plan);
    const professionalBreakdown = queryProfessionalBreakdown(embedded.atendimentos, plan);
    const professionalSummary = plan.professionalPeriod === 'month'
      ? queryProfessionalBreakdown(embedded.atendimentos, { ...plan, professionalPeriod: null })
      : [];
    const executiveSummary = plan.executiveKpis ? buildExecutiveSummary(rows, expenseDetail.rows) : null;
    const warnings = [...expenses.warnings, ...expenseDetail.warnings, ...(plan.unsupportedDimensions || [])];
    if (plan.includeAttendance && plan.periods.some(period => period > latestAttendance)) {
      warnings.push(`Atendimentos incorporados disponíveis somente até ${latestAttendance}.`);
    }
    if (plan.includeExpenses && plan.periods.some(period => period > latestExpenses)) {
      warnings.push(`Gastos disponíveis somente até ${latestExpenses}.`);
    }
    if (plan.includeFinancials && plan.periods.some(period => period > latestFinancials)) {
      warnings.push(`DRE incorporada disponível somente até ${latestFinancials}.`);
    }
    if (plan.groupBy === 'unit' && plan.includeAttendance && plan.includeExpenses && rows.some(row => !row.coberturaComparavel)) {
      warnings.push('Uma ou mais unidades não têm os mesmos meses nas bases de atendimento e gastos; indicadores cruzados dessas linhas ficaram como NA.');
    }
    const currentCompetencia = businessCompetencia(now);
    if (plan.includeExpenses && plan.periods.includes(currentCompetencia) && latestExpenses >= currentCompetencia) {
      warnings.push(`${currentCompetencia} é mês corrente e seus gastos são parciais até a data da consulta.`);
    }
    const result = {
      plan,
      rows,
      expenseBreakdown: expenseDetail.rows,
      professionalBreakdown,
      professionalSummary,
      executiveSummary,
      conversationContext: conversationContextFromPlan(plan),
      inheritedContext: conversational.inherited,
      warnings,
      meta: {
        latestAttendance,
        latestFinancials,
        latestExpenses,
        gastosCsv: parsedCurrentGastos.meta,
        historicalCutoff: HISTORICAL_CUTOFF,
        currentStart: CURRENT_START
      }
    };
    return { ...result, context: formatContext(result) };
  };

  return {
    query,
    status: { latestAttendance, latestFinancials, latestExpenses, knownUnits, gastosCsv: parsedCurrentGastos.meta }
  };
}

module.exports = {
  BUSINESS_TIME_ZONE,
  CURRENT_START,
  HISTORICAL_CUTOFF,
  UNIT_ALIASES,
  addMonths,
  buildQueryPlan,
  businessCompetencia,
  businessDateParts,
  canonicalUnit,
  createAnalyticsEngine,
  formatContext,
  mergeConversationPlan,
  monthRange,
  parseGastosCsv,
  queryAtendimentos,
  queryDre,
  queryExpenseBreakdown,
  queryProfessionalBreakdown,
  queryGastos
};
