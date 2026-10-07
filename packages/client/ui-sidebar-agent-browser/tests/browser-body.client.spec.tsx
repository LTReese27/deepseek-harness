// @vitest-environment jsdom
/**
 * The body against a scripted browser namespace.
 *
 * What is asserted is the watcher's contract: the pane asks for status the
 * moment it shows and every 2 s while visible, draws frames at 1 Hz without
 * blanking the one on screen, stops every poll the moment the tab hides, keeps
 * the user's hands off the browser until take-over is explicitly on, and then
 * maps a click's display offset back into CSS viewport pixels. The address bar
 * opens a first tab when the browser has none and navigates the active one
 * otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent } from '@testing-library/react'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { CLICK_REFRESH_DELAY_MS } from '../src/client/face.ts'
import { FRAME_INTERVAL_MS, hasScheme, STATUS_INTERVAL_MS } from '../src/client/BrowserBody.tsx'
import { zh } from '../src/client/locales.ts'
import { mountBody, TAB } from './mount.client.tsx'
import { answer, DOWN, fail, frame, RUNNING } from './scripted-browser.client.ts'

/** The PinchTab server address the failure details carry. */
const BASE_URL = 'http://127.0.0.1:9867'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Stub the rendered/natural pixel ratio on one image element. */
function stubImageScale(img: HTMLImageElement, natural: [number, number], client: [number, number]): void {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: natural[0] })
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: natural[1] })
  Object.defineProperty(img, 'clientWidth', { configurable: true, value: client[0] })
  Object.defineProperty(img, 'clientHeight', { configurable: true, value: client[1] })
}

describe('BrowserBody states', () => {
  it('polls status on show, reads connecting until it settles, then draws the down state with a prominent Start', async () => {
    const { view, script } = mountBody()
    expect(script.mocks.status).toHaveBeenCalledTimes(1)
    expect(script.mocks.status).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(view.container.querySelector('[data-browser-state="connecting"]')?.textContent).toBe(zh['state.connecting'])
    await act(() => script.settle('status', answer(DOWN)))
    const down = view.container.querySelector('[data-browser-state="down"]')
    expect(down?.textContent).toContain(zh['state.down'])
    const start = view.container.querySelector('[data-browser-start]')
    expect(start?.textContent).toBe(zh['action.start'])
    // The header reads down as well: grey dot's word, and the small lifecycle button.
    expect(view.container.querySelector('[data-browser-lifecycle]')?.textContent).toBe(zh['action.start'])
  })

  it('clicking Start calls start, stays disabled while the call is in flight, and re-renders on the returned status', async () => {
    const { view, script, instance } = mountBody()
    await act(() => script.settle('status', answer(DOWN)))
    act(() => { fireEvent.click(view.container.querySelector('[data-browser-start]')!) })
    expect(script.mocks.start).toHaveBeenCalledTimes(1)
    expect(instance.getSnapshot().byTab[TAB]?.lifecycleBusy).toBe(true)
    expect(view.container.querySelector('[data-browser-start]')).toHaveProperty('disabled', true)
    await act(() => script.settle('start', answer(RUNNING)))
    expect(instance.getSnapshot().byTab[TAB]?.lifecycleBusy).toBe(false)
    // The returned status drives the render: the header names the active tab and offers Stop.
    expect(view.container.querySelector('[data-browser-tab]')?.childNodes[0]?.textContent).toBe('Example')
    expect(view.container.querySelector('[data-browser-tab-url]')?.textContent).toBe('https://example.com/')
    expect(view.container.querySelector('[data-browser-lifecycle]')?.textContent).toBe(zh['action.stop'])
    // A running browser with a tab starts the frame loop.
    expect(script.mocks.screenshot).toHaveBeenCalledTimes(1)
  })

  it('stops from the header lifecycle button', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle('status', answer(RUNNING)))
    await act(() => script.settle('screenshot', answer(frame('frame-a'))))
    act(() => { fireEvent.click(view.container.querySelector('[data-browser-lifecycle]')!) })
    expect(script.mocks.stop).toHaveBeenCalledTimes(1)
    await act(() => script.settle('stop', answer(DOWN)))
    expect(view.container.querySelector('[data-browser-lifecycle]')?.textContent).toBe(zh['action.start'])
    expect(view.container.querySelector('[data-browser-state="down"]')).not.toBeNull()
  })

  it('falls back to the URL when the active tab has no title yet, and never shows the URL twice', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle('status', answer({
      running: true,
      tabs: [{ id: 'bt-9', title: '', url: 'https://bare.example/', active: true }],
    })))
    expect(view.container.querySelector('[data-browser-tab]')?.textContent).toBe('https://bare.example/')
    expect(view.container.querySelector('[data-browser-tab-url]')).toBeNull()
    // A title that already is the URL draws no second copy either.
    act(() => { vi.advanceTimersByTime(STATUS_INTERVAL_MS) })
    await act(() => script.settle('status', answer({
      running: true,
      tabs: [{ id: 'bt-9', title: 'https://bare.example/', url: 'https://bare.example/', active: true }],
    })))
    expect(view.container.querySelector('[data-browser-tab]')?.textContent).toBe('https://bare.example/')
    expect(view.container.querySelector('[data-browser-tab-url]')).toBeNull()
  })

  it('renders a start failure inline and keeps the pane alive', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle('status', answer(DOWN)))
    act(() => { fireEvent.click(view.container.querySelector('[data-browser-start]')!) })
    await act(() => script.settle('start', fail(new RemoteError('browser/unavailable', 'no browser backend on this host', { baseUrl: BASE_URL }))))
    const failure = view.container.querySelector('[data-browser-failure]')
    expect(failure?.getAttribute('data-browser-failure')).toBe('browser/unavailable')
    expect(failure?.textContent).toBe('no browser backend on this host')
    expect(view.container.querySelector('[data-browser-start]')).toHaveProperty('disabled', false)
    // The next settled status clears the note.
    act(() => { vi.advanceTimersByTime(STATUS_INTERVAL_MS) })
    await act(() => script.settle('status', answer(DOWN)))
    expect(view.container.querySelector('[data-browser-failure]')).toBeNull()
  })

  it('draws the no-tabs empty state while a running browser holds no tab', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle('status', answer({ running: true, tabs: [] })))
    expect(view.container.querySelector('[data-browser-state="no-tabs"]')?.textContent).toBe(zh['state.noTabs'])
    // No tab, no frame loop.
    expect(script.mocks.screenshot).not.toHaveBeenCalled()
  })
})

