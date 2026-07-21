const express = require('express');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static('.'));

// Lazy-load the ESM connector SDK
let _connectors = null;
async function getConnectors() {
  if (!_connectors) {
    const { ReplitConnectors } = await import('@replit/connectors-sdk');
    _connectors = new ReplitConnectors();
  }
  return _connectors;
}

// ── Fetch CSV bruto do Dropbox (usado internamente pelo summary) ───────────
async function fetchDropboxCSV() {
  const connectors = await getConnectors();
  const response = await connectors.proxy('dropbox', '/2/files/download', {
    method: 'POST',
    headers: {
      'Dropbox-API-Arg': JSON.stringify({ path: '/claude/gastos dashboard.csv' })
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('Dropbox HTTP ' + response.status + ': ' + detail.slice(0, 200));
  }
  return response.text();
}

// ── Resumo agregado do CSV (evita enviar 1 MB bruto para a IA) ────────────
app.get('/api/dropbox-summary', async (req, res) => {
  try {
    const raw = await fetchDropboxCSV();
    const lines = raw.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return res.status(502).json({ error: 'CSV vazio' });

    // Detectar delimitador
    const delim = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : ',';

    // Detectar colunas — prefere match exato antes de parcial
    const headers = lines[0].split(delim).map(h => h.replace(/"/g, '').trim().toLowerCase());
    const ci = (exact, partials) => {
      // 1. match exato
      let idx = headers.indexOf(exact);
      if (idx >= 0) return idx;
      // 2. match parcial excluindo sufixos numéricos (data2, data3…)
      idx = headers.findIndex(h => partials.some(n => h === n));
      if (idx >= 0) return idx;
      // 3. qualquer parcial
      return headers.findIndex(h => partials.some(n => h.includes(n) && !/\d$/.test(h)));
    };
    const iData  = ci('data',       ['data', 'date', 'dt']);
    const iValor = ci('valor',      ['valor', 'value', 'vlr', 'amount', 'total']);
    const iCat   = ci('categoria',  ['categoria', 'category', 'cat']);
    const iUnid  = ci('unidade',    ['unidade', 'unit', 'filial', 'loja', 'cidade']);
    const iTipo  = ci('tipo de gasto', ['tipo de gasto', 'tipo', 'type', 'subtipo']);

    console.log('[dropbox-summary] colunas detectadas:', { iData, iValor, iCat, iUnid, iTipo, headers: headers.slice(0, 10) });

    // Agregação
    const agg = {};
    const add = (key, val) => {
      if (!agg[key]) agg[key] = { v: 0, n: 0 };
      agg[key].v += val;
      agg[key].n++;
    };

    let total = 0, nLanc = 0;
    const mesSet = new Set();

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(delim).map(c => c.replace(/"/g, '').trim());
      const rawV = iValor >= 0 ? cols[iValor] || '' : '';
      const val = parseFloat(rawV.replace(',', '.').replace(/\s/g, ''));
      if (!isFinite(val) || val <= 0) continue;

      const rawD = iData >= 0 ? cols[iData] || '' : '';
      let ano = '', mes = '';
      const m1 = rawD.match(/(\d{4})-(\d{2})/);
      const m2 = rawD.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      const m3 = rawD.match(/(\d{2})\/(\d{4})/);
      if (m1)      { ano = m1[1]; mes = m1[1] + '-' + m1[2]; }
      else if (m2) { ano = m2[3]; mes = m2[3] + '-' + m2[2]; }
      else if (m3) { ano = m3[2]; mes = m3[2] + '-' + m3[1]; }
      else continue;

      const cat  = iCat  >= 0 ? (cols[iCat]  || 'N/A') : 'N/A';
      const unid = iUnid >= 0 ? (cols[iUnid] || 'N/A') : 'N/A';
      const tipo = iTipo >= 0 ? (cols[iTipo] || 'N/A') : 'N/A';

      total += val; nLanc++;
      mesSet.add(mes);

      add('ano|' + ano, val);
      add('ano_cat|' + ano + '|' + cat, val);
      add('ano_unid|' + ano + '|' + unid, val);
      add('ano_tipo|' + ano + '|' + tipo, val);
      add('mes|' + mes, val);
      add('mes_unid_tipo|' + mes + '|' + unid + '|' + tipo, val);
    }

    const meses = [...mesSet].sort();
    const anos  = [...new Set(meses.map(m => m.slice(0, 4)))].sort();

    const out = [];

    out.push('## RESUMO GERAL — GASTOS ICB');
    out.push('Total: R$ ' + Math.round(total).toLocaleString('pt-BR') +
             ' | Lancamentos: ' + nLanc.toLocaleString('pt-BR') +
             ' | Ticket medio: R$ ' + Math.round(total / nLanc).toLocaleString('pt-BR'));
    out.push('Periodo: ' + meses[0] + ' a ' + meses[meses.length - 1]);
    out.push('');

    // Por ano
    out.push('## TOTAL POR ANO');
    out.push('Ano|Total R$|Lancamentos');
    for (const a of anos) {
      const r = agg['ano|' + a] || { v: 0, n: 0 };
      out.push(a + '|' + Math.round(r.v) + '|' + r.n);
    }
    out.push('');

    // Por ano+categoria
    out.push('## GASTOS POR ANO E CATEGORIA');
    out.push('Ano|Categoria|Total R$');
    const cats = [...new Set(Object.keys(agg).filter(k => k.startsWith('ano_cat|')).map(k => k.split('|')[2]))].sort();
    for (const a of anos) for (const c of cats) {
      const r = agg['ano_cat|' + a + '|' + c];
      if (r && r.v > 0) out.push(a + '|' + c + '|' + Math.round(r.v));
    }
    out.push('');

    // Por ano+unidade
    out.push('## GASTOS POR ANO E UNIDADE');
    out.push('Ano|Unidade|Total R$');
    const unids = [...new Set(Object.keys(agg).filter(k => k.startsWith('ano_unid|')).map(k => k.split('|')[2]))].sort();
    for (const a of anos) for (const u of unids) {
      const r = agg['ano_unid|' + a + '|' + u];
      if (r && r.v > 0) out.push(a + '|' + u + '|' + Math.round(r.v));
    }
    out.push('');

    // Por ano+tipo
    out.push('## GASTOS POR ANO E TIPO');
    out.push('Ano|Tipo|Total R$');
    const tipos = [...new Set(Object.keys(agg).filter(k => k.startsWith('ano_tipo|')).map(k => k.split('|')[2]))].sort();
    for (const a of anos) for (const t of tipos) {
      const r = agg['ano_tipo|' + a + '|' + t];
      if (r && r.v > 0) out.push(a + '|' + t + '|' + Math.round(r.v));
    }
    out.push('');

    // Mensal (últimos 36 meses)
    const mesesRecentes = meses.slice(-36);
    out.push('## TOTAL MENSAL (ultimos 36 meses)');
    out.push('Mes|Total R$|Lancamentos');
    for (const m of mesesRecentes) {
      const r = agg['mes|' + m] || { v: 0, n: 0 };
      out.push(m + '|' + Math.round(r.v) + '|' + r.n);
    }
    out.push('');

    // Mensal por unidade+tipo (últimos 12 meses, top 600 linhas)
    const meses12 = new Set(meses.slice(-12));
    out.push('## DETALHE MENSAL POR UNIDADE E TIPO (ultimos 12 meses)');
    out.push('Mes|Unidade|Tipo|Total R$|Lancamentos');
    const detLines = Object.entries(agg)
      .filter(([k]) => k.startsWith('mes_unid_tipo|') && meses12.has(k.split('|')[1]))
      .map(([k, r]) => { const [, m, u, t] = k.split('|'); return { m, u, t, v: r.v, n: r.n }; })
      .sort((a, b) => b.v - a.v)
      .slice(0, 600);
    for (const r of detLines) {
      out.push(r.m + '|' + r.u + '|' + r.t + '|' + Math.round(r.v) + '|' + r.n);
    }

    const summary = out.join('\n');
    console.log('[dropbox-summary] ' + nLanc + ' lancamentos -> ' + summary.length + ' chars');
    res.type('text/plain; charset=utf-8').send(summary);
  } catch (e) {
    console.error('[dropbox-summary]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Fetch CSV raw (mantido para debug) ────────────────────────────────────
app.get('/api/dropbox-data', async (req, res) => {
  try {
    const text = await fetchDropboxCSV();
    res.type('text/plain; charset=utf-8').send(text);
  } catch (e) {
    console.error('[dropbox-data]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Proxy para OpenAI (formato compatível com o frontend Anthropic) ────────
// O frontend envia {model, max_tokens, messages} no formato Anthropic.
// O backend converte para OpenAI, chama a API e devolve no formato Anthropic.
app.post('/api/chat', async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'OPENAI_API_KEY nao configurada no servidor' });
    }

    const { max_tokens, messages } = req.body;

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: max_tokens || 1000,
        messages
      })
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return res.status(upstream.status).json(data);
    }

    const text = data.choices?.[0]?.message?.content ?? '';
    res.json({ content: [{ type: 'text', text }] });
  } catch (e) {
    console.error('[chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log('ICB server listening on :' + PORT));
