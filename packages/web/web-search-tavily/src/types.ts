/**
 * Wire types for the Tavily search API (`POST https://api.tavily.com/search`). Types
 * only — no runtime code. Tavily returns a flat `results[]`; each entry carries a
 * URL, optional title, a raw-content extract used as the portable snippet, and an
 * optional `published_date` present when the request sets `include_published_date`.
 *
 * @module @deepseek-ai/dsh-web-search-tavily/types
 */

/** Request body sent to Tavily's search endpoint. */
export interface TavilySearchRequest {
  query: string
  /** Tavily's result-count control; the seam still enforces the bound on return. */
  max_results?: number
  /** Ask Tavily to include each result's publication date when it is known. */
  include_published_date: boolean
  /** Always `false`: the harness model writes its own answer from the sources. */
  include_answer: boolean
}

/** One entry of Tavily's flat `results[]`. */
export interface TavilyResult {
  url: string
  title?: string | null
  /** Raw page extract; the provider maps a non-blank value to the snippet. */
  content?: string | null
  published_date?: string | null
}

/** Tavily's search response envelope. */
export interface TavilySearchResponse {
  query?: string
  answer?: string
  results?: TavilyResult[]
  response_time?: number
}

/** Tavily's error response envelope (FastAPI-style `detail`, string or object). */
export interface TavilyError {
  detail?: string | { error?: string }
}
