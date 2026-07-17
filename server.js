const express = require('express');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static('.'));

// Lazy-load the ESM connector SDK
async function getConnectors() {
  const { ReplitConnectors } = await import('@replit/connectors-sdk');
  return new ReplitConnectors();
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
    console.error('[dropbox-data]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Proxy para a API de IA (Anthropic) ───────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor' });
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    console.error('[chat]', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`ICB server listening on :${PORT}`));
