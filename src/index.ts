import { Router, Request } from 'itty-router'
import { Env } from './types'

const router = Router()
const ALLOWED_INTERVALS = ['24h', '7d', '30d'] as const
type Interval = typeof ALLOWED_INTERVALS[number]
const CACHE_TTL = 60 * 4 // 4 minutes cache TTL

interface AlchemyPriceData {
  symbol: string;
  currency: string;
  data: Array<{
    value: string;
    timestamp: string;
  }>;
}

interface PriceResponse {
  symbol: string;
  interval: Interval;
  timestamp: string;
  data: Array<{
    value: number;
    timestamp: string;
  }>;
}

interface BatchResponse {
  values: Record<string, number>;
  timestamp: string;
}

// Helper function to validate intervals
const isValidInterval = (interval: string): interval is Interval => 
  ALLOWED_INTERVALS.includes(interval as Interval)

// Helper function to generate cache key
const generateCacheKey = (symbol: string, interval: Interval): string => 
  `price:${symbol}:${interval}`

// Helper function to get time range and interval for Alchemy API
function getTimeRangeAndInterval(interval: Interval): { startTime: string; endTime: string; interval: string } {
  const now = new Date()
  const endTime = now.toISOString()
  let startTime: Date

  switch (interval) {
    case '24h':
      startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      return { startTime: startTime.toISOString(), endTime, interval: '5m' }
    case '7d':
      startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      return { startTime: startTime.toISOString(), endTime, interval: '1h' }
    case '30d':
      startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      return { startTime: startTime.toISOString(), endTime, interval: '1d' }
  }
}

// Helper function to get cached price
async function getCachedPrice(symbol: string, interval: Interval, env: Env): Promise<AlchemyPriceData | null> {
  if (!env.PRICE_CACHE) {
    throw new Error('Cache binding not configured. Please ensure PRICE_CACHE is set up in your Cloudflare Worker.')
  }
  const cacheKey = generateCacheKey(symbol, interval)
  const cached = await env.PRICE_CACHE.get(cacheKey, { type: 'json' })
  return cached as AlchemyPriceData | null
}

// Helper function to set cached price
async function setCachedPrice(symbol: string, interval: Interval, priceData: AlchemyPriceData, env: Env): Promise<void> {
  if (!env.PRICE_CACHE) {
    throw new Error('Cache binding not configured. Please ensure PRICE_CACHE is set up in your Cloudflare Worker.')
  }
  const cacheKey = generateCacheKey(symbol, interval)
  await env.PRICE_CACHE.put(cacheKey, JSON.stringify(priceData), { expirationTtl: CACHE_TTL })
}

