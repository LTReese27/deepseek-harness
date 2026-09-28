/**
 * Host Remote owner of the `browser` namespace: the DSH Web GUI's window into
 * a locally running PinchTab browser-automation server.
 *
 * Every method proxies the PinchTab HTTP API with the deployment's bearer
 * token, re-read from its config file on each call because a first server
 * start regenerates it. The token rides only the `Authorization` header
 * toward `baseUrl`; no result, error message, or error details carry it, so
 * the browser client can never observe it.
 *
 * Coordinates in pointer actions and screenshot frames are CSS viewport
 * pixels: screenshots are requested at `1 / deviceScaleFactor` so one image
 * pixel is one CSS pixel, matching what PinchTab's action endpoint takes.
 *
 * @module @deepseek-ai/dsh-api-browser-controller
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleepMs } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService, type RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'
import type { BrowserFrame, BrowserStatus, BrowserTabInfo } from './types.ts'

export type * from './types.ts'

/** Deployment connection and capture tuning for the proxied PinchTab server. */
export interface Config {
  /** Base URL the PinchTab server listens on. */
  readonly baseUrl: string
  /**
   * PinchTab bearer token; wins over {@link tokenFile} when set. Leaves the
   * Host only as the `Authorization` header toward {@link baseUrl}.
   */
  readonly token?: string
  /**
   * JSON file the token is re-read from on every call when {@link token} is
   * unset: `server.token`, with a top-level `token` fallback. Defaults to
   * `~/.pinchtab/config.json`. A missing file means the server has never run.
   */
  readonly tokenFile?: string
  /**
   * Ratio of screenshot device pixels to CSS viewport pixels; screenshots are
   * requested at `1 / deviceScaleFactor` so the frame comes back in CSS
   * pixels, the unit pointer actions take. `2` is PinchTab's headless
   * default. Measure a deployment by taking a raw screenshot, dividing its
   * pixel width by the viewport's CSS width (`window.innerWidth`), and
   * confirming with a click probe at known CSS coordinates.
   */
  readonly deviceScaleFactor: number
  /** JPEG quality requested for screenshots, 1 through 100. */
  readonly screenshotQuality: number
  /**
   * Longest {@link BrowserController.start} and {@link BrowserController.stop}
   * wait for the server's health answer to flip, in milliseconds.
   */
  readonly startTimeoutMs: number
  /** PinchTab binary name used by start/stop. */
  readonly command: string
}

/** Host integrations replaceable by direct unit tests. */
export interface BrowserControllerInternals {
  /** Fetch implementation; defaults to the global `fetch`. */
  readonly fetchFn?: typeof fetch
  /**
   * Process launch for the PinchTab CLI, resolving when the child exits 0 and
   * rejecting otherwise. The default spawns with stdio ignored; the CLI
   * itself detaches the server on `server -b`, so the child never outlives
   * the call.
   */
  readonly spawnFn?: (command: string, args: readonly string[], signal: AbortSignal) => Promise<void>
  /** Token-file read; defaults to `node:fs/promises` `readFile` as UTF-8. */
  readonly readFileFn?: (path: string) => Promise<string>
  /** Poll-delay primitive; defaults to `node:timers/promises` `setTimeout`. */
  readonly sleepFn?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Wall clock for frame timestamps and lifecycle deadlines; defaults to `Date.now`. */
  readonly nowFn?: () => number
}

/** Health verdict of one PinchTab probe. */
type HealthProbe = 'up' | 'down' | 'unauthorized'

/** One parsed PinchTab JSON failure body; every field is absent on drift. */
interface PinchTabFailureBody {
  readonly code: string | undefined
  readonly error: string | undefined
  readonly remedy: string | undefined
  readonly url: string | undefined
}

/** Fixed cadence of the start/stop health polls, in milliseconds. */
const HEALTH_POLL_MS = 250

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read abort state afresh after an awaited call; the signal mutates behind the caller's back. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field: unknown = Reflect.get(value, key)
  return typeof field === 'string' ? field : undefined
}

/**
 * Read the token from one parsed PinchTab config document: `server.token`,
 * with a top-level `token` fallback.
 */
function tokenFromConfig(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const serverToken = stringField(Reflect.get(value, 'server'), 'token')
  if (serverToken !== undefined && serverToken.length > 0) return serverToken
  const fallback = stringField(value, 'token')
  return fallback !== undefined && fallback.length > 0 ? fallback : undefined
}

