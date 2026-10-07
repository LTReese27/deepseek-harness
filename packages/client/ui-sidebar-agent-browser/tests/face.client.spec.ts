/**
 * The pane's asynchronous half against a scripted namespace.
 *
 * The face's contract is what reaches the store and when: a poll's answer is
 * recorded only while its generation is the latest and the record is live, a
 * failure — the resolved error branch, or an assembly fault's rejection —
 * lands as an inline note and never throws past the face, a click prompts
 * exactly one frame refresh after the click settles, and an aborted record
 * forgets its bucket and drops its pending follow-ups.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { browserFace, CLICK_REFRESH_DELAY_MS, failureOf } from '../src/client/face.ts'
import { createBrowserStore } from '../src/client/store.ts'
import type { BrowserTabState } from '../src/client/store.ts'
import { answer, DOWN, fail, frame, OPENED_TAB, RUNNING, scriptedBrowser } from './scripted-browser.client.ts'
import type { ScriptedBrowser } from './scripted-browser.client.ts'

const SESSION = 's-1'
const TAB = 'tab-1' as TabId
/** The PinchTab server address the failure details carry. */
const BASE_URL = 'http://127.0.0.1:9867'

afterEach(() => { vi.useRealTimers() })

function mount() {
  vi.useFakeTimers()
  const instance = createBrowserStore().create()
  const script: ScriptedBrowser = scriptedBrowser()
  const face = browserFace(script.remote)(SESSION, instance.actions)
  const snapshot = (): BrowserTabState | undefined => instance.getSnapshot().byTab[TAB]
  return { ...script, face, snapshot }
}

describe('browserFace lifecycle', () => {
  it('begin seeds the tab, and abort forgets it while late settlements write nothing', async () => {
    const { face, mocks, settle, snapshot } = mount()
    const controller = new AbortController()
    face.begin(TAB, controller.signal)
    expect(snapshot()).toBeDefined()
    face.refresh(TAB, controller.signal)
    controller.abort()
    expect(snapshot()).toBeUndefined()
    await settle('status', answer(DOWN))
    expect(snapshot()).toBeUndefined()
    expect(mocks.status).toHaveBeenCalledTimes(1)
  })

  it('makes no request for a record that already ended', () => {
    const { face, mocks } = mount()
    const controller = new AbortController()
    controller.abort()
    face.refresh(TAB, controller.signal)
    face.capture(TAB, 'bt-1', controller.signal)
    face.setRunning(TAB, true, controller.signal)
    face.submitUrl(TAB, undefined, 'https://example.com', controller.signal)
    face.clickAt(TAB, 'bt-1', 1, 2, controller.signal)
    face.wheelAt(TAB, 'bt-1', 1, 2, 0, 10, controller.signal)
    face.pressKey(TAB, 'bt-1', 'Enter', controller.signal)
    face.typeText(TAB, 'bt-1', 'a', controller.signal)
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled()
  })
})

describe('browserFace status', () => {
  it('records a settled status and a rejected poll as an inline failure', async () => {
    const { face, settle, snapshot } = mount()
    const signal = new AbortController().signal
    face.begin(TAB, signal)
    face.refresh(TAB, signal)
    await settle('status', answer(DOWN))
    expect(snapshot()!.status).toBe(DOWN)
    face.refresh(TAB, signal)
    await settle('status', fail(new RemoteError('browser/unavailable', 'no backend', { baseUrl: BASE_URL })))
    expect(snapshot()!.failure).toEqual({ code: 'browser/unavailable', message: 'no backend' })
    // The next good status clears the note.
    face.refresh(TAB, signal)
    await settle('status', answer(RUNNING))
    expect(snapshot()!.failure).toBeUndefined()
  })

  it('lets the latest poll win, whichever settles first', async () => {
    const { face, settle, settleLatest, snapshot } = mount()
    const signal = new AbortController().signal
    face.begin(TAB, signal)
    face.refresh(TAB, signal)
    face.refresh(TAB, signal)
    await settleLatest('status', answer(RUNNING))
    expect(snapshot()!.status).toBe(RUNNING)
    // The retired poll lands afterwards and changes nothing — answer or failure.
    await settle('status', answer(DOWN))
    expect(snapshot()!.status).toBe(RUNNING)
    face.refresh(TAB, signal)
    face.refresh(TAB, signal)
    await settleLatest('status', answer(RUNNING))
    await settle('status', fail(new RemoteError('browser/unavailable', 'late', { baseUrl: BASE_URL })))
    expect(snapshot()!.failure).toBeUndefined()
  })
})

