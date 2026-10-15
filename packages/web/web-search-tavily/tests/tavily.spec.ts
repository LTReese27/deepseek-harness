import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { TavilySearchProvider, TAVILY_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-tavily'
import * as tavilyPlugin from '@deepseek-ai/dsh-web-search-tavily'
import { mapTavilyResponse, mapTavilyResult } from '../src/provider.ts'

const options = { apiKey: 'tavily-key', baseURL: 'https://api.tavily.test' }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** The typed fetch stub whose recorded calls tests destructure. */
type FetchStub = Mock<(url: string | URL, init?: RequestInit) => Promise<Response>>

function stubFetch(payload: () => Response): FetchStub {
  return vi.fn(async (_url: string | URL, _init?: RequestInit) => payload())
}

/** The request init of the first recorded fetch call. */
function firstCall(fetchMock: FetchStub): { url: string | URL; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0]!
  return { url, init: init! }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Tavily result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapTavilyResult({
      url: 'https://a.test',
      title: 'A',
      published_date: 'Tue, 11 Mar 2025 17:00:00 GMT',
      content: '  raw extract  ',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'raw extract', publishedAt: 'Tue, 11 Mar 2025 17:00:00 GMT' })
  })

  it('drops a result with no usable content', () => {
    expect(mapTavilyResult({ url: 'https://a.test', content: '' })).toBeUndefined()
    expect(mapTavilyResult({ url: 'https://a.test' })).toBeUndefined()
    expect(mapTavilyResult({ url: 'https://a.test', content: null })).toBeUndefined()
    expect(mapTavilyResult({ url: 'https://a.test', content: '   ' })).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapTavilyResult({ url: 'https://a.test', title: null, published_date: null, content: 'hi' }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
    expect(mapTavilyResult({ url: 'https://a.test', title: '', published_date: '', content: 'hi' }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
  })

  it('maps a response to a result with no content and filtered sources', () => {
    const result = mapTavilyResponse({
      results: [
        { url: 'https://a.test', content: 'one' },
        { url: 'https://b.test', content: '' },
        { url: 'https://c.test', title: 'C', content: 'three' },
      ],
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://c.test', title: 'C', snippet: 'three' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('tolerates a missing results array', () => {
    expect(mapTavilyResponse({}).sources).toEqual([])
  })

})

describe('TavilySearchProvider availability', () => {
  it('is unavailable without a key', () => {
    expect(new TavilySearchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key', () => {
    expect(new TavilySearchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new TavilySearchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })
})

describe('TavilySearchProvider request mapping', () => {
  it('sends query, include flags, max_results and bearer auth', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [{ url: 'https://a.test', content: 'hi' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new TavilySearchProvider(options)
    await provider.search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const { url, init } = firstCall(fetchMock)
    expect(url).toBe('https://api.tavily.test/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tavily-key')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'hello',
      max_results: 5,
      include_published_date: true,
      include_answer: false,
    })
  })

  it('clamps max_results to the Tavily cap when a request asks for more', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new TavilySearchProvider(options).search({ query: 'q', maxResults: 50 })
    const { init } = firstCall(fetchMock)
    expect(JSON.parse(init.body as string)).toMatchObject({ max_results: 20 })
  })

  it('omits max_results when a request carries no maxResults', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new TavilySearchProvider(options).search({ query: 'q' })
    const { init } = firstCall(fetchMock)
    expect(JSON.parse(init.body as string)).not.toHaveProperty('max_results')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new TavilySearchProvider(options).search({ query: 'q' }, controller.signal)
    const { init } = firstCall(fetchMock)
    expect(init.signal).toBe(controller.signal)
  })
})

describe('TavilySearchProvider redirects', () => {
  it('rejects a redirect without contacting the Location target', async () => {
    const targetSeen: string[] = []
    const target = createServer(() => { targetSeen.push('REQ') })
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', () => { resolve() }))
    const targetPort = (target.address() as AddressInfo).port
    const origin = createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${String(targetPort)}/hook` })
      response.end()
    })
    await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', () => { resolve() }))
    const originPort = (origin.address() as AddressInfo).port
    try {
      const provider = new TavilySearchProvider({ apiKey: 'tavily-key', baseURL: `http://127.0.0.1:${String(originPort)}` })
      await expect(provider.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
      expect(targetSeen).toEqual([])
    } finally {
      await new Promise<void>(resolve => origin.close(() => { resolve() }))
      await new Promise<void>(resolve => target.close(() => { resolve() }))
    }
  }, 10_000)
})

describe('TavilySearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider detail string', async () => {
    vi.stubGlobal('fetch', stubFetch(() => jsonResponse({ detail: 'bad key' }, { status: 401 })))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad key' }))
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider detail object', async () => {
    vi.stubGlobal('fetch', stubFetch(() => jsonResponse({ detail: { error: 'Unauthorized: missing or invalid API key.' } }, { status: 401 })))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Unauthorized: missing or invalid API key.' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', stubFetch(() => new Response('gateway down', { status: 502 })))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', stubFetch(() => jsonResponse({}, { status: 500 })))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Tavily API error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', stubFetch(() => new Response('not json', { status: 200 })))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', stubFetch(() => jsonResponse({ results: {} }, { status: 200 })))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body: Pick<Response, 'ok' | 'status' | 'json'> = {
      json: () => Promise.reject(new DOMException('aborted', 'AbortError')),
      ok: true,
      status: 200,
    }
    vi.stubGlobal('fetch', stubFetch(() => body as Response))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body: Pick<Response, 'ok' | 'status' | 'json'> = {
      json: () => Promise.reject(new DOMException('aborted', 'AbortError')),
      ok: false,
      status: 500,
    }
    vi.stubGlobal('fetch', stubFetch(() => body as Response))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-tavily plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', stubFetch(() => jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, { apiKey: 'tavily-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in tavilyPlugin).toBe(false)
  })

  it('falls back to $TAVILY_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = 'env-key'
    try {
      const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      const fiber = await ctx.plugin(tavilyPlugin, {})
      await ctx.web.search({ query: 'q' })
      const { url } = firstCall(fetchMock)
      expect(url).toBe('https://api.tavily.com/search')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = prev
    }
  })

  it('prefers row config over the environment key', async () => {
    const prev = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = 'env-key'
    try {
      const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      const fiber = await ctx.plugin(tavilyPlugin, { apiKey: 'row-key' })
      await ctx.web.search({ query: 'q' })
      const { init } = firstCall(fetchMock)
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer row-key')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = prev
    }
  })

  it('is unavailable when neither config nor env supplies a key', async () => {
    const prev = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(tavilyPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
    } finally {
      if (prev !== undefined) process.env.TAVILY_API_KEY = prev
    }
  })
})
