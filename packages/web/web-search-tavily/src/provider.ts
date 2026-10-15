/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by the Tavily search API (`POST /search`
 * with raw-content extracts). It maps a non-blank `content` to `snippet`, maps
 * `published_date` to `publishedAt`, drops entries without a snippet, and omits `content`
 * because the request pins `include_answer: false` (the model writes its own answer).
 * @module @deepseek-ai/dsh-web-search-tavily/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { TavilyError, TavilyResult, TavilySearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Default Tavily search endpoint; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Tavily's hard maximum for `max_results` per request; larger values fail the API call. */
export const TAVILY_MAX_RESULTS_CAP = 20

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface TavilySearchProviderOptions {
  /** Tavily API key. Empty/absent makes the provider unavailable. */
  apiKey: string
  /** Endpoint base; `/search` is appended. */
  baseURL: string
}

/**
 * Map one Tavily result to a normalized source, or `undefined` when it carries no
 * portable snippet (an entry with blank or absent content is dropped — the seam has no
 * other field to derive a snippet from, and inventing one would lie).
 *
 * @param result - one entry of Tavily's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no
 *   non-blank `content`.
 */
export function mapTavilyResult(result: TavilyResult): WebSearchSource | undefined {
  const snippet = typeof result.content === 'string' ? result.content.trim() : ''
  if (snippet.length === 0) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    snippet,
    ...result.published_date != null && result.published_date.length > 0 ? { publishedAt: result.published_date } : {},
  }
}

/**
 * Map a Tavily response envelope to a normalized search result.
 *
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result; snippet-less entries are dropped
 *   ({@link mapTavilyResult}).
 */
export function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapTavilyResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // The request pins `include_answer: false`, so Tavily returns no generated answer and
  // `content` is omitted. The web service owns the final `maxResults` truncation, so this
  // provider reports `truncated: false`.
  return { sources, truncated: false }
}

/** The Tavily-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  constructor(private readonly options: TavilySearchProviderOptions) {}

  available(): boolean {
    return this.options.apiKey.length > 0
      && isValidBaseUrl(this.options.baseURL)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/search`, {
        method: 'POST',
        // A redirect must fail before its Location target is contacted: the
        // request carries the API key (the credentialed-provider policy).
        redirect: 'error',
        headers: credentialedJsonHeaders(this.options.apiKey, USER_AGENT),
        body: JSON.stringify({
          query: request.query,
          // Tavily rejects `max_results` above its cap; the per-request bound is
          // clamped so a large consumer limit costs one API-shaped value, not an error.
          ...request.maxResults !== undefined ? { max_results: Math.min(request.maxResults, TAVILY_MAX_RESULTS_CAP) } : {},
          include_published_date: true,
          include_answer: false,
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Tavily API error (HTTP ${status})`
      try {
        const parsed = await response.json() as TavilyError
        const detail = parsed.detail
        const text = typeof detail === 'string' ? detail : detail?.error
        if (text !== undefined && text.length > 0) message = text
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as TavilySearchResponse
      return mapTavilyResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** Headers for one credentialed JSON API request: bearer auth plus JSON negotiation. */
function credentialedJsonHeaders(apiKey: string, userAgent: string): Record<string, string> {
  return {
    'authorization': `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'accept': 'application/json',
    'user-agent': userAgent,
  }
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
