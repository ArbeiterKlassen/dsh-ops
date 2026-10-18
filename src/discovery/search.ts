import { DISCOVERY_TERMS } from '../capabilities/discovery.js'
import { publicToolName } from '../policy.js'
import type { DiscoverableName } from './config.js'

export interface DiscoveryRequest { query: string, maxResults: number }
export function parseRequest(raw: unknown): DiscoveryRequest | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Expected query and optional max_results.'
  const args = raw as Record<string, unknown>
  for (const key of Object.keys(args)) if (!['query', 'max_results'].includes(key)) return `Unknown discovery argument: ${key}`
  if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 512) return 'query must contain 1-512 characters.'
  const maxResults = args.max_results === undefined ? 3 : args.max_results
  if (typeof maxResults !== 'number' || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 5) return 'max_results must be an integer from 1 to 5.'
  return { query: args.query.trim().toLowerCase(), maxResults }
}
export function search(query: string, pool: readonly DiscoverableName[], maximum: number): DiscoverableName[] {
  if (query.startsWith('select:')) return pool.filter(name => query.slice(7).trim() === publicToolName(name)).slice(0, maximum)
  const terms = [...new Set(query.match(/[a-z0-9_]+/g) ?? [])]
  return pool.map((name, order) => {
    const words = `${name} ${DISCOVERY_TERMS[name]}`.split(/[\s_]+/)
    const score = terms.reduce((sum, term) => sum + (words.includes(term) ? 1 : 0), 0)
    return { name, order, score }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, maximum).map(item => item.name)
}
