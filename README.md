# Price Worker

A Cloudflare Worker that caches and aggregates crypto prices from Alchemy's API.

## Features

- Caches individual token prices with a 5-minute TTL
- Supports multiple time intervals (24h, 7d, 30d)
- Aggregates prices for multiple tokens with custom ratios
- Uses Cloudflare KV for caching

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure your environment:
- Add your Alchemy API key to `wrangler.toml`
- Create a KV namespace and add its ID to `wrangler.toml`

3. Deploy the worker:
```bash
npm run deploy
```

## API Endpoints

### Get Single Token Price

```
GET /price/:symbol?interval=24h
```

Parameters:
- `symbol`: Token symbol (e.g., ETH, BTC)
- `interval`: Time interval (24h, 7d, 30d) - defaults to 24h

### Get Aggregated Price

```
GET /aggregate?symbols=ETH,BTC&ratios=0.6,0.4&interval=24h
```

Parameters:
- `symbols`: Comma-separated list of token symbols
- `ratios`: Comma-separated list of weights (must sum to 1)
- `interval`: Time interval (24h, 7d, 30d) - defaults to 24h

## Example Usage

Get ETH price:
```
GET /price/ETH
```

Get weighted average of ETH and BTC (60% ETH, 40% BTC):
```
GET /aggregate?symbols=ETH,BTC&ratios=0.6,0.4
``` 