describe('BrowserBody frames', () => {
  it('renders frames while visible, keeps the old frame during a refetch, and stops every poll once hidden', async () => {
    const { view, script, setVisible, rerender } = mountBody()
    await act(() => script.settle('status', answer(RUNNING)))
    expect(script.mocks.screenshot).toHaveBeenCalledTimes(1)
    expect(script.mocks.screenshot).toHaveBeenLastCalledWith('bt-1', expect.any(AbortSignal))
    await act(() => script.settle('screenshot', answer(frame('frame-a'))))
    const img = view.container.querySelector('[data-browser-frame]')
    expect(img?.getAttribute('src')).toBe('data:image/jpeg;base64,frame-a')
    expect(img?.getAttribute('alt')).toBe(zh['frame.alt'])

    // The 1 Hz tick fetches again; the frame on screen stays until it lands.
    act(() => { vi.advanceTimersByTime(FRAME_INTERVAL_MS) })
    expect(script.mocks.screenshot).toHaveBeenCalledTimes(2)
    expect(view.container.querySelector('[data-browser-frame]')?.getAttribute('src')).toBe('data:image/jpeg;base64,frame-a')
    await act(() => script.settle('screenshot', answer(frame('frame-b'))))
    expect(view.container.querySelector('[data-browser-frame]')?.getAttribute('src')).toBe('data:image/jpeg;base64,frame-b')

    // The status poll keeps its own 2 s cadence meanwhile.
    act(() => { vi.advanceTimersByTime(STATUS_INTERVAL_MS) })
    expect(script.mocks.status).toHaveBeenCalledTimes(2)

    // Hidden: every poll stops, however much time passes.
    setVisible(false)
    rerender()
    const statusCalls = script.mocks.status.mock.calls.length
    const frameCalls = script.mocks.screenshot.mock.calls.length
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(script.mocks.status).toHaveBeenCalledTimes(statusCalls)
    expect(script.mocks.screenshot).toHaveBeenCalledTimes(frameCalls)

    // Visible again: both loops resume with an immediate call.
    setVisible(true)
    rerender()
    expect(script.mocks.status).toHaveBeenCalledTimes(statusCalls + 1)
    expect(script.mocks.screenshot).toHaveBeenCalledTimes(frameCalls + 1)
  })

  it('draws the empty state when the frame fetch reports the tab gone', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle('status', answer(RUNNING)))
    await act(() => script.settle('screenshot', answer(frame('frame-a'))))
    expect(view.container.querySelector('[data-browser-frame]')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(FRAME_INTERVAL_MS) })
    await act(() => script.settle('screenshot', fail(new RemoteError('browser/not-found', 'the tab is gone', { tabId: 'bt-1' }))))
    expect(view.container.querySelector('[data-browser-frame]')).toBeNull()
    expect(view.container.querySelector('[data-browser-state="no-tabs"]')?.textContent).toBe(zh['state.noTabs'])
    expect(view.container.querySelector('[data-browser-failure]')?.textContent).toBe('the tab is gone')
  })
})

