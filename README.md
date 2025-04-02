# Price Worker

A Cloudflare Worker that caches and aggregates crypto prices from Alchemy's API.

## Features

- Caches individual token prices with a 4-minute TTL
- Supports multiple time intervals (24h, 7d, 30d)
- Aggregates prices for multiple tokens with custom ratios
- Calculates percentage gain/loss for aggregated prices
- Batch price fetching for multiple tokens
- Uses Cloudflare KV for caching
- CORS enabled for cross-origin requests

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

Response:
```json
{
  "symbol": "ETH",
  "interval": "24h",
  "timestamp": "2024-03-21T12:00:00.000Z",
  "data": [
    {
      "value": 3500.50,
      "timestamp": "2024-03-20T12:00:00.000Z"
    },
    // ... more data points
  ]
}
```

### Get Aggregated Price

```
GET /aggregate?symbols=ETH,BTC&ratios=0.6,0.4&interval=24h
```

Parameters:
- `symbols`: Comma-separated list of token symbols
- `ratios`: Comma-separated list of weights (must sum to 1)
- `interval`: Time interval (24h, 7d, 30d) - defaults to 24h

Response:
```json
{
  "data": [
    {
      "value": 3500.50,
      "timestamp": "2024-03-20T12:00:00.000Z"
    },
    // ... more data points
  ],
  "interval": "24h",
  "timestamp": "2024-03-21T12:00:00.000Z"
}
```

### Get Percentage Gain/Loss

```
GET /aggregate/pnl?symbols=ETH,BTC&ratios=0.6,0.4
```

Parameters:
- `symbols`: Comma-separated list of token symbols
- `ratios`: Comma-separated list of weights (must sum to 1)

Response:
```json
{
  "pnl": 5.2,
  "firstValue": 3500.50,
  "lastValue": 3682.53,
  "firstTimestamp": "2024-02-21T12:00:00.000Z",
  "lastTimestamp": "2024-03-21T12:00:00.000Z",
  "timestamp": "2024-03-21T12:00:00.000Z"
}
```

### Get Batch Prices

```
GET /batch?symbols=ETH,BTC,SOL&interval=24h
```

Parameters:
- `symbols`: Comma-separated list of token symbols
- `interval`: Time interval (24h, 7d, 30d) - defaults to 24h

Response:
```json
{
  "values": {
    "eth": 3500.50,
    "btc": 65000.00,
    "sol": 120.00
  },
  "timestamp": "2024-03-21T12:00:00.000Z"
}
```

## Example Usage

Get ETH price for the last 7 days:
```
GET /price/ETH?interval=7d
```

Get weighted average of ETH and BTC (60% ETH, 40% BTC) for the last 30 days:
```
GET /aggregate?symbols=ETH,BTC&ratios=0.6,0.4&interval=30d
```

Get percentage gain/loss for a portfolio of ETH, BTC, and SOL:
```
GET /aggregate/pnl?symbols=ETH,BTC,SOL&ratios=0.5,0.3,0.2
```

Get latest prices for multiple tokens:
```
GET /batch?symbols=ETH,BTC,SOL,BNB
```

## Error Handling

All endpoints return appropriate HTTP status codes and error messages in the following format:

```json
{
  "error": "Error message description",
  "timestamp": "2024-03-21T12:00:00.000Z"
}
```

Common status codes:
- 400: Bad Request (invalid parameters)
- 500: Internal Server Error 