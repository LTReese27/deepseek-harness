/**
 * Behavior of the `browser` Remote namespace against a fake PinchTab HTTP
 * server: auth, lifecycle, tab and navigation control, screenshots, and the
 * failure classification the Web GUI discriminates on. The injected
 * fetchFn/spawnFn keep every spec off the network and off processes.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { BrowserController, type BrowserControllerInternals, type Config } from '../src/index.ts'

const BASE = 'http://127.0.0.1:9867'
const TOKEN = 'test-token'

/** One request the service issued to the fake server. */
interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

interface RecordedSpawn {
  readonly command: string
  readonly args: readonly string[]
}

/** PinchTab tab payloads as the live v0.15.2 server returns them. */
const TAB_A = { id: 'TAB-A', title: 'Example', url: 'https://example.com/', status: 'active', type: 'page', browserContextId: 'ctx-a' }
const TAB_B = { id: 'TAB-B', title: 'Other', url: 'https://other.test/', status: 'background', type: 'page' }

const VIEW_A = { id: 'TAB-A', title: 'Example', url: 'https://example.com/', active: true }
const VIEW_B = { id: 'TAB-B', title: 'Other', url: 'https://other.test/', active: false }

const signal = (): AbortSignal => new AbortController().signal

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * A minimal JPEG declaring its own dimensions through the SOF0 segment:
 * SOI, one APP0 segment, SOF0 (precision 8, three components), EOI.
 */
function jpegBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0xFF, 0xD8,
    0xFF, 0xE0, 0x00, 0x04, 0xAA, 0xBB,
    0xFF, 0xC0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xFF, height & 0xFF,
    (width >> 8) & 0xFF, width & 0xFF,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xFF, 0xD9,
  ])
}

function jpegResponse(width: number, height: number): Response {
  return new Response(jpegBytes(width, height), { status: 200, headers: { 'content-type': 'image/jpeg' } })
}

type Route = (call: RecordedCall) => Response | Error | Promise<Response | Error>

/** Answer exact `METHOD url` requests; anything unlisted is a defect in the spec. */
function router(routes: Record<string, Route>): (call: RecordedCall) => Promise<Response> {
  return async (call) => {
    const route = routes[`${call.method} ${call.url}`]
    if (route === undefined) throw new Error(`unexpected PinchTab call: ${call.method} ${call.url}`)
    const outcome = await route(call)
    if (outcome instanceof Error) throw outcome
    return outcome
  }
}

interface HostOptions {
  readonly routes: Record<string, Route>
  readonly config?: Partial<Config>
  /** Token source: a configured value by default, `false` for the token-file path. */
  readonly token?: string | false
  readonly spawn?: (command: string, args: readonly string[]) => Promise<void> | void
  readonly readFile?: (path: string) => Promise<string>
  readonly sleep?: (ms: number) => void
  readonly now?: () => number
}

function host(options: HostOptions) {
  const calls: RecordedCall[] = []
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers, body }
    calls.push(call)
    return router(options.routes)(call)
  }
  const spawns: RecordedSpawn[] = []
  const sleeps: number[] = []
  const spawn = options.spawn
  const sleep = options.sleep
  const internals: BrowserControllerInternals = {
    fetchFn,
    sleepFn: (ms, _signal) => {
      sleeps.push(ms)
      sleep?.(ms)
      return Promise.resolve()
    },
    ...spawn === undefined ? {} : {
      spawnFn: async (command: string, args: readonly string[], _signal: AbortSignal) => {
        spawns.push({ command, args: [...args] })
        await spawn(command, args)
      },
    },
    ...options.readFile === undefined ? {} : { readFileFn: options.readFile },
    ...options.now === undefined ? {} : { nowFn: options.now },
  }
  const token = options.token === false ? undefined : options.token ?? TOKEN
  const config: Config = {
    baseUrl: BASE,
    deviceScaleFactor: 2,
    screenshotQuality: 70,
    startTimeoutMs: 1000,
    command: 'pinchtab',
    ...token === undefined ? {} : { token },
    ...options.config,
  }
  const controller = new BrowserController(new Context(), config, internals)
  return { controller, calls, spawns, sleeps }
}

