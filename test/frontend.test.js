'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard-icb.html'), 'utf8');

test('frontend usa recorte integrado e não sobrescreve as bases incorporadas', () => {
  assert.match(html, /fetch\('\/api\/analise-integrada'/);
  assert.match(html, /function integratedMessages/);
  assert.doesNotMatch(html, /CHAT_FULL\s*=\s*csv/);
  assert.doesNotMatch(html, /CHAT_LITE\s*=\s*csv/);
  assert.doesNotMatch(html, /stratIdx/);
  assert.match(html, /conversationContext:contextoAnterior\|\|undefined/);
  assert.match(html, /conversationContext=c\.contexto/);
  assert.match(html, /analyticsContext:conversationContext/);
});

test('frontend limita histórico e saída para reduzir tokens', () => {
  assert.match(html, /slice\(0,-1\)\.slice\(-6\)/);
  assert.match(html, /max_tokens:700/);
  assert.match(html, /role:'system',content:PRIMER\.trim\(\)/);
});

test('relatório preserva o contexto factual registrado em cada resposta', () => {
  assert.match(html, /contextNote:m\.contextNote\|\|null/);
  assert.match(html, /if\(p\.contextNote\).*rfoot/);
});
