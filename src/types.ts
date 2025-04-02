import { KVNamespace } from '@cloudflare/workers-types'

interface Env {
  PRICE_CACHE: KVNamespace;
  ALCHEMY_API_KEY: string;
}

export { Env }; 