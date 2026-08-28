'use strict';

const express = require('express');
const path = require('node:path');
const { createAnalyticsEngine, parseGastosCsv } = require('./lib/analytics');
const { createAsyncCache } = require('./lib/cache');
const { loadEmbeddedData } = require('./lib/embedded-data');

const DEFAULT_DROPBOX_PATH = '/Claude/Gastos Dashboard.csv';
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;

let connectorsPromise = null;
async function getConnectors() {
  if (!connectorsPromise) {
    connectorsPromise = import('@replit/connectors-sdk').then(({ ReplitConnectors }) => new ReplitConnectors());
  }
  return connectorsPromise;
}

async function fetchDropboxCSV() {
  const connectors = await getConnectors();
  const dropboxPath = process.env.DROPBOX_GASTOS_PATH || DEFAULT_DROPBOX_PATH;
  const response = await connectors.proxy('dropbox', '/2/files/download', {
    method: 'POST',
    headers: { 'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath }) }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Dropbox HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }
  return response.text();
}

function sanitizeMessages(messages, { maxMessages = 10, maxChars = 40_000 } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('messages precisa ser uma lista não vazia');
  const validRoles = new Set(['system', 'developer', 'user', 'assistant']);
  const cleaned = messages
    .filter(message => message && validRoles.has(message.role) && typeof message.content === 'string')
    .map(message => ({ role: message.role, content: message.content.trim() }))
    .filter(message => message.content);
  if (!cleaned.length) throw new Error('messages não contém mensagens válidas');

  let selected = cleaned;
  if (cleaned.length > maxMessages) {
    const fixed = cleaned.filter(message => message.role === 'system' || message.role === 'developer').slice(0, 1);
    selected = [...fixed, ...cleaned.filter(message => message.role !== 'system' && message.role !== 'developer').slice(-(maxMessages - fixed.length))];
  }
  const totalChars = selected.reduce((sum, message) => sum + message.content.length, 0);
  if (totalChars > maxChars) throw new Error(`Contexto acima do limite seguro (${totalChars} caracteres)`);
  return selected;
}

function compactLegacySummary(result) {
  return result.context;
}

function sanitizeAnalyticsInput(input) {
  const body = input && typeof input === 'object' ? input : {};
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (question.length > 2_000) {
    const error = new Error('Pergunta acima do limite seguro de 2.000 caracteres');
    error.statusCode = 400;
    throw error;
  }

  const result = { question };
  if (typeof body.includeExpenses === 'boolean') result.includeExpenses = body.includeExpenses;
  if (typeof body.includeAttendance === 'boolean') result.includeAttendance = body.includeAttendance;
  if (typeof body.includeFinancials === 'boolean') result.includeFinancials = body.includeFinancials;
  if (['month', 'month_unit', 'unit'].includes(body.groupBy)) result.groupBy = body.groupBy;

  if (body.periods !== undefined) {
    if (!Array.isArray(body.periods) || body.periods.length > 120 || body.periods.some(period => !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(period))) {
      const error = new Error('Períodos inválidos ou acima do limite de 120 meses');
      error.statusCode = 400;
      throw error;
    }
    result.periods = body.periods;
  }
  if (body.units !== undefined) {
    if (!Array.isArray(body.units) || body.units.length > 30 || body.units.some(unit => typeof unit !== 'string' || !unit.trim() || unit.length > 100)) {
      const error = new Error('Unidades inválidas ou acima do limite de 30 itens');
      error.statusCode = 400;
      throw error;
    }
    result.units = body.units.map(unit => unit.trim());
  }
  if (body.conversationContext !== undefined) {
    const context = body.conversationContext;
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      const error = new Error('Contexto da conversa inválido');
      error.statusCode = 400;
      throw error;
    }
    const sanitized = {};
    if (context.periods !== undefined) {
      if (!Array.isArray(context.periods) || context.periods.length > 120 || context.periods.some(period => !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(period))) {
        const error = new Error('Períodos do contexto inválidos');
        error.statusCode = 400;
        throw error;
      }
      sanitized.periods = [...new Set(context.periods)];
    }
    if (context.units !== undefined) {
      if (!Array.isArray(context.units) || context.units.length > 30 || context.units.some(unit => typeof unit !== 'string' || !unit.trim() || unit.length > 100)) {
        const error = new Error('Unidades do contexto inválidas');
        error.statusCode = 400;
        throw error;
      }
      sanitized.units = [...new Set(context.units.map(unit => unit.trim()))];
    }
    for (const field of ['includeExpenses', 'includeAttendance', 'includeFinancials', 'executiveKpis']) {
      if (typeof context[field] === 'boolean') sanitized[field] = context[field];
    }
    if ([null, 'category', 'type', 'payment', 'cost', 'employee'].includes(context.expenseDimension)) sanitized.expenseDimension = context.expenseDimension;
    if ([null, 'professional'].includes(context.attendanceDimension)) sanitized.attendanceDimension = context.attendanceDimension;
    if (['month', 'month_unit', 'unit'].includes(context.groupBy)) sanitized.groupBy = context.groupBy;
    for (const field of ['expenseLabels', 'professionalLabels']) {
      if (context[field] === undefined) continue;
      if (!Array.isArray(context[field]) || context[field].length > 30 || context[field].some(label => typeof label !== 'string' || label.length > 150)) {
        const error = new Error('Rótulos do contexto inválidos');
        error.statusCode = 400;
        throw error;
      }
      sanitized[field] = context[field];
    }
    result.conversationContext = sanitized;
  }
  return result;
}

function appendSourceContext(result, source) {
  const sourceLines = [];
  if (source.loadedAt) sourceLines.push(`Dropbox consultado em: ${source.loadedAt}`);
  if (source.cache === 'snapshot') {
    sourceLines.push('AVISO: o Dropbox está indisponível; foi usada somente a fotografia incorporada de gastos de 2026, claramente desatualizada e nunca somada ao arquivo diário.');
  } else if (source.stale) {
    sourceLines.push('AVISO: foi usado o último cache válido do Dropbox porque a atualização falhou.');
  }
  if (!sourceLines.length) return result;
  return { ...result, context: `${result.context}\n\n## ESTADO DA FONTE\n${sourceLines.join('\n')}` };
}

function createRateLimiter({ max, windowMs }) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    let entry = clients.get(key);
    if (!entry || now >= entry.resetAt) entry = { count: 0, resetAt: now + windowMs };
    entry.count++;
    clients.set(key, entry);
    if (clients.size > 10_000) {
      for (const [client, value] of clients) if (now >= value.resetAt) clients.delete(client);
    }
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', Math.max(0, max - entry.count));
    if (entry.count > max) return res.status(429).json({ error: 'Muitas requisições; tente novamente em instantes' });
    next();
  };
}

function createEmbeddedCurrentFallback(embedded) {
  const sourceRows = (embedded.gastos.gasto2026MesUnid || []).filter(row => row.ym >= '2026-01');
  const entries = sourceRows.map(row => ({
    data: null,
    competencia: row.ym,
    valor: Number(row.v) || 0,
    unidade: row.unid,
    categoria: 'N/A',
    tipo: 'N/A',
    formaPagamento: 'N/A',
    custo: 'N/A',
    funcionario: 'N/A',
    lancamentos: null,
    source: 'fotografia incorporada de 2026 (contingência)'
  }));
  const competencias = entries.map(row => row.competencia).sort();
  return {
    entries,
    meta: {
      totalRows: sourceRows.length,
      acceptedRows: sourceRows.length,
      rejected: { invalidDate: 0, invalidValue: 0, outsideCurrentWindow: 0, future: 0 },
      negativeAdjustmentRows: 0,
      negativeAdjustmentTotal: 0,
      zeroValueRows: 0,
      firstCompetencia: competencias[0] || null,
      lastCompetencia: competencias.at(-1) || null,
      lastDate: null,
      fallbackSnapshot: true
    }
  };
}

function createApp(options = {}) {
  const app = express();
  const getNow = () => options.now instanceof Date ? new Date(options.now) : new Date();
  const embedded = options.embeddedData || loadEmbeddedData(options.htmlPath || path.join(__dirname, 'dashboard-icb.html'));
  const csvLoader = options.fetchDropboxCSV || fetchDropboxCSV;
  const ttlMs = Number(options.cacheTtlMs ?? process.env.DROPBOX_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS);
  const sourceCache = createAsyncCache(async () => {
    const text = await csvLoader();
    const parsed = parseGastosCsv(text, { now: getNow(), knownUnits: embedded.gastoDetalhado.u });
    return { text, parsed };
  }, { ttlMs, now: options.clock || (() => Date.now()) });
  const allowForceRefresh = options.allowForceRefresh === true || process.env.ALLOW_FORCE_REFRESH === 'true';
  let engineSnapshot = null;

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createRateLimiter({ max: 180, windowMs: 60_000 }));
  app.use('/api/chat', createRateLimiter({ max: 30, windowMs: 60_000 }));
  app.use(express.static(__dirname));

  const wantsForceRefresh = req => allowForceRefresh && req.query.refresh === '1';

  async function getAnalytics({ force = false } = {}) {
    let snapshot;
    try {
      snapshot = await sourceCache.get({ force });
      if (!engineSnapshot || engineSnapshot.loadedAt !== snapshot.loadedAt) {
        const nowDate = getNow();
        engineSnapshot = {
          loadedAt: snapshot.loadedAt,
          engine: createAnalyticsEngine(embedded, snapshot.value.parsed, { now: nowDate })
        };
      }
    } catch (error) {
      if (!engineSnapshot) {
        const nowDate = getNow();
        const fallback = createEmbeddedCurrentFallback(embedded);
        engineSnapshot = {
          loadedAt: null,
          engine: createAnalyticsEngine(embedded, fallback, { now: nowDate })
        };
      }
      return {
        ...engineSnapshot,
        source: {
          cache: 'snapshot',
          loadedAt: engineSnapshot.loadedAt,
          stale: true,
          refreshError: error.message
        }
      };
    }
    return {
      ...engineSnapshot,
      source: {
        cache: snapshot.cache,
        loadedAt: snapshot.loadedAt,
        stale: snapshot.stale,
        refreshError: snapshot.refreshError || null
      }
    };
  }

  async function queryEndpoint(req, res, sourceOverrides = {}) {
    try {
      const analytics = await getAnalytics({ force: wantsForceRefresh(req) });
      const input = sanitizeAnalyticsInput({ ...(req.body || {}), ...sourceOverrides });
      const result = appendSourceContext(analytics.engine.query(input), analytics.source);
      res.json({ ...result, source: analytics.source });
    } catch (error) {
      console.error('[analytics]', error.message);
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  }

  app.get('/api/analytics/status', async (req, res) => {
    try {
      const analytics = await getAnalytics({ force: wantsForceRefresh(req) });
      res.json({ ...analytics.engine.status, source: analytics.source });
    } catch (error) {
      console.error('[analytics-status]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/gastos/query', (req, res) => queryEndpoint(req, res, {
    includeExpenses: true,
    includeAttendance: false
  }));

  app.post('/api/atendimentos/query', (req, res) => queryEndpoint(req, res, {
    includeExpenses: false,
    includeAttendance: true
  }));

  app.post('/api/analise-integrada', (req, res) => queryEndpoint(req, res));

  // Compatibilidade com clientes antigos: agora usa o mesmo cache e devolve um recorte compacto.
  app.get('/api/dropbox-summary', async (req, res) => {
    try {
      const analytics = await getAnalytics({ force: wantsForceRefresh(req) });
      const result = analytics.engine.query({
        question: 'gastos dos últimos 12 meses',
        includeExpenses: true,
        includeAttendance: false,
        groupBy: 'month'
      });
      res.type('text/plain; charset=utf-8').send(compactLegacySummary(result));
    } catch (error) {
      console.error('[dropbox-summary]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // O CSV bruto fica indisponível por padrão para não expor a base de funcionários.
  app.get('/api/dropbox-data', async (req, res) => {
    if (process.env.ENABLE_RAW_DATA_ENDPOINT !== 'true' && options.enableRawDataEndpoint !== true) {
      return res.status(404).json({ error: 'Endpoint de dados brutos desabilitado' });
    }
    try {
      const snapshot = await sourceCache.get({ force: wantsForceRefresh(req) });
      res.type('text/plain; charset=utf-8').send(snapshot.value.text);
    } catch (error) {
      console.error('[dropbox-data]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/chat', async (req, res) => {
    try {
      const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey && !options.openAIRequest) {
        return res.status(500).json({ error: 'OPENAI_API_KEY não configurada no servidor' });
      }

      const messages = sanitizeMessages(req.body?.messages);
      const requestedMax = Number(req.body?.max_tokens) || 700;
      const maxTokens = Math.min(1200, Math.max(100, requestedMax));
      const requestBody = {
        model: options.model || process.env.OPENAI_MODEL || 'gpt-4o',
        max_tokens: maxTokens,
        temperature: 0.2,
        messages
      };

      const startedAt = Date.now();
      let upstream;
      let data;
      if (options.openAIRequest) {
        data = await options.openAIRequest(requestBody);
        upstream = { ok: true, status: 200 };
      } else {
        upstream = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestBody)
        });
        data = await upstream.json();
      }

      if (!upstream.ok) return res.status(upstream.status).json(data);
      const text = data.choices?.[0]?.message?.content ?? data.text ?? '';
      const usage = data.usage || null;
      console.log('[chat-usage]', {
        model: requestBody.model,
        messages: messages.length,
        inputChars: messages.reduce((sum, message) => sum + message.content.length, 0),
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
        durationMs: Date.now() - startedAt
      });
      res.json({ content: [{ type: 'text', text }], usage });
    } catch (error) {
      console.error('[chat]', error.message);
      const status = /messages|Contexto|limite/.test(error.message) ? 400 : 500;
      res.status(status).json({ error: error.message });
    }
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT || 5000;
  app.listen(port, () => console.log(`ICB server listening on :${port}`));
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_DROPBOX_PATH,
  createApp,
  createEmbeddedCurrentFallback,
  fetchDropboxCSV,
  sanitizeAnalyticsInput,
  sanitizeMessages
};
