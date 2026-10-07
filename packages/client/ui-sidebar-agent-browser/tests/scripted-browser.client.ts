/**
 * A `browser` Remote namespace the spec settles by hand: every method is a
 * mock whose call stays pending until the spec resolves it with the
 * `RemoteResult` the generated face would answer.
 */
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { BrowserFrame, BrowserStatus, BrowserTabInfo } from '@deepseek-ai/dsh-api-browser-controller/types'
import type { BrowserNamespace, BrowserRemote } from '../src/client/face.ts'

/** The namespace's methods, as mocks. */
export interface ScriptedBrowserMocks {
  readonly status: Mock<BrowserNamespace['status']>
  readonly start: Mock<BrowserNamespace['start']>
  readonly stop: Mock<BrowserNamespace['stop']>
  readonly screenshot: Mock<BrowserNamespace['screenshot']>
  readonly openTab: Mock<BrowserNamespace['openTab']>
  readonly navigate: Mock<BrowserNamespace['navigate']>
  readonly click: Mock<BrowserNamespace['click']>
  readonly wheel: Mock<BrowserNamespace['wheel']>
  readonly key: Mock<BrowserNamespace['key']>
  readonly typeText: Mock<BrowserNamespace['typeText']>
}

/** The scripted namespace: the mocks the face receives, and the hands that settle them. */
export interface ScriptedBrowser {
  /** The Remote face handed to `browserFace`. */
  readonly remote: BrowserRemote
  /** The namespace's mocks, for call assertions. */
  readonly mocks: ScriptedBrowserMocks
  /**
   * Settle the oldest outstanding call of one method.
   * @param method - the namespace method.
   * @param result - the resolved value, or the error branch under `error`.
   */
  readonly settle: (method: keyof ScriptedBrowserMocks, result: unknown) => Promise<void>
  /**
   * Settle the newest outstanding call of one method, so an older one can land after it.
   * @param method - the namespace method.
   * @param result - the resolved value, or the error branch under `error`.
   */
  readonly settleLatest: (method: keyof ScriptedBrowserMocks, result: unknown) => Promise<void>
}

/** One call awaiting the spec's answer. */
interface PendingCall {
  resolve(value: unknown): void
}

/** Wrap a resolved value for {@link ScriptedBrowser.settle}. */
export function answer<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value }
}

/** Wrap an error branch for {@link ScriptedBrowser.settle}. */
export function fail(error: unknown): { readonly ok: false; readonly error: unknown } {
  return { ok: false, error }
}

/** A running status with one active tab. */
export const RUNNING: BrowserStatus = {
  running: true,
  tabs: [{ id: 'bt-1', title: 'Example', url: 'https://example.com/', active: true }],
}

/** A stopped status. */
export const DOWN: BrowserStatus = { running: false, tabs: [] }

/** One 800×600 frame: the base64 payload is the spec's marker, not a real picture. */
export function frame(data: string, takenAt = 1): BrowserFrame {
  return { data, width: 800, height: 600, takenAt }
}

/** The tab `openTab` answers with. */
export const OPENED_TAB: BrowserTabInfo = { id: 'bt-2', title: 'New', url: 'https://example.org/', active: true }

/**
 * Build a namespace whose every call stays pending until the spec settles it.
 * @returns the scripted namespace.
 */
export function scriptedBrowser(): ScriptedBrowser {
  const pending = new Map<string, PendingCall[]>()
  const queue = (method: string): PendingCall[] => {
    const calls = pending.get(method) ?? []
    pending.set(method, calls)
    return calls
  }
  const defer = (method: string) => (..._args: unknown[]): Promise<unknown> =>
    new Promise<unknown>((resolve) => { queue(method).push({ resolve }) })
  const mocks: ScriptedBrowserMocks = {
    status: vi.fn(defer('status') as BrowserNamespace['status']),
    start: vi.fn(defer('start') as BrowserNamespace['start']),
    stop: vi.fn(defer('stop') as BrowserNamespace['stop']),
    screenshot: vi.fn(defer('screenshot') as BrowserNamespace['screenshot']),
    openTab: vi.fn(defer('openTab') as BrowserNamespace['openTab']),
    navigate: vi.fn(defer('navigate') as BrowserNamespace['navigate']),
    click: vi.fn(defer('click') as BrowserNamespace['click']),
    wheel: vi.fn(defer('wheel') as BrowserNamespace['wheel']),
    key: vi.fn(defer('key') as BrowserNamespace['key']),
    typeText: vi.fn(defer('typeText') as BrowserNamespace['typeText']),
  }
  const land = async (call: PendingCall | undefined, method: string, result: unknown): Promise<void> => {
    if (call === undefined) throw new Error(`no outstanding ${method} call to settle`)
    const outcome = result as { ok: boolean; value?: unknown; error?: unknown }
    // The generated Remote face resolves a RemoteResult — failures arrive as
    // the error branch, never as a rejection (assembly faults aside).
    call.resolve(outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error })
    await Promise.resolve()
    await Promise.resolve()
  }
  return {
    remote: { browser: mocks },
    mocks,
    settle: (method, result) => land(queue(method).shift(), method, result),
    settleLatest: (method, result) => land(queue(method).pop(), method, result),
  }
}