describe('BrowserBody address bar', () => {
  it('opens a first tab when the browser has none, prepending https:// to a bare host', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle('status', answer({ running: true, tabs: [] })))
    const input = view.container.querySelector<HTMLInputElement>('[data-browser-url]')!
    expect(input.getAttribute('aria-label')).toBe(zh['url.ariaLabel'])
    expect(input.getAttribute('placeholder')).toBe(zh['url.placeholder'])
    fireEvent.change(input, { target: { value: 'example.org' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(script.mocks.openTab).toHaveBeenCalledTimes(1)
    expect(script.mocks.openTab).toHaveBeenCalledWith('https://example.org', expect.any(AbortSignal))
    expect(script.mocks.navigate).not.toHaveBeenCalled()
  })

  it('navigates the active tab otherwise and keeps a schemed address untouched', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle('status', answer(RUNNING)))
    const input = view.container.querySelector<HTMLInputElement>('[data-browser-url]')!
    // The bar tracks the active tab's URL until the user types.
    expect(input.value).toBe('https://example.com/')
    fireEvent.change(input, { target: { value: 'http://example.com/next' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(script.mocks.navigate).toHaveBeenCalledTimes(1)
    expect(script.mocks.navigate).toHaveBeenCalledWith('bt-1', 'http://example.com/next', expect.any(AbortSignal))
    expect(script.mocks.openTab).not.toHaveBeenCalled()
    // A settled navigation prompts a status refresh so the header catches up.
    await act(() => script.settle('navigate', answer({ url: 'http://example.com/next' })))
    expect(script.mocks.status).toHaveBeenCalledTimes(2)
  })

  it('ignores an empty or whitespace-only address, and keys that are not Enter', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle('status', answer(RUNNING)))
    const input = view.container.querySelector<HTMLInputElement>('[data-browser-url]')!
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(script.mocks.navigate).not.toHaveBeenCalled()
    expect(script.mocks.openTab).not.toHaveBeenCalled()
  })
})

