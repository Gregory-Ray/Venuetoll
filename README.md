# Venue Toll Facts

Measured trading-venue tolls, served over the Model Context Protocol. `list_venues` is free;
`get_toll` is paid ($0.05 USDC on Base). Measurements only — no opportunity, no verdict, no advice.

## What it measures

For each venue the toll is the *cost of executing*, not one fee number:

- **fee** — the measured toll percentage (chain activity vs book, same-shares rows)
- **spread** — the measured entry/exit spread
- **slippage** — the gap between the intended limit and the price the fill actually crossed
- **freshness** — per-venue `measured_at`, so a caller knows how current the number is

Every figure carries an explicit basis (`measured` / `published` / `unmeasurable`) and its evidence.

## Endpoints

- `GET /venues` — the venues covered, which are measured, and how fresh each is (free)
- `GET /toll?venue=<slug>` — the measured cost bundle for one venue (paid, 402 challenge when unpaid)

MCP tools: `list_venues` (free) and `get_toll` (paid). The paid tool returns the same 402
challenge as the HTTP route when unpaid — no bypass.

## Run it locally

This repository IS the server. `server.js` is the full implementation: a zero-dependency Node.js
server (no `npm install` — Node's own `http` module serves the whole surface, both the HTTP
routes and the MCP transport).

```bash
node server.js            # listens on http://127.0.0.1:8791
```

Or with Docker:

```bash
docker build -t venuetoll .
docker run -p 8791:8791 venuetoll
```

The server reads its venue data from `market_map.json` in its own directory (a sample ships in
the repo; the live service points the same code at its own measured data via `MARKET_MAP`).

## MCP transport

The server speaks MCP over HTTP at `/mcp` (POST JSON-RPC 2.0 — `initialize`, `tools/list`,
`tools/call`, `ping`). Point an MCP client at `http://127.0.0.1:8791/mcp` locally. A hosted copy
of this same server is also available at `https://venuetoll.com/mcp`.

## Pricing

$0.05 USDC per paid `get_toll`, settled on Base via x402. The index is free on purpose: what's
covered, what's measured, and how fresh it is, are the credibility signal — the number itself is
the product.

## The line it does not cross

This server ships `cost_*` fields only. Opportunity and verdict fields exist in the underlying
dataset and are deliberately never served. This is measurement, not financial advice.
