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

// ── Fetch CSV from Dropbox ─────────────────────────────────────────────────
app.get('/api/dropbox-data', async (req, res) => {
  try {
    const connectors = await getConnectors();
    const response = await connectors.proxy('dropbox', '/2/files/download', {
      method: 'POST',
      headers: {
        'Dropbox-API-Arg': JSON.stringify({ path: '/claude/gastosdashboard.csv' })
      }
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return res.status(502).json({ error: 'Dropbox retornou erro', status: response.status, detail });
    }

    const text = await response.text();
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
      return res.status(500).json({ error: 'OPENAI_API_KEY não configurada no servidor' });
    }

    const { max_tokens, messages } = req.body;

    // Chamar OpenAI Chat Completions
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: max_tokens || 1000,
        messages  // formato {role, content} é compatível entre os dois
      })
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return res.status(upstream.status).json(data);
    }

    // Converter resposta OpenAI → formato Anthropic (que o frontend já sabe parsear)
    const text = data.choices?.[0]?.message?.content ?? '';
    res.json({
      content: [{ type: 'text', text }]
    });
  } catch (e) {
    console.error('[chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`ICB server listening on :${PORT}`));