describe('BrowserBody take-over', () => {
  it('sends nothing while take-over is off', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle('status', answer(RUNNING)))
    await act(() => script.settle('screenshot', answer(frame('frame-a'))))
    const img = view.container.querySelector('[data-browser-frame]')!
    fireEvent.click(img, { clientX: 50, clientY: 25 })
    fireEvent.keyDown(view.container.querySelector('[data-browser-state="live"]')!, { key: 'Enter' })
    fireEvent.keyDown(view.container.querySelector('[data-browser-state="live"]')!, { key: 'a' })
    expect(script.mocks.click).not.toHaveBeenCalled()
    expect(script.mocks.key).not.toHaveBeenCalled()
    expect(script.mocks.typeText).not.toHaveBeenCalled()
    expect(script.mocks.wheel).not.toHaveBeenCalled()
  })

  it('ignores a click or wheel it cannot map to viewport pixels', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle('status', answer(RUNNING)))
    await act(() => script.settle('screenshot', answer(frame('frame-a'))))
    act(() => { fireEvent.click(view.container.querySelector('[data-browser-takeover] button')!) })
    const img = view.container.querySelector<HTMLImageElement>('[data-browser-frame]')!
    // jsdom reports zero dimensions, so there is no scale to map with.
    fireEvent.click(img, { clientX: 50, clientY: 25 })
    fireEvent.wheel(view.container.querySelector('[data-browser-state="live"]')!, { clientX: 40, clientY: 30, deltaY: 120 })
    expect(script.mocks.click).not.toHaveBeenCalled()
    expect(script.mocks.wheel).not.toHaveBeenCalled()
  })

  it('maps a click\'s display offset into CSS viewport pixels and refetches the frame promptly', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle('status', answer(RUNNING)))
    await act(() => script.settle('screenshot', answer(frame('frame-a'))))
    const img = view.container.querySelector<HTMLImageElement>('[data-browser-frame]')!
    // The 800×600 viewport is rendered pane-wide at half size.
    stubImageScale(img, [800, 600], [400, 300])
    act(() => { fireEvent.click(view.container.querySelector('[data-browser-takeover] button')!) })
    expect(view.container.querySelector('[data-browser-state="live"]')?.hasAttribute('data-browser-takeover-active')).toBe(true)
    expect(view.container.querySelector('[data-browser-hint]')?.textContent).toBe(zh['takeover.hint'])

    const frameCalls = script.mocks.screenshot.mock.calls.length
    fireEvent.click(img, { clientX: 50, clientY: 25 })
    expect(script.mocks.click).toHaveBeenCalledTimes(1)
    expect(script.mocks.click.mock.calls[0]?.[0]).toBe('bt-1')
    expect(script.mocks.click.mock.calls[0]?.[1]).toBe(100)
    expect(script.mocks.click.mock.calls[0]?.[2]).toBe(50)
    // No refetch before the click settles, and none before the delay has run.
    act(() => { vi.advanceTimersByTime(CLICK_REFRESH_DELAY_MS) })
    expect(script.mocks.screenshot).toHaveBeenCalledTimes(frameCalls)
    await act(() => script.settle('click', answer({})))
    act(() => { vi.advanceTimersByTime(CLICK_REFRESH_DELAY_MS - 1) })
    expect(script.mocks.screenshot).toHaveBeenCalledTimes(frameCalls)
    act(() => { vi.advanceTimersByTime(1) })
    expect(script.mocks.screenshot).toHaveBeenCalledTimes(frameCalls + 1)
    expect(script.mocks.screenshot).toHaveBeenLastCalledWith('bt-1', expect.any(AbortSignal))
  })

  it('forwards named keys and typed characters, but not modified or unmapped keys', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle('status', answer(RUNNING)))
    await act(() => script.settle('screenshot', answer(frame('frame-a'))))
    act(() => { fireEvent.click(view.container.querySelector('[data-browser-takeover] button')!) })
    const live = view.container.querySelector('[data-browser-state="live"]')!
    fireEvent.keyDown(live, { key: 'Enter' })
    expect(script.mocks.key).toHaveBeenCalledWith('bt-1', 'Enter', expect.any(AbortSignal))
    fireEvent.keyDown(live, { key: 'ArrowDown' })
    expect(script.mocks.key).toHaveBeenCalledWith('bt-1', 'ArrowDown', expect.any(AbortSignal))
    fireEvent.keyDown(live, { key: 'a' })
    expect(script.mocks.typeText).toHaveBeenCalledWith('bt-1', 'a', expect.any(AbortSignal))
    const keyCalls = script.mocks.key.mock.calls.length
    const typeCalls = script.mocks.typeText.mock.calls.length
    fireEvent.keyDown(live, { key: 'a', ctrlKey: true })
    fireEvent.keyDown(live, { key: 'a', metaKey: true })
    fireEvent.keyDown(live, { key: 'F5' })
    // A key targeted at a nested element — the image — is not the view's to forward.
    fireEvent.keyDown(view.container.querySelector('[data-browser-frame]')!, { key: 'b' })
    expect(script.mocks.key).toHaveBeenCalledTimes(keyCalls)
    expect(script.mocks.typeText).toHaveBeenCalledTimes(typeCalls)
  })

  it('forwards a wheel gesture with scaled coordinates', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle('status', answer(RUNNING)))
    await act(() => script.settle('screenshot', answer(frame('frame-a'))))
    const img = view.container.querySelector<HTMLImageElement>('[data-browser-frame]')!
    stubImageScale(img, [800, 600], [400, 300])
    act(() => { fireEvent.click(view.container.querySelector('[data-browser-takeover] button')!) })
    const live = view.container.querySelector('[data-browser-state="live"]')!
    fireEvent.wheel(live, { clientX: 40, clientY: 30, deltaX: 5, deltaY: 120 })
    expect(script.mocks.wheel).toHaveBeenCalledTimes(1)
    expect(script.mocks.wheel.mock.calls[0]?.slice(0, 5)).toEqual(['bt-1', 80, 60, 5, 120])
  })
})

describe('hasScheme', () => {
  it('accepts schemes and refuses bare hosts and paths', () => {
    expect(hasScheme('https://example.com')).toBe(true)
    expect(hasScheme('http://localhost:3000')).toBe(true)
    expect(hasScheme('about:blank')).toBe(true)
    expect(hasScheme('example.com')).toBe(false)
    expect(hasScheme('localhost')).toBe(false)
    expect(hasScheme('/index.html')).toBe(false)
  })
})
