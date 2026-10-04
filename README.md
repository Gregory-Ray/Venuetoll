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

## Use it

Point an MCP client at the server:

```
https://venuetoll.com/mcp
```

## Pricing

$0.05 USDC per paid `get_toll`, settled on Base via x402. The index is free on purpose: what's
covered, what's measured, and how fresh it is, are the credibility signal — the number itself is
the product.

## The line it does not cross

This server ships `cost_*` fields only. Opportunity and verdict fields exist in the underlying
dataset and are deliberately never served. This is measurement, not financial advice.
