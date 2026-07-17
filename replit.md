# ICB · Inteligência de Atendimentos

## Overview
Dashboard interno da ICB Transplante Capilar. Chat com IA que responde perguntas sobre dados de atendimento, gastos, DRE e cirurgias, com dados buscados ao vivo do Dropbox.

## Como rodar
```
node server.js
```
Serve na porta 5000. A página principal é `/dashboard-icb.html`.

## Arquitetura
- **Frontend**: `dashboard-icb.html` — HTML/CSS/JS puro com Chart.js
- **Backend**: `server.js` — Express (Node.js) com dois endpoints:
  - `GET /api/dropbox-data` — baixa `/claude/gastos dashboard.csv` do Dropbox via conector Replit
  - `POST /api/chat` — proxeia chamadas para OpenAI GPT-4o usando `OPENAI_API_KEY`

## Fontes de dados
- **Dropbox**: `/claude/gastos dashboard.csv` — despesas brutas lançamento a lançamento
- **Embutido no HTML**: dados de atendimento, DRE e cirurgias por unidade (fallback se Dropbox falhar)

## Secrets necessários
- `OPENAI_API_KEY` — chave da API OpenAI para o chat funcionar

## Integrações
- **Dropbox** (`conn_dropbox_01KCA2YZGSET4TDCRBV6FXPYTP`) — via `@replit/connectors-sdk`

## Stack
- Node.js 24 + Express 4
- `@replit/connectors-sdk` para Dropbox
- Chart.js 4.4.1 (CDN), Figtree font (Google Fonts)
- Sem banco de dados, sem build step

## Preferências do usuário