/** Structure one parsed PinchTab failure body; undefined when it carries nothing machine-readable. */
function failureBodyOf(value: unknown): PinchTabFailureBody | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const details: unknown = Reflect.get(value, 'details')
  const body = {
    code: stringField(value, 'code'),
    error: stringField(value, 'error'),
    remedy: stringField(details, 'remedy'),
    url: stringField(details, 'url'),
  }
  if (body.code === undefined && body.error === undefined && body.remedy === undefined && body.url === undefined) {
    return undefined
  }
  return body
}

/** Pixel dimensions carried by one JPEG frame. */
interface JpegSize {
  readonly width: number
  readonly height: number
}

/**
 * Read pixel dimensions from a JPEG's Start Of Frame segment. The screenshot
 * endpoint reports no dimensions of its own, so the frame's CSS-pixel size
 * comes from the bytes themselves.
 * @param bytes - the complete frame.
 * @returns the dimensions, or undefined when the bytes are not a decodable JPEG.
 */
function jpegSize(bytes: Uint8Array): JpegSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return undefined
  let offset = 2
  while (offset + 4 <= bytes.length) {
    const flag = bytes[offset]
    const marker = bytes[offset + 1]
    const lengthHi = bytes[offset + 2]
    const lengthLo = bytes[offset + 3]
    if (flag === undefined || marker === undefined || lengthHi === undefined || lengthLo === undefined) return undefined
    if (flag !== 0xFF) return undefined
    // SOFn markers carry dimensions; 0xC4 (DHT), 0xC8 (JPG), and 0xCC (DAC)
    // sit in the same range but are not SOF. Standalone markers (RSTn, SOI,
    // EOI, SOS) have no length field and cannot appear before the SOF.
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      if (offset + 9 > bytes.length) return undefined
      const heightHi = bytes[offset + 5]
      const heightLo = bytes[offset + 6]
      const widthHi = bytes[offset + 7]
      const widthLo = bytes[offset + 8]
      if (heightHi === undefined || heightLo === undefined || widthHi === undefined || widthLo === undefined) return undefined
      return { width: (widthHi << 8) | widthLo, height: (heightHi << 8) | heightLo }
    }
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) return undefined
    const length = (lengthHi << 8) | lengthLo
    if (length < 2) return undefined
    offset += 2 + length
  }
  return undefined
}

/**
 * Run one PinchTab CLI invocation to completion. `server -b` detaches the
 * server and exits, so the child is always waited on; stdio is ignored.
 */