// Helper function to fetch price from Alchemy
async function fetchPriceFromAlchemy(symbol: string, interval: Interval, env: Env): Promise<AlchemyPriceData> {
  if (!env.ALCHEMY_API_KEY) {
    throw new Error('Alchemy API key not configured. Please ensure ALCHEMY_API_KEY is set in your Cloudflare Worker environment variables.')
  }

  const { startTime, endTime, interval: apiInterval } = getTimeRangeAndInterval(interval)
  
  const response = await fetch(
    `https://api.g.alchemy.com/prices/v1/${env.ALCHEMY_API_KEY}/tokens/historical`,
    {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        symbol,
        startTime,
        endTime,
        interval: apiInterval,
      }),
    }
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to fetch price from Alchemy: ${response.status} ${response.statusText}. Details: ${errorText}`)
  }

  const data = await response.json() as AlchemyPriceData
  if (!data.data || data.data.length === 0) {
    throw new Error(`No price data available for symbol ${symbol} in the specified time range`)
  }

  return data
}

// Helper function to fetch and calculate weighted prices
async function getWeightedPrices(symbolList: string[], ratioList: number[], interval: Interval, env: Env) {
  // Fetch price data for all symbols, using cache when available
  const priceDataList = await Promise.all(
    symbolList.map(async (symbol) => {
      let priceData = await getCachedPrice(symbol, interval, env)
      if (!priceData) {
        priceData = await fetchPriceFromAlchemy(symbol, interval, env)
        await setCachedPrice(symbol, interval, priceData, env)
      }
      return priceData
    })
  )

  // Calculate weighted average for each timestamp
  const timestamps = priceDataList[0].data.map(point => point.timestamp)
  const weightedData = timestamps.map((timestamp, index) => {
    const totalRatio = ratioList.reduce((sum, ratio) => sum + ratio, 0)
    const weightedValue = priceDataList.reduce((sum, priceData, symbolIndex) => {
      const point = priceData.data[index]
      return sum + (parseFloat(point.value) * ratioList[symbolIndex]) / totalRatio
    }, 0)

    return {
      value: weightedValue,
      timestamp
    }
  })

  return weightedData
}

// Route to get price for a single symbol
router.get('/price/:symbol', async (request: Request, env: Env) => {
  const params = request.params as { symbol: string }
  const { symbol } = params
  const interval = (request.query?.interval as Interval) || '24h'

  if (!isValidInterval(interval)) {
    return new Response(JSON.stringify({
      error: 'Invalid interval',
      message: 'Allowed values are: 24h, 7d, 30d',
      received: interval
    }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  try {
    // Try to get from cache first
    let priceData = await getCachedPrice(symbol, interval, env)
    
    if (!priceData) {
      // If not in cache, fetch from Alchemy
      priceData = await fetchPriceFromAlchemy(symbol, interval, env)
      await setCachedPrice(symbol, interval, priceData, env)
    }
    
    const response: PriceResponse = {
      symbol,
      interval,
      timestamp: new Date().toISOString(),
      data: priceData.data.map(point => ({
        value: parseFloat(point.value),
        timestamp: point.timestamp
      }))
    }

    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Unknown error',
      symbol,
      interval,
      timestamp: new Date().toISOString()
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})

// Route to get aggregated price for multiple symbols
router.get('/aggregate', async (request: Request, env: Env) => {
  const query = request.query as { symbols?: string; ratios?: string; interval?: string }
  const { symbols, ratios } = query

  if (!symbols || !ratios) {
    return new Response('Missing required parameters: symbols and ratios', { status: 400 })
  }

  const symbolList = symbols.split(',')
  const ratioList = ratios.split(',').map(Number)

  if (symbolList.length !== ratioList.length) {
    return new Response('Number of symbols must match number of ratios', { status: 400 })
  }

  const interval = (query.interval as Interval) || '24h'

  if (!isValidInterval(interval)) {
    return new Response('Invalid interval. Allowed values: 24h, 7d, 30d', { status: 400 })
  }

  try {
    const weightedData = await getWeightedPrices(symbolList, ratioList, interval, env)

    return new Response(JSON.stringify({ 
      data: weightedData,
      interval,
      timestamp: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), { status: 500 })
  }
})

// Route to get percentage gain/loss for aggregated prices
router.get('/aggregate/pnl', async (request: Request, env: Env) => {
  const query = request.query as { symbols?: string; ratios?: string }
  const { symbols, ratios } = query

  if (!symbols || !ratios) {
    return new Response('Missing required parameters: symbols and ratios', { status: 400 })
  }

  const symbolList = symbols.split(',')
  const ratioList = ratios.split(',').map(Number)

  if (symbolList.length !== ratioList.length) {
    return new Response('Number of symbols must match number of ratios', { status: 400 })
  }

  try {
    const weightedData = await getWeightedPrices(symbolList, ratioList, '30d', env)

    // Calculate percentage gain/loss
    const firstValue = weightedData[0].value
    const lastValue = weightedData[weightedData.length - 1].value
    const pnl = ((lastValue - firstValue) / firstValue) * 100

    return new Response(JSON.stringify({ 
      pnl,
      firstValue,
      lastValue,
      firstTimestamp: weightedData[0].timestamp,
      lastTimestamp: weightedData[weightedData.length - 1].timestamp,
      timestamp: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})

// Route to get latest prices for multiple symbols
router.get('/batch', async (request: Request, env: Env) => {
  const query = request.query as { symbols?: string; interval?: string }
  const { symbols } = query

  if (!symbols) {
    return new Response('Missing required parameter: symbols', { status: 400 })
  }

  const symbolList = symbols.split(',')
  const interval = (query.interval as Interval) || '24h'

  if (!isValidInterval(interval)) {
    return new Response('Invalid interval. Allowed values: 24h, 7d, 30d', { status: 400 })
  }

  try {
    // Fetch price data for all symbols, using cache when available
    const priceDataList = await Promise.all(
      symbolList.map(async (symbol) => {
        let priceData = await getCachedPrice(symbol, interval, env)
        if (!priceData) {
          priceData = await fetchPriceFromAlchemy(symbol, interval, env)
          await setCachedPrice(symbol, interval, priceData, env)
        }
        return priceData
      })
    )

    // Get the latest timestamp from all series
    const latestTimestamp = Math.max(...priceDataList.map(data => 
      new Date(data.data[data.data.length - 1].timestamp).getTime()
    ))

    // Extract latest prices at the latest timestamp
    const values = priceDataList.reduce((acc, priceData, index) => {
      const latestPoint = priceData.data[priceData.data.length - 1]
      acc[symbolList[index].toLowerCase()] = parseFloat(latestPoint.value)
      return acc
    }, {} as Record<string, number>)

    const response: BatchResponse = {
      values,
      timestamp: new Date(latestTimestamp).toISOString()
    }

    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})

// Handle all requests
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return router.handle(request, env, ctx)
  },

  // Scheduled function to pre-cache prices
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const symbols = ['BTC', 'ETH', 'BNB', 'SOL']
    const interval: Interval = '30d'

    // Fetch and cache prices for each symbol
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const priceData = await fetchPriceFromAlchemy(symbol, interval, env)
          await setCachedPrice(symbol, interval, priceData, env)
        } catch (error) {
          console.error(`Failed to cache ${symbol} ${interval} price:`, error)
        }
      })
    )
  }
} 