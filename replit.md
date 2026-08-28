# ICB · Inteligência de Atendimentos

## Overview
Dashboard interno da ICB Transplante Capilar. Chat com IA que cruza atendimento, faturamento, DRE e gastos sem misturar as fontes nem enviar as bases completas ao modelo.

## Como rodar
```
npm start
```
Serve na porta 5000. A página principal é `/dashboard-icb.html`.

## Arquitetura
- **Frontend**: `dashboard-icb.html` — HTML/CSS/JS puro com Chart.js
- **Backend**: `server.js` — Express (Node.js), cache e consultas determinísticas:
  - `GET /api/analytics/status` — períodos e estado das fontes
  - `POST /api/analise-integrada` — recorte compacto entre atendimento, faturamento, DRE e gastos
  - `POST /api/gastos/query` e `POST /api/atendimentos/query` — consultas exclusivas por fonte
  - `GET /api/dropbox-summary` — contrato legado, agora compacto e com cache
  - `POST /api/chat` — proxy compatível para OpenAI GPT-4o
  - `GET /api/dropbox-data` — desabilitado por padrão

## Fontes de dados
- **Gastos históricos**: incorporados, usados somente até 31/12/2025.
- **Gastos atuais**: `/Claude/Gastos Dashboard.csv`, usados desde 01/01/2026 e atualizados via Dropbox.
- **Atendimento/faturamento**: `Controle de Atendimentos ICB` incorporado no HTML, atualmente até 2026-06.
- **DRE**: incorporada no HTML, atualmente até 2026-06.
- **Contingência**: se o Dropbox estiver indisponível sem cache válido, usa a fotografia incorporada de 2026 com aviso explícito. Ela nunca é somada ao CSV diário.

Os gastos realizados excluem datas futuras, zeros e estornos negativos, seguindo a definição histórica de gasto bruto. Os contadores dessas exclusões e a última data realizada ficam disponíveis no contexto analítico.

## Economia de tokens
- Cache do Dropbox por 15 minutos, com uma única atualização concorrente e último valor válido em caso de falha.
- Até 50 linhas mensais agregadas e top 10 para dimensões como categoria, tipo e profissional.
- Somente as últimas três interações do chat são reenviadas.
- Saída padrão limitada a 700 tokens, máximo de 1.200.
- Instruções fixas ficam antes dos dados variáveis para favorecer cache de prompt.

## Testes
```
npm test
```

## Secrets necessários
- `OPENAI_API_KEY` — chave da API OpenAI para o chat funcionar
- `OPENAI_MODEL` — opcional; padrão `gpt-4o`
- `DROPBOX_GASTOS_PATH` — opcional; padrão `/Claude/Gastos Dashboard.csv`
- `DROPBOX_CACHE_TTL_MS` — opcional; padrão 15 minutos
- `ENABLE_RAW_DATA_ENDPOINT=true` — habilita explicitamente o CSV bruto (não recomendado)
- `ALLOW_FORCE_REFRESH=true` — permite `?refresh=1`; desabilitado por padrão

## Integrações
- **Dropbox** (`conn_dropbox_01KCA2YZGSET4TDCRBV6FXPYTP`) — via `@replit/connectors-sdk`

## Stack
- Node.js 24 + Express 4
- `@replit/connectors-sdk` para Dropbox
- Chart.js 4.4.1 (CDN), Figtree font (Google Fonts)
- Sem banco de dados, sem build step

## Preferências do usuário