function spawnPinchtab(command: string, args: readonly string[], signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'ignore' })
    const onAbort = (): void => { child.kill() }
    if (signal.aborted) child.kill()
    else signal.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.once('exit', (code, exitSignal) => {
      signal.removeEventListener('abort', onAbort)
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} exited ${code === null ? `on signal ${String(exitSignal)}` : `with code ${code}`}`))
    })
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `browser` Remote namespace. */
    browserController: BrowserController
  }
}

/**
 * Host service backing the generated `ctx.remote.browser` namespace: status,
 * lifecycle, tab and navigation control, screenshots, and pointer/keyboard
 * input over one locally running PinchTab server.
 *
 * Failure vocabulary: a server that is unreachable, never ran, unspawnable,
 * or slow to converge answers `browser/unavailable`; a missing tab answers
 * `browser/not-found`; every other PinchTab JSON failure body crosses as
 * `browser/<its code>` with the upstream message — an IDPI allowlist refusal
 * (`403`, code containing `idpi`) additionally carries PinchTab's remedy text
 * in the message. Caller cancellation answers `gateway/cancelled`.
 */
export class BrowserController extends TypertRemoteService {
  static Config: Schema<Config> = Schema.object({
    baseUrl: Schema.string().default('http://127.0.0.1:9867'),
    token: Schema.string(),
    tokenFile: Schema.string(),
    deviceScaleFactor: Schema.number().min(1).default(2),
    screenshotQuality: Schema.number().step(1).min(1).max(100).default(70),
    startTimeoutMs: Schema.number().step(1).min(1).default(10000),
    command: Schema.string().default('pinchtab'),
  })

  /** Server root with no trailing slash, ready for path joining. */
  private readonly base: string
  private readonly fetchFn: typeof fetch
  private readonly spawnFn: (command: string, args: readonly string[], signal: AbortSignal) => Promise<void>
  private readonly readFileFn: (path: string) => Promise<string>
  private readonly sleepFn: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly nowFn: () => number

  /**
   * Register the browser namespace. No other Host services are required; the
   * proxied server is reached over HTTP per call.
   * @param ctx - Host context.
   * @param config - deployment connection and capture tuning.
   * @param internals - replaceable integrations for direct unit tests.
   */
  constructor(ctx: Context, private readonly config: Config, internals: BrowserControllerInternals = {}) {
    super(ctx, 'browserController', { namespace: 'browser' })
    this.base = config.baseUrl.replace(/\/+$/, '')
    this.fetchFn = internals.fetchFn ?? fetch
    this.spawnFn = internals.spawnFn ?? spawnPinchtab
    this.readFileFn = internals.readFileFn ?? (path => readFile(path, 'utf8'))
    this.sleepFn = internals.sleepFn ?? ((ms, signal) => sleepMs(ms, undefined, { signal }))
    this.nowFn = internals.nowFn ?? Date.now
  }

  /**
   * Report whether the PinchTab server is up, with its tabs when it is. A
   * server that is down, unreachable, or never ran (no token file) is a
   * result, not a failure: `{ running: false, tabs: [] }`.
   * @param signal - caller cancellation.
   * @returns the current server status.
   * @throws RemoteError `browser/unavailable` when the server answers but rejects
   *   the bearer token, or `gateway/internal` when an up server's tab listing drifts from the protocol.
   */
  @Remote
  async status(signal: AbortSignal): Promise<BrowserStatus> {
    if (signal.aborted) throw this.cancelled('status')
    const health = await this.probeHealth(signal)
    if (health === 'down') return { running: false, tabs: [] }
    if (health === 'unauthorized') throw this.unauthorized()
    // The health probe succeeded, so a token existed; its file could still have vanished since.
    const token = await this.readToken()
    if (token === undefined) return { running: false, tabs: [] }
    let listing: Response
    try {
      listing = await this.fetchFn(`${this.base}/tabs`, { headers: this.headers(token), signal })
    } catch {
      if (isAborted(signal)) throw this.cancelled('status')
      // The server died between the health probe and the listing: still a down server.
      return { running: false, tabs: [] }
    }
    if (listing.status === 401) throw this.unauthorized()
    if (!listing.ok) {
      throw new RemoteError('gateway/internal', `PinchTab answered the tab listing with HTTP ${listing.status}`, {})
    }
    return { running: true, tabs: this.tabsOf(await this.readJson(listing, signal, 'tab listing')) }
  }

  /**
   * Start the PinchTab server and answer once it serves health. Idempotent:
   * an already-running server is answered with its status and no spawn. The
   * CLI detaches (`server -b`), then health is polled every
   * {@link HEALTH_POLL_MS} ms until {@link Config.startTimeoutMs}.
   * @param signal - caller cancellation; abort kills a still-running spawn.
   * @returns the server status once healthy.
   * @throws RemoteError `browser/unavailable` on spawn failure, health timeout, or a token the running server rejects.
   */
  @Remote
  async start(signal: AbortSignal): Promise<BrowserStatus> {
    if (signal.aborted) throw this.cancelled('start')
    const before = await this.probeHealth(signal)
    if (before === 'up') return this.status(signal)
    if (before === 'unauthorized') throw this.unauthorized()
    try {
      await this.spawnFn(this.config.command, ['server', '-b'], signal)
    } catch (error: unknown) {
      if (isAborted(signal)) throw this.cancelled('start')
      // A concurrent start may have won the race: accept the outcome when the server answers.
      if (await this.probeHealth(signal) === 'up') return this.status(signal)
      throw new RemoteError(
        'browser/unavailable',
        `could not start the PinchTab server: ${messageOf(error)}`,
        { baseUrl: this.base },
        { cause: error },
      )
    }
    const deadline = this.nowFn() + this.config.startTimeoutMs
    for (;;) {
      if (await this.probeHealth(signal) === 'up') return this.status(signal)
      if (this.nowFn() >= deadline) {
        throw new RemoteError(
          'browser/unavailable',
          `the PinchTab server did not answer health within ${this.config.startTimeoutMs}ms of start`,
          { baseUrl: this.base },
        )
      }
      await this.sleep(HEALTH_POLL_MS, signal)
    }
  }

  /**
   * Stop the PinchTab server and answer once its health endpoint fails.
   * Idempotent: an already-down server is answered with a non-running status
   * and no `server stop` invocation.
   * @param signal - caller cancellation; abort kills a still-running stop command.
   * @returns a non-running server status.
   * @throws RemoteError `browser/unavailable` when the stop command fails or the server still answers after {@link Config.startTimeoutMs}.
   */
  @Remote
  async stop(signal: AbortSignal): Promise<BrowserStatus> {
    if (signal.aborted) throw this.cancelled('stop')
    if (await this.probeHealth(signal) === 'down') return { running: false, tabs: [] }
    try {
      await this.spawnFn(this.config.command, ['server', 'stop'], signal)
    } catch (error: unknown) {
      if (isAborted(signal)) throw this.cancelled('stop')
      if (await this.probeHealth(signal) === 'down') return { running: false, tabs: [] }
      throw new RemoteError(
        'browser/unavailable',
        `could not stop the PinchTab server: ${messageOf(error)}`,
        { baseUrl: this.base },
        { cause: error },
      )
    }
    const deadline = this.nowFn() + this.config.startTimeoutMs
    for (;;) {
      if (await this.probeHealth(signal) === 'down') return { running: false, tabs: [] }
      if (this.nowFn() >= deadline) {
        throw new RemoteError(
          'browser/unavailable',
          `the PinchTab server still answers health ${this.config.startTimeoutMs}ms after stop`,
          { baseUrl: this.base },
        )
      }
      await this.sleep(HEALTH_POLL_MS, signal)
    }
  }

  /**
   * Capture one JPEG frame of a tab in CSS viewport pixels: the request asks
   * for `1 / deviceScaleFactor` scale and the configured quality, and the
   * frame's dimensions are read from the returned image bytes.
   * @param tabId - tab to capture; omitted targets the active tab, or the only tab.
   * @param signal - caller cancellation.
   * @returns the base64 frame, its CSS-pixel dimensions, and the host reception time.
   * @throws RemoteError `browser/not-found` when no tab exists or none can be
   *   selected, `browser/unavailable` when the server cannot serve the call,
   *   `browser/<code>` for another PinchTab refusal, or `gateway/internal` when
   *   the returned bytes are not a decodable JPEG.
   */
  @Remote
  async screenshot(tabId: string | undefined, signal: AbortSignal): Promise<BrowserFrame> {
    if (signal.aborted) throw this.cancelled('screenshot')
    const id = tabId ?? await this.defaultTabId(signal)
    const query = new URLSearchParams({
      raw: 'true',
      quality: String(this.config.screenshotQuality),
      scale: String(1 / this.config.deviceScaleFactor),
    })
    const response = await this.request(`/tabs/${encodeURIComponent(id)}/screenshot?${query.toString()}`, {}, signal)
    if (!response.ok) await this.fail(response, id, signal, 'screenshot')
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await response.arrayBuffer())
    } catch (error: unknown) {
      if (isAborted(signal)) throw this.cancelled('screenshot')
      throw new RemoteError('gateway/internal', `PinchTab frame body could not be read: ${messageOf(error)}`, {}, { cause: error })
    }
    const takenAt = this.nowFn()
    const size = jpegSize(bytes)
    if (size === undefined) {
      throw new RemoteError('gateway/internal', 'PinchTab returned a frame whose JPEG dimensions could not be read', {})
    }
    return { data: Buffer.from(bytes).toString('base64'), width: size.width, height: size.height, takenAt }
  }

  /**
   * Open one tab at a URL and answer its listed view. The creation response
   * is confirmed against a fresh tab listing so the answer carries the
   * server's own active flag.
   * @param url - URL the new tab navigates to.
   * @param signal - caller cancellation.
   * @returns the created tab.
   * @throws RemoteError `browser/unavailable` when the server cannot serve the
   *   call, or `browser/<code>` when PinchTab refuses — notably
   *   `browser/idpi_domain_blocked` for a URL outside its allowlist, whose
   *   message carries PinchTab's remedy.
   */
  @Remote
  async openTab(url: string, signal: AbortSignal): Promise<BrowserTabInfo> {
    if (signal.aborted) throw this.cancelled('tab creation')
    const response = await this.request('/tab', { method: 'POST', body: { action: 'new', url } }, signal)
    if (!response.ok) await this.fail(response, undefined, signal, 'tab creation')
    const body = await this.readJson(response, signal, 'tab creation')
    const id = stringField(body, 'tabId')
    if (id === undefined) {
      throw new RemoteError('gateway/internal', 'PinchTab tab creation returned no tabId', {})
    }
    const created = (await this.listTabs(signal)).find(tab => tab.id === id)
    if (created === undefined) {
      throw new RemoteError('gateway/internal', `PinchTab created tab "${id}" but no longer lists it`, {})
    }
    return created
  }

  /**
   * Navigate one tab to a URL.
   * @param tabId - tab to navigate.
   * @param url - destination URL.
   * @param signal - caller cancellation.
   * @returns the URL the tab landed on as PinchTab reports it.
   * @throws RemoteError `browser/not-found` when the tab does not exist,
   *   `browser/unavailable` when the server cannot serve the call, or
   *   `browser/<code>` when PinchTab refuses — notably `browser/idpi_domain_blocked`
   *   for a URL outside its allowlist, whose message carries PinchTab's remedy.
   */
  @Remote
  async navigate(tabId: string, url: string, signal: AbortSignal): Promise<{ url: string }> {
    if (signal.aborted) throw this.cancelled('navigation')
    const response = await this.request(`/tabs/${encodeURIComponent(tabId)}/navigate`, { method: 'POST', body: { url } }, signal)
    if (!response.ok) await this.fail(response, tabId, signal, 'navigation')
    const landed = stringField(await this.readJson(response, signal, 'navigation'), 'url')
    if (landed === undefined) {
      throw new RemoteError('gateway/internal', 'PinchTab navigation returned no url', {})
    }
    return { url: landed }
  }

  /**
   * Click one point of a tab, in CSS viewport pixels — the same unit
   * screenshots are captured in. A click that navigates is a success, not a
   * failure: PinchTab reports it as a `navigation_changed` error body and
   * this method answers with the landed URL.
   * @param tabId - tab to click in.
   * @param x - horizontal CSS pixel offset from the viewport's left edge.
   * @param y - vertical CSS pixel offset from the viewport's top edge.
   * @param signal - caller cancellation.
   * @returns the landed URL when the click navigated, otherwise nothing.
   * @throws RemoteError `browser/not-found` when the tab does not exist,
   *   `browser/unavailable` when the server cannot serve the call, or
   *   `browser/<code>` for any other PinchTab refusal.
   */
  @Remote
  async click(tabId: string, x: number, y: number, signal: AbortSignal): Promise<{ url?: string }> {
    if (signal.aborted) throw this.cancelled('click')
    const response = await this.action(tabId, { kind: 'click', x, y }, signal)
    if (response.ok) return {}
    const body = await this.failureBody(response, signal, 'click')
    if (body?.code === 'navigation_changed') {
      return body.url === undefined ? {} : { url: body.url }
    }
    return this.fail(response, tabId, signal, 'click', body)
  }

  /**
   * Scroll at one point of a tab, in CSS viewport pixels and wheel deltas.
   * @param tabId - tab to scroll in.
   * @param x - horizontal CSS pixel offset of the scroll origin.
   * @param y - vertical CSS pixel offset of the scroll origin.
   * @param deltaX - horizontal wheel delta; positive scrolls right.
   * @param deltaY - vertical wheel delta; positive scrolls down.
   * @param signal - caller cancellation.
   * @returns nothing; the scroll is fire-and-acknowledge.
   * @throws RemoteError `browser/not-found` when the tab does not exist,
   *   `browser/unavailable` when the server cannot serve the call, or
   *   `browser/<code>` for any other PinchTab refusal.
   */
  @Remote
  async wheel(tabId: string, x: number, y: number, deltaX: number, deltaY: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw this.cancelled('wheel')
    const response = await this.action(tabId, { kind: 'mouse-wheel', x, y, deltaX, deltaY }, signal)
    if (!response.ok) await this.fail(response, tabId, signal, 'wheel')
  }

  /**
   * Press one key in a tab: `Enter`, `Tab`, `Escape`, `Backspace`, arrows, and
   * the rest of PinchTab's key vocabulary.
   * @param tabId - tab to press in.
   * @param key - PinchTab key name.
   * @param signal - caller cancellation.
   * @returns nothing; the press is fire-and-acknowledge.
   * @throws RemoteError `browser/not-found` when the tab does not exist,
   *   `browser/unavailable` when the server cannot serve the call, or
   *   `browser/<code>` for any other PinchTab refusal.
   */
  @Remote
  async key(tabId: string, key: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw this.cancelled('key press')
    const response = await this.action(tabId, { kind: 'press', key }, signal)
    if (!response.ok) await this.fail(response, tabId, signal, 'key press')
  }

  /**
   * Type text into the tab's focused element.
   * @param tabId - tab to type in.
   * @param text - the text to enter.
   * @param signal - caller cancellation.
   * @returns nothing; the input is fire-and-acknowledge.
   * @throws RemoteError `browser/not-found` when the tab does not exist,
   *   `browser/unavailable` when the server cannot serve the call, or
   *   `browser/<code>` for any other PinchTab refusal.
   */
  @Remote
  async typeText(tabId: string, text: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw this.cancelled('text input')
    const response = await this.action(tabId, { kind: 'type', text }, signal)
    if (!response.ok) await this.fail(response, tabId, signal, 'text input')
  }

  /** POST one action body to a tab's action endpoint. */
  private action(tabId: string, body: Record<string, string | number>, signal: AbortSignal): Promise<Response> {
    return this.request(`/tabs/${encodeURIComponent(tabId)}/action`, { method: 'POST', body }, signal)
  }

  /** Authorization headers toward the server; the only place the token leaves this service. */
  private headers(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` }
  }

  /**
   * Probe the server's health once. No token file means the server never ran:
   * `down`. A `401` means the server runs but the token is stale:
   * `unauthorized`. Any other non-OK answer reads as `down`.
   */
  private async probeHealth(signal: AbortSignal): Promise<HealthProbe> {
    const token = await this.readToken()
    if (token === undefined) return 'down'
    let response: Response
    try {
      response = await this.fetchFn(`${this.base}/health`, { headers: this.headers(token), signal })
    } catch {
      // A refused connection is the down signal; the probe's callers classify, not log.
      if (signal.aborted) throw this.cancelled('health probe')
      return 'down'
    }
    if (response.status === 401) return 'unauthorized'
    return response.ok ? 'up' : 'down'
  }

  /**
   * One authenticated request to the server, classifying only what every
   * caller shares: transport failure and token rejection as
   * `browser/unavailable`, caller cancellation as `gateway/cancelled`.
   * Non-OK business answers stay with the caller.
   */
  private async request(
    path: string,
    init: { method?: string; body?: Record<string, string | number> },
    signal: AbortSignal,
  ): Promise<Response> {
    const token = await this.requireToken()
    let response: Response
    try {
      response = await this.fetchFn(`${this.base}${path}`, {
        method: init.method ?? 'GET',
        headers: init.body === undefined
          ? this.headers(token)
          : { ...this.headers(token), 'content-type': 'application/json' },
        ...init.body === undefined ? {} : { body: JSON.stringify(init.body) },
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw this.cancelled('request')
      throw new RemoteError(
        'browser/unavailable',
        `cannot reach the PinchTab server at ${this.base}: ${messageOf(error)}`,
        { baseUrl: this.base },
        { cause: error },
      )
    }
    if (response.status === 401) throw this.unauthorized()
    return response
  }

  /**
   * Classify one non-OK business answer. A `404` on a tab-scoped path names a
   * missing tab; a JSON failure body's code crosses as `browser/<code>` with
   * the upstream message, plus the PinchTab remedy text when an IDPI refusal
   * supplies one; anything else is an unclassified internal failure.
   * @param body - the already-consumed failure body, when the caller read it first.
   */
  private async fail(
    response: Response,
    tabId: string | undefined,
    signal: AbortSignal,
    what: string,
    body?: PinchTabFailureBody,
  ): Promise<never> {
    const failure = body ?? await this.failureBody(response, signal, what)
    if (response.status === 404 && tabId !== undefined) {
      throw new RemoteError(
        'browser/not-found',
        failure?.error ?? `browser tab "${tabId}" does not exist`,
        { tabId },
      )
    }
    if (failure?.code !== undefined) {
      const base = failure.error ?? `PinchTab ${what} failed`
      const message = failure.code.includes('idpi') && failure.remedy !== undefined
        ? `${base} Remedy: ${failure.remedy}`
        : base
      // PinchTab's failure-code vocabulary is open-ended (its generic failures
      // all carry code "error"), so this family cannot be enumerated in
      // RemoteErrorDetailsMap: the wire contract is `browser/<upstream code>`
      // with the upstream message and untyped details.
      throw new RemoteError(`browser/${failure.code}` as RemoteErrorCode, message, {})
    }
    throw new RemoteError('gateway/internal', `PinchTab answered the ${what} with HTTP ${response.status}`, {})
  }

  /** Read a response body as JSON, classifying abort and non-JSON drift. */
  private async readJson(response: Response, signal: AbortSignal, what: string): Promise<unknown> {
    try {
      const parsed: unknown = await response.json()
      return parsed
    } catch (error: unknown) {
      if (signal.aborted) throw this.cancelled(what)
      throw new RemoteError('gateway/internal', `PinchTab returned a non-JSON ${what} response`, {}, { cause: error })
    }
  }

  /** Parse a failure body when it is JSON; a non-JSON body carries no code and the HTTP status classifies it. */
  private async failureBody(response: Response, signal: AbortSignal, what: string): Promise<PinchTabFailureBody | undefined> {
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      if (signal.aborted) throw this.cancelled(what)
      return undefined
    }
    return failureBodyOf(parsed)
  }

  /** List the server's tabs through the classifying request path. */
  private async listTabs(signal: AbortSignal): Promise<BrowserTabInfo[]> {
    const response = await this.request('/tabs', {}, signal)
    if (!response.ok) await this.fail(response, undefined, signal, 'tab listing')
    return this.tabsOf(await this.readJson(response, signal, 'tab listing'))
  }

  /** Project the server's tab array onto the wire vocabulary, refusing drift at the wire boundary. */
  private tabsOf(body: unknown): BrowserTabInfo[] {
    const entries: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'tabs') : undefined
    if (!Array.isArray(entries)) {
      throw new RemoteError('gateway/internal', 'PinchTab tab listing carried no tabs array', {})
    }
    return entries.map((entry: unknown, index: number): BrowserTabInfo => {
      const id = stringField(entry, 'id')
      const title = stringField(entry, 'title')
      const url = stringField(entry, 'url')
      if (id === undefined || title === undefined || url === undefined) {
        throw new RemoteError('gateway/internal', `PinchTab tab listing entry ${index} lacks id, title, or url`, {})
      }
      return { id, title, url, active: stringField(entry, 'status') === 'active' }
    })
  }

  /** The screenshot target when the caller names none: the active tab, or the only tab. */
  private async defaultTabId(signal: AbortSignal): Promise<string> {
    const tabs = await this.listTabs(signal)
    const active = tabs.find(tab => tab.active)
    if (active !== undefined) return active.id
    const [only] = tabs
    if (tabs.length === 1 && only !== undefined) return only.id
    throw new RemoteError(
      'browser/not-found',
      tabs.length === 0
        ? 'no browser tab exists to screenshot'
        : 'no active tab and more than one tab exists; pass tabId',
      {},
    )
  }

  /** The configured token, or the token file's current value, re-read on every call. */
  private async readToken(): Promise<string | undefined> {
    if (this.config.token !== undefined) return this.config.token
    const file = this.config.tokenFile ?? join(homedir(), '.pinchtab', 'config.json')
    let text: string
    try {
      text = await this.readFileFn(file)
    } catch {
      // A missing or unreadable file means the server has never run here; callers report that state.
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // A malformed config carries no usable token; callers report the server as unavailable.
      return undefined
    }
    return tokenFromConfig(parsed)
  }

  /** The token every server call needs, or the unavailable failure its absence means. */
  private async requireToken(): Promise<string> {
    const token = await this.readToken()
    if (token === undefined) {
      throw new RemoteError(
        'browser/unavailable',
        `no PinchTab token is available: the server has never run (no readable config at ${this.config.tokenFile ?? join(homedir(), '.pinchtab', 'config.json')}) and the token config field is unset`,
        { baseUrl: this.base },
      )
    }
    return token
  }

  /** The token-rejection failure: the server runs, but the bearer token is stale. */
  private unauthorized(): RemoteError {
    return new RemoteError(
      'browser/unavailable',
      `the PinchTab server at ${this.base} rejected the bearer token: re-check server.token in the token file or the token config field`,
      { baseUrl: this.base },
    )
  }

  /** Caller cancellation, classified for the Remote carrier. */
  private cancelled(what: string): RemoteError {
    return new RemoteError('gateway/cancelled', `browser ${what} was aborted`, {})
  }

  /** One abort-aware poll delay. */
  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    try {
      await this.sleepFn(ms, signal)
    } catch (error: unknown) {
      if (signal.aborted) throw this.cancelled('wait')
      throw error
    }
  }
}

export default BrowserController