describe('browserFace frames', () => {
  it('records a frame and lets the latest fetch win', async () => {
    const { face, settle, settleLatest, snapshot } = mount()
    const signal = new AbortController().signal
    face.begin(TAB, signal)
    face.capture(TAB, 'bt-1', signal)
    await settle('screenshot', answer(frame('a')))
    expect(snapshot()!.frame).toEqual(frame('a'))
    face.capture(TAB, 'bt-1', signal)
    face.capture(TAB, 'bt-1', signal)
    await settleLatest('screenshot', answer(frame('b')))
    expect(snapshot()!.frame).toEqual(frame('b'))
    await settle('screenshot', answer(frame('older')))
    expect(snapshot()!.frame).toEqual(frame('b'))
    // A retired fetch's failure is dropped the same way.
    face.capture(TAB, 'bt-1', signal)
    face.capture(TAB, 'bt-1', signal)
    await settleLatest('screenshot', answer(frame('c')))
    await settle('screenshot', fail(new RemoteError('browser/unavailable', 'stale failure', { baseUrl: BASE_URL })))
    expect(snapshot()!.frame).toEqual(frame('c'))
    expect(snapshot()!.failure).toBeUndefined()
  })

  it('routes a not-found frame failure to the empty state and other failures to the note', async () => {
    const { face, settle, snapshot } = mount()
    const signal = new AbortController().signal
    face.begin(TAB, signal)
    face.capture(TAB, 'bt-1', signal)
    await settle('screenshot', answer(frame('a')))
    face.capture(TAB, 'bt-1', signal)
    await settle('screenshot', fail(new RemoteError('browser/not-found', 'gone', { tabId: 'bt-1' })))
    expect(snapshot()!.frame).toBeUndefined()
    expect(snapshot()!.frameGone).toBe(true)
    face.capture(TAB, 'bt-1', signal)
    await settle('screenshot', fail(new RemoteError('browser/unavailable', 'hiccup', { baseUrl: BASE_URL })))
    expect(snapshot()!.frameGone).toBe(true)
    expect(snapshot()!.failure?.code).toBe('browser/unavailable')
  })
})

