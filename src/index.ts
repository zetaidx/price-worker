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

// Helper function to process ratios
function processRatios(ratios: string[]): number[] {
  const numbers = ratios.map(Number)
  // Check if all numbers are integers
  const allIntegers = numbers.every(num => Number.isInteger(num))
  
  if (allIntegers) {
    // If all numbers are integers, treat them as percentages
    const total = numbers.reduce((sum, num) => sum + num, 0)
    return numbers.map(num => num / total)
  }
  
  // Otherwise, return the numbers as is (assuming they're already fractions)
  return numbers
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

  // Find the common time range across all price data
  const allTimestamps = priceDataList.map(data => 
    data.data.map(point => new Date(point.timestamp).getTime())
  )
  
  const minTimestamp = Math.max(...allTimestamps.map(timestamps => Math.min(...timestamps)))
  const maxTimestamp = Math.min(...allTimestamps.map(timestamps => Math.max(...timestamps)))
  
  // Create a map of timestamps to values for each symbol for efficient lookup
  const priceMaps = priceDataList.map(data => {
    const map = new Map<number, number>()
    data.data.forEach(point => {
      map.set(new Date(point.timestamp).getTime(), parseFloat(point.value))
    })
    return map
  })
  
  // Generate a list of timestamps at regular intervals within the common range
  const timeStep = getTimeStep(interval)
  const timestamps: number[] = []
  for (let t = minTimestamp; t <= maxTimestamp; t += timeStep) {
    timestamps.push(t)
  }
  
  // Calculate weighted average for each timestamp with interpolation
  const weightedData = timestamps.map(timestamp => {
    const totalRatio = ratioList.reduce((sum, ratio) => sum + ratio, 0)
    const weightedValue = priceMaps.reduce((sum, priceMap, symbolIndex) => {
      // Find the closest available price points for interpolation
      const availablePrices = Array.from(priceMap.entries())
        .filter(([t]) => t >= minTimestamp && t <= maxTimestamp)
        .sort((a, b) => a[0] - b[0])
      
      if (availablePrices.length === 0) {
        throw new Error(`No price data available for symbol ${symbolList[symbolIndex]}`)
      }
      
      // Find the closest price points for interpolation
      let lowerPoint = availablePrices[0]
      let upperPoint = availablePrices[availablePrices.length - 1]
      
      for (let i = 0; i < availablePrices.length - 1; i++) {
        if (availablePrices[i][0] <= timestamp && availablePrices[i + 1][0] >= timestamp) {
          lowerPoint = availablePrices[i]
          upperPoint = availablePrices[i + 1]
          break
        }
      }
      
      // Linear interpolation
      const timeDiff = upperPoint[0] - lowerPoint[0]
      const valueDiff = upperPoint[1] - lowerPoint[1]
      const ratio = timeDiff === 0 ? 0 : (timestamp - lowerPoint[0]) / timeDiff
      const interpolatedValue = lowerPoint[1] + valueDiff * ratio
      
      return sum + (interpolatedValue * ratioList[symbolIndex]) / totalRatio
    }, 0)

    return {
      value: weightedValue,
      timestamp: new Date(timestamp).toISOString()
    }
  })

  return weightedData
}

// Helper function to determine the appropriate time step based on interval
function getTimeStep(interval: Interval): number {
  switch (interval) {
    case '24h':
      return 5 * 60 * 1000 // 5 minutes
    case '7d':
      return 60 * 60 * 1000 // 1 hour
    case '30d':
      return 24 * 60 * 60 * 1000 // 1 day
    default:
      return 5 * 60 * 1000 // Default to 5 minutes
  }
}

// Helper function to add CORS headers
function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Content-Type')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

// Route to get price for a single symbol
router.get('/', async () => {
  return new Response(JSON.stringify({
    message: "See https://github.com/zetaidx/price-worker for docs"
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

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
  const ratioList = processRatios(ratios.split(','))

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
  const ratioList = processRatios(ratios.split(','))

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
    // Handle OPTIONS request for CORS preflight
    if (request.method === 'OPTIONS') {
      return addCorsHeaders(new Response(null, {
        headers: { 'Content-Type': 'application/json' }
      }))
    }

    const response = await router.handle(request, env, ctx)
    return addCorsHeaders(response)
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