describe('the browser Remote namespace the Web GUI drives', () => {
  it('publishes the browser namespace from its own service key', () => {
    const { controller } = host({ routes: {} })
    expect(controller.typertRemote.serviceKey).toBe('browserController')
    expect(controller.typertRemote.namespace).toBe('browser')
    expect(remoteMethods(controller)).toEqual([
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'start', invocation: { kind: 'direct' } },
      { method: 'stop', invocation: { kind: 'direct' } },
      { method: 'screenshot', invocation: { kind: 'direct' } },
      { method: 'openTab', invocation: { kind: 'direct' } },
      { method: 'navigate', invocation: { kind: 'direct' } },
      { method: 'click', invocation: { kind: 'direct' } },
      { method: 'wheel', invocation: { kind: 'direct' } },
      { method: 'key', invocation: { kind: 'direct' } },
      { method: 'typeText', invocation: { kind: 'direct' } },
    ])
  })

  it('reports a running server with its tabs, sending the bearer token on every call', async () => {
    const { controller, calls } = host({
      routes: {
        [`GET ${BASE}/health`]: () => jsonResponse({ status: 'ok' }),
        [`GET ${BASE}/tabs`]: () => jsonResponse({ tabs: [TAB_A, TAB_B] }),
      },
    })
    const status = await controller.status(signal())
    expect(status).toEqual({ running: true, tabs: [VIEW_A, VIEW_B] })
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([`GET ${BASE}/health`, `GET ${BASE}/tabs`])
    for (const call of calls) expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('reports a down server without throwing', async () => {
    const { controller } = host({
      routes: { [`GET ${BASE}/health`]: () => new TypeError('fetch failed') },
    })
    await expect(controller.status(signal())).resolves.toEqual({ running: false, tabs: [] })
  })

  it('reports a never-run server as down and refuses other calls as unavailable when no token exists', async () => {
    const reads: string[] = []
    const { controller, calls } = host({
      token: false,
      readFile: (path) => {
        reads.push(path)
        return Promise.reject(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }))
      },
      routes: {},
    })
    await expect(controller.status(signal())).resolves.toEqual({ running: false, tabs: [] })
    expect(calls).toEqual([])
    expect(reads).toEqual([join(homedir(), '.pinchtab', 'config.json')])

    const failure = await controller.screenshot(undefined, signal()).catch((error: unknown) => error)
    const remote = remoteErrorOf(failure)
    expect(remote).toMatchObject({ code: 'browser/unavailable', details: { baseUrl: BASE } })
    expect(remote?.message).toContain('never run')
    expect(remote?.message).not.toContain(TOKEN)
  })

  it('re-reads the token file per call when no token is configured', async () => {
    let current = 'first-token'
    const { controller, calls } = host({
      token: false,
      config: { tokenFile: '/fake/pinchtab.json' },
      readFile: (path) => {
        expect(path).toBe('/fake/pinchtab.json')
        return Promise.resolve(JSON.stringify({ server: { token: current } }))
      },
      routes: {
        [`GET ${BASE}/health`]: () => jsonResponse({}),
        [`GET ${BASE}/tabs`]: () => jsonResponse({ tabs: [] }),
      },
    })
    await expect(controller.status(signal())).resolves.toEqual({ running: true, tabs: [] })
    current = 'second-token'
    await expect(controller.status(signal())).resolves.toEqual({ running: true, tabs: [] })
    expect(calls.map(call => call.headers.authorization)).toEqual([
      'Bearer first-token', 'Bearer first-token',
      'Bearer second-token', 'Bearer second-token',
    ])
  })

  it('accepts a top-level token in the config file and treats a malformed file as never-run', async () => {
    const fallback = host({
      token: false,
      readFile: () => Promise.resolve(JSON.stringify({ token: 'top-level-token' })),
      routes: {
        [`GET ${BASE}/health`]: () => jsonResponse({}),
        [`GET ${BASE}/tabs`]: () => jsonResponse({ tabs: [] }),
      },
    })
    await expect(fallback.controller.status(signal())).resolves.toEqual({ running: true, tabs: [] })
    expect(fallback.calls[0]!.headers.authorization).toBe('Bearer top-level-token')

    const malformed = host({
      token: false,
      readFile: () => Promise.resolve('not json'),
      routes: {},
    })
    await expect(malformed.controller.status(signal())).resolves.toEqual({ running: false, tabs: [] })
    expect(malformed.calls).toEqual([])
  })

  it('fails status with browser/unavailable when the server rejects the token', async () => {
    const { controller } = host({
      routes: { [`GET ${BASE}/health`]: () => jsonResponse({ code: 'missing_token', error: 'unauthorized' }, 401) },
    })
    const failure = await controller.status(signal()).catch((error: unknown) => error)
    const remote = remoteErrorOf(failure)
    expect(remote).toMatchObject({ code: 'browser/unavailable', details: { baseUrl: BASE } })
    expect(remote?.message).toContain('rejected the bearer token')
    expect(remote?.message).not.toContain(TOKEN)
  })

  it('captures the active tab scaled to CSS pixels', async () => {
    const { controller, calls } = host({
      now: () => 1720000000000,
      routes: {
        [`GET ${BASE}/tabs`]: () => jsonResponse({ tabs: [TAB_B, TAB_A] }),
        [`GET ${BASE}/tabs/TAB-A/screenshot?raw=true&quality=70&scale=0.5`]: () => jpegResponse(800, 450),
      },
    })
    const frame = await controller.screenshot(undefined, signal())
    expect(frame).toEqual({
      data: Buffer.from(jpegBytes(800, 450)).toString('base64'),
      width: 800,
      height: 450,
      takenAt: 1720000000000,
    })
    expect(calls.map(call => call.url)).toEqual([
      `${BASE}/tabs`,
      `${BASE}/tabs/TAB-A/screenshot?raw=true&quality=70&scale=0.5`,
    ])
  })

  it('requests the configured quality and inverse scale for a named tab without listing tabs', async () => {
    const { controller, calls } = host({
      config: { deviceScaleFactor: 4, screenshotQuality: 30 },
      routes: { [`GET ${BASE}/tabs/TAB-X/screenshot?raw=true&quality=30&scale=0.25`]: () => jpegResponse(320, 200) },
    })
    const frame = await controller.screenshot('TAB-X', signal())
    expect(frame).toMatchObject({ width: 320, height: 200 })
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      `GET ${BASE}/tabs/TAB-X/screenshot?raw=true&quality=30&scale=0.25`,
    ])
  })

  it('falls back to the only tab and refuses an empty or ambiguous roster as browser/not-found', async () => {
    const only = host({
      routes: {
        [`GET ${BASE}/tabs`]: () => jsonResponse({ tabs: [TAB_B] }),
        [`GET ${BASE}/tabs/TAB-B/screenshot?raw=true&quality=70&scale=0.5`]: () => jpegResponse(100, 50),
      },
    })
    await expect(only.controller.screenshot(undefined, signal())).resolves.toMatchObject({ width: 100 })

    const empty = host({ routes: { [`GET ${BASE}/tabs`]: () => jsonResponse({ tabs: [] }) } })
    const emptyFailure = await empty.controller.screenshot(undefined, signal()).catch((error: unknown) => error)
    expect(remoteErrorOf(emptyFailure)).toMatchObject({ code: 'browser/not-found', details: {} })

    const ambiguous = host({ routes: { [`GET ${BASE}/tabs`]: () => jsonResponse({ tabs: [TAB_B, { ...TAB_A, status: 'background' }] }) } })
    const ambiguousFailure = await ambiguous.controller.screenshot(undefined, signal()).catch((error: unknown) => error)
    const remote = remoteErrorOf(ambiguousFailure)
    expect(remote).toMatchObject({ code: 'browser/not-found' })
    expect(remote?.message).toContain('no active tab')
  })

  it('classifies a screenshot of a missing tab as browser/not-found carrying the upstream message', async () => {
    const { controller } = host({
      routes: { [`GET ${BASE}/tabs/TAB-X/screenshot?raw=true&quality=70&scale=0.5`]: () => jsonResponse({ code: 'error', error: 'tab TAB-X not found' }, 404) },
    })
    const failure = await controller.screenshot('TAB-X', signal()).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'browser/not-found',
      message: 'tab TAB-X not found',
      details: { tabId: 'TAB-X' },
    })
  })

  it('creates a tab and answers its listed view', async () => {
    const created = { id: 'TAB-C', title: 'New', url: 'https://new.test/', status: 'active', type: 'page' }
    const { controller, calls } = host({
      routes: {
        [`POST ${BASE}/tab`]: () => jsonResponse({ tabId: 'TAB-C', title: 'New', url: 'https://new.test/' }),
        [`GET ${BASE}/tabs`]: () => jsonResponse({ tabs: [TAB_A, created] }),
      },
    })
    const tab = await controller.openTab('https://new.test/', signal())
    expect(tab).toEqual({ id: 'TAB-C', title: 'New', url: 'https://new.test/', active: true })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${BASE}/tab`,
      body: { action: 'new', url: 'https://new.test/' },
    })
    expect(calls[0]!.headers['content-type']).toBe('application/json')
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('navigates and answers the landed URL', async () => {
    const { controller, calls } = host({
      routes: {
        [`POST ${BASE}/tabs/TAB-A/navigate`]: () => jsonResponse({ tabId: 'TAB-A', title: 'Example', url: 'https://example.com/landed' }),
      },
    })
    await expect(controller.navigate('TAB-A', 'https://example.com/landed', signal()))
      .resolves.toEqual({ url: 'https://example.com/landed' })
    expect(calls[0]!.body).toEqual({ url: 'https://example.com/landed' })
  })

  it('surfaces the PinchTab remedy when the IDPI allowlist refuses a navigation', async () => {
    const remedy = 'pinchtab config set security.allowedDomains "$(pinchtab config get security.allowedDomains),evil.test" && pinchtab server restart'
    const { controller } = host({
      routes: {
        [`POST ${BASE}/tabs/TAB-A/navigate`]: () => jsonResponse({
          code: 'idpi_domain_blocked',
          error: 'navigation blocked by IDPI: Domain not in allowlist: evil.test',
          details: { domain: 'evil.test', remedy, url: 'https://evil.test/' },
        }, 403),
      },
    })
    const failure = await controller.navigate('TAB-A', 'https://evil.test/', signal()).catch((error: unknown) => error)
    const remote = remoteErrorOf(failure)
    expect(remote?.code).toBe('browser/idpi_domain_blocked')
    expect(remote?.message).toContain('Domain not in allowlist: evil.test')
    expect(remote?.message).toContain(`Remedy: ${remedy}`)
  })

  it('answers the landed URL when a click navigates', async () => {
    const { controller, calls } = host({
      routes: {
        [`POST ${BASE}/tabs/TAB-A/action`]: () => jsonResponse({
          code: 'navigation_changed',
          error: 'the click navigated the tab',
          details: { url: 'https://example.com/next' },
        }, 409),
      },
    })
    await expect(controller.click('TAB-A', 10, 20, signal())).resolves.toEqual({ url: 'https://example.com/next' })
    expect(calls[0]).toMatchObject({ method: 'POST', body: { kind: 'click', x: 10, y: 20 } })
  })

  it('answers nothing for a plain click and fails other refusals as browser/<code>', async () => {
    const plain = host({ routes: { [`POST ${BASE}/tabs/TAB-A/action`]: () => jsonResponse({ success: true }) } })
    await expect(plain.controller.click('TAB-A', 10, 20, signal())).resolves.toEqual({})

    const refused = host({
      routes: {
        [`POST ${BASE}/tabs/TAB-A/action`]: () => jsonResponse({
          code: 'invalid_action_request',
          error: 'action click: invalid action request: need selector, ref, nodeId, or x/y coordinates',
        }, 400),
      },
    })
    const failure = await refused.controller.click('TAB-A', 10, 20, signal()).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'browser/invalid_action_request',
      message: 'action click: invalid action request: need selector, ref, nodeId, or x/y coordinates',
    })
  })

  it('posts wheel, key, and text action bodies', async () => {
    const { controller, calls } = host({
      routes: { [`POST ${BASE}/tabs/TAB-A/action`]: () => jsonResponse({ success: true }) },
    })
    await controller.wheel('TAB-A', 1, 2, 30, -40, signal())
    await controller.key('TAB-A', 'Enter', signal())
    await controller.typeText('TAB-A', 'hello', signal())
    expect(calls.map(call => call.body)).toEqual([
      { kind: 'mouse-wheel', x: 1, y: 2, deltaX: 30, deltaY: -40 },
      { kind: 'press', key: 'Enter' },
      { kind: 'type', text: 'hello' },
    ])
    for (const call of calls) expect(call.method).toBe('POST')
  })

  it('starts the server and polls health until it answers', async () => {
    let healthy = false
    const { controller, spawns, sleeps } = host({
      routes: {
        [`GET ${BASE}/health`]: () => healthy ? jsonResponse({}) : new TypeError('fetch failed'),
        [`GET ${BASE}/tabs`]: () => jsonResponse({ tabs: [TAB_A] }),
      },
      spawn: (command, args) => {
        expect([command, ...args]).toEqual(['pinchtab', 'server', '-b'])
      },
      sleep: () => {
        healthy = true
      },
    })
    const status = await controller.start(signal())
    expect(status).toEqual({ running: true, tabs: [VIEW_A] })
    expect(spawns).toEqual([{ command: 'pinchtab', args: ['server', '-b'] }])
    expect(sleeps).toEqual([250])
  })

  it('is idempotent when the server is already running', async () => {
    const { controller, spawns, calls } = host({
      routes: {
        [`GET ${BASE}/health`]: () => jsonResponse({}),
        [`GET ${BASE}/tabs`]: () => jsonResponse({ tabs: [] }),
      },
      spawn: () => {
        throw new Error('spawn must not run when the server is already up')
      },
    })
    await expect(controller.start(signal())).resolves.toEqual({ running: true, tabs: [] })
    expect(spawns).toEqual([])
    expect(calls.every(call => call.headers.authorization === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('fails start with browser/unavailable when the server never becomes healthy', async () => {
    let now = 0
    const { controller, spawns, sleeps } = host({
      routes: { [`GET ${BASE}/health`]: () => new TypeError('fetch failed') },
      spawn: () => {},
      now: () => now,
      sleep: (ms) => {
        now += ms
      },
      config: { startTimeoutMs: 1000 },
    })
    const failure = await controller.start(signal()).catch((error: unknown) => error)
    const remote = remoteErrorOf(failure)
    expect(remote).toMatchObject({ code: 'browser/unavailable', details: { baseUrl: BASE } })
    expect(remote?.message).toContain('did not answer health within 1000ms')
    expect(spawns).toEqual([{ command: 'pinchtab', args: ['server', '-b'] }])
    expect(sleeps).toEqual([250, 250, 250, 250])
  })

  it('fails start with browser/unavailable when the spawn fails and the server stays down', async () => {
    const { controller } = host({
      routes: { [`GET ${BASE}/health`]: () => new TypeError('fetch failed') },
      spawn: () => Promise.reject(new Error('spawn pinchtab ENOENT')),
    })
    const failure = await controller.start(signal()).catch((error: unknown) => error)
    const remote = remoteErrorOf(failure)
    expect(remote?.code).toBe('browser/unavailable')
    expect(remote?.message).toContain('could not start the PinchTab server: spawn pinchtab ENOENT')
  })

  it('tolerates an already-down server on stop', async () => {
    const { controller, spawns } = host({
      routes: { [`GET ${BASE}/health`]: () => new TypeError('fetch failed') },
      spawn: () => {
        throw new Error('spawn must not run when the server is already down')
      },
    })
    await expect(controller.stop(signal())).resolves.toEqual({ running: false, tabs: [] })
    expect(spawns).toEqual([])
  })

  it('stops a running server and waits for health to fail', async () => {
    let up = true
    const { controller, spawns, sleeps } = host({
      routes: { [`GET ${BASE}/health`]: () => up ? jsonResponse({}) : new TypeError('fetch failed') },
      spawn: (command, args) => {
        expect([command, ...args]).toEqual(['pinchtab', 'server', 'stop'])
        up = false
      },
    })
    await expect(controller.stop(signal())).resolves.toEqual({ running: false, tabs: [] })
    expect(spawns).toEqual([{ command: 'pinchtab', args: ['server', 'stop'] }])
    expect(sleeps).toEqual([])
  })

  it('accepts a failed stop command when the server went down anyway', async () => {
    let up = true
    const { controller, spawns } = host({
      routes: { [`GET ${BASE}/health`]: () => up ? jsonResponse({}) : new TypeError('fetch failed') },
      spawn: () => {
        up = false
        return Promise.reject(new Error('pid file lacks verifiable background metadata'))
      },
    })
    await expect(controller.stop(signal())).resolves.toEqual({ running: false, tabs: [] })
    expect(spawns).toEqual([{ command: 'pinchtab', args: ['server', 'stop'] }])
  })

  it('fails stop when the server keeps answering', async () => {
    let now = 0
    const { controller, sleeps } = host({
      routes: { [`GET ${BASE}/health`]: () => jsonResponse({}) },
      spawn: () => {},
      now: () => now,
      sleep: (ms) => {
        now += ms
      },
      config: { startTimeoutMs: 1000 },
    })
    const failure = await controller.stop(signal()).catch((error: unknown) => error)
    const remote = remoteErrorOf(failure)
    expect(remote?.code).toBe('browser/unavailable')
    expect(remote?.message).toContain('still answers health 1000ms after stop')
    expect(sleeps).toEqual([250, 250, 250, 250])
  })

  it('classifies a pre-aborted call as gateway/cancelled without touching the server', async () => {
    const { controller, calls } = host({ routes: {} })
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    await expect(controller.status(abort.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
    await expect(controller.screenshot(undefined, abort.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
    await expect(controller.click('TAB-A', 1, 2, abort.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(calls).toEqual([])
  })
})