describe('browserFace actions', () => {
  it('setRunning raises the busy flag for the call and records the returned status', async () => {
    const { face, mocks, settle, snapshot } = mount()
    const signal = new AbortController().signal
    face.begin(TAB, signal)
    face.setRunning(TAB, true, signal)
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(mocks.stop).not.toHaveBeenCalled()
    expect(snapshot()!.lifecycleBusy).toBe(true)
    await settle('start', answer(RUNNING))
    expect(snapshot()!.lifecycleBusy).toBe(false)
    expect(snapshot()!.status).toBe(RUNNING)
    face.setRunning(TAB, false, signal)
    expect(mocks.stop).toHaveBeenCalledTimes(1)
    expect(snapshot()!.lifecycleBusy).toBe(true)
    await settle('stop', fail(new RemoteError('browser/unavailable', 'cannot stop', { baseUrl: BASE_URL })))
    expect(snapshot()!.lifecycleBusy).toBe(false)
    expect(snapshot()!.failure).toEqual({ code: 'browser/unavailable', message: 'cannot stop' })
  })

  it('submitUrl opens a first tab without a target and navigates one with it, refreshing afterwards', async () => {
    const { face, mocks, settle, snapshot } = mount()
    const signal = new AbortController().signal
    face.begin(TAB, signal)
    face.submitUrl(TAB, undefined, 'https://example.org', signal)
    expect(mocks.openTab).toHaveBeenCalledWith('https://example.org', signal)
    expect(mocks.navigate).not.toHaveBeenCalled()
    await settle('openTab', answer(OPENED_TAB))
    // The settled open prompts one status refresh.
    expect(mocks.status).toHaveBeenCalledTimes(1)
    await settle('status', answer(RUNNING))
    face.submitUrl(TAB, 'bt-1', 'https://example.com/next', signal)
    expect(mocks.navigate).toHaveBeenCalledWith('bt-1', 'https://example.com/next', signal)
    await settle('navigate', fail(new RemoteError('browser/not-found', 'tab went away', { tabId: 'bt-1' })))
    expect(snapshot()!.failure).toEqual({ code: 'browser/not-found', message: 'tab went away' })
  })

  it('clickAt delivers the click and prompts exactly one frame refresh after it settles', async () => {
    const { face, mocks, settle, snapshot } = mount()
    const signal = new AbortController().signal
    face.begin(TAB, signal)
    face.clickAt(TAB, 'bt-1', 100, 50, signal)
    expect(mocks.click).toHaveBeenCalledWith('bt-1', 100, 50, signal)
    // Nothing is fetched before the click settles.
    vi.advanceTimersByTime(CLICK_REFRESH_DELAY_MS * 4)
    expect(mocks.screenshot).not.toHaveBeenCalled()
    await settle('click', answer({}))
    vi.advanceTimersByTime(CLICK_REFRESH_DELAY_MS - 1)
    expect(mocks.screenshot).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(mocks.screenshot).toHaveBeenCalledTimes(1)
    expect(mocks.screenshot).toHaveBeenLastCalledWith('bt-1', signal)
    await settle('screenshot', answer(frame('after-click')))
    expect(snapshot()!.frame).toEqual(frame('after-click'))
    // No timer lingers afterwards.
    vi.advanceTimersByTime(CLICK_REFRESH_DELAY_MS * 10)
    expect(mocks.screenshot).toHaveBeenCalledTimes(1)
  })

  it('a failed click lands as an inline failure and prompts no refresh', async () => {
    const { face, mocks, settle, snapshot } = mount()
    const signal = new AbortController().signal
    face.begin(TAB, signal)
    face.clickAt(TAB, 'bt-1', 100, 50, signal)
    await settle('click', fail(new RemoteError('browser/not-found', 'gone', { tabId: 'bt-1' })))
    expect(snapshot()!.failure?.code).toBe('browser/not-found')
    vi.advanceTimersByTime(CLICK_REFRESH_DELAY_MS * 4)
    expect(mocks.screenshot).not.toHaveBeenCalled()
  })

  it('abort drops a pending post-click refresh', async () => {
    const { face, mocks, settle } = mount()
    const controller = new AbortController()
    face.begin(TAB, controller.signal)
    face.clickAt(TAB, 'bt-1', 100, 50, controller.signal)
    await settle('click', answer({}))
    controller.abort()
    vi.advanceTimersByTime(CLICK_REFRESH_DELAY_MS * 4)
    expect(mocks.screenshot).not.toHaveBeenCalled()
  })

  it('queues one refresh per settled click', async () => {
    const { face, mocks, settle } = mount()
    const signal = new AbortController().signal
    face.begin(TAB, signal)
    face.clickAt(TAB, 'bt-1', 100, 50, signal)
    face.clickAt(TAB, 'bt-1', 120, 60, signal)
    await settle('click', answer({}))
    await settle('click', answer({}))
    vi.advanceTimersByTime(CLICK_REFRESH_DELAY_MS)
    expect(mocks.screenshot).toHaveBeenCalledTimes(2)
  })

  it('a settlement after the record\'s abort writes nothing and schedules nothing', async () => {
    const { face, mocks, settle, snapshot } = mount()
    const controller = new AbortController()
    face.begin(TAB, controller.signal)
    face.setRunning(TAB, true, controller.signal)
    face.setRunning(TAB, false, controller.signal)
    face.submitUrl(TAB, 'bt-1', 'https://example.com/x', controller.signal)
    face.clickAt(TAB, 'bt-1', 100, 50, controller.signal)
    face.clickAt(TAB, 'bt-1', 120, 60, controller.signal)
    face.pressKey(TAB, 'bt-1', 'Enter', controller.signal)
    controller.abort()
    await settle('start', answer(RUNNING))
    await settle('stop', fail(new RemoteError('browser/unavailable', 'cannot stop', { baseUrl: BASE_URL })))
    await settle('navigate', fail(new RemoteError('browser/not-found', 'gone', { tabId: 'bt-1' })))
    await settle('click', answer({}))
    await settle('click', fail(new RemoteError('browser/not-found', 'gone', { tabId: 'bt-1' })))
    await settle('key', fail(new RemoteError('browser/unavailable', 'locked', { baseUrl: BASE_URL })))
    vi.advanceTimersByTime(CLICK_REFRESH_DELAY_MS * 4)
    expect(snapshot()).toBeUndefined()
    expect(mocks.screenshot).not.toHaveBeenCalled()
  })

  it('delivers wheel, key, and text gestures with their arguments and surfaces their failures', async () => {
    const { face, mocks, settle, snapshot } = mount()
    const signal = new AbortController().signal
    face.begin(TAB, signal)
    face.wheelAt(TAB, 'bt-1', 80, 60, 5, 120, signal)
    expect(mocks.wheel).toHaveBeenCalledWith('bt-1', 80, 60, 5, 120, signal)
    face.pressKey(TAB, 'bt-1', 'Enter', signal)
    expect(mocks.key).toHaveBeenCalledWith('bt-1', 'Enter', signal)
    face.typeText(TAB, 'bt-1', 'hello', signal)
    expect(mocks.typeText).toHaveBeenCalledWith('bt-1', 'hello', signal)
    await settle('wheel', answer(undefined))
    expect(snapshot()!.failure).toBeUndefined()
    await settle('key', fail(new RemoteError('browser/unavailable', 'locked', { baseUrl: BASE_URL })))
    expect(snapshot()!.failure).toEqual({ code: 'browser/unavailable', message: 'locked' })
    await settle('typeText', answer(undefined))
  })

  it('an assembly-fault rejection — the one path that still rejects — lands as an inline failure', async () => {
    const { face, mocks, snapshot } = mount()
    const signal = new AbortController().signal
    face.begin(TAB, signal)
    mocks.status.mockRejectedValueOnce(new Error('namespace not mounted'))
    face.refresh(TAB, signal)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(snapshot()!.failure).toEqual({ code: 'gateway/internal', message: 'Error: namespace not mounted' })
  })
})

describe('failureOf', () => {
  it('reads code and message off a RemoteError', () => {
    expect(failureOf(new RemoteError('browser/unavailable', 'no backend', { baseUrl: BASE_URL })))
      .toEqual({ code: 'browser/unavailable', message: 'no backend' })
  })

  it('reduces anything else to the carrier\'s unclassified code', () => {
    expect(failureOf(new Error('boom'))).toEqual({ code: 'gateway/internal', message: 'Error: boom' })
    expect(failureOf('nope')).toEqual({ code: 'gateway/internal', message: 'nope' })
    expect(failureOf({ code: 7, message: 'not strings' })).toEqual({ code: 'gateway/internal', message: '[object Object]' })
  })
})
