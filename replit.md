# ICB · Inteligência de Atendimentos

## Overview
A single-file HTML dashboard (Portuguese) for ICB service/attendance intelligence. Built with Chart.js, a dark theme, and what appears to be an AI chat interface ("Pergunte à sua base de dados").

## How to run
The project is served as a static site using Python's built-in HTTP server:

```
python3 -m http.server 5000
```

The main file is `dashboard-icb.html`. The `index.html` at the root redirects there automatically.

## Stack
- Pure HTML/CSS/JavaScript (no build step)
- Chart.js 4.4.1 (via CDN)
- Figtree font (via Google Fonts)
- No backend

## User preferences
