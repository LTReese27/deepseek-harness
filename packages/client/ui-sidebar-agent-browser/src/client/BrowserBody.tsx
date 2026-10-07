/**
 * The browser pane's body: a live, width-fitted picture of the agent-driven
 * browser, with the controls to start it, aim it, and take it over.
 *
 * Everything the pane keeps lives in its store, keyed by sidebar tab;
 * everything it asks for goes through its injected face. The component owns
 * only the cadence — a 2 s status poll and a 1 Hz frame fetch, both running
 * solely while the tab is `visible` — the address bar's draft, and what a
 * gesture means. Watch-only is the default: no click, wheel, or key leaves the
 * pane until the take-over toggle is explicitly on.
 *
 * Frame coordinates: the JPEG's pixels are the browser's CSS viewport pixels,
 * so a pointer offset in the rendered, pane-wide image scales by
 * `naturalWidth / clientWidth` back into viewport coordinates.
 */
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import clsx from 'clsx'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrowserInjected } from './face.ts'
import type {} from './locales.ts'
import type { createBrowserStore } from './store.ts'
import css from './BrowserBody.module.css'

/** The body's composed props: the tab it draws, its store, its face, and its copy. */
export type BrowserBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createBrowserStore>>
  & BrowserInjected
  & PropsLocale<'sidebarAgentBrowser'>

/** Status poll cadence while the tab is visible. Fixed UI timing, not a deployment choice. */
export const STATUS_INTERVAL_MS = 2000

/** Frame fetch cadence while the browser runs and the tab is visible: the ≈1 fps watch stream. */
export const FRAME_INTERVAL_MS = 1000

/** Keys forwarded as named keys rather than typed text. */
const HANDLED_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
])

/** An RFC 3986 scheme: what keeps the address bar from prepending `https://`. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/**
 * Whether the address bar's text already names its scheme.
 * @param url - the address as typed.
 * @returns whether `url` starts with a scheme (`https://…`, `about:`, …).
 */
export function hasScheme(url: string): boolean {
  return SCHEME.test(url)
}

/**
 * The browser pane's body.
 * @param props - the composed props shares.
 * @returns the pane's element tree; `null` until the tab's bucket is seeded.
 */
export function BrowserBody({
  useTabInfo, useStore, actions,
  begin, refresh, capture, setRunning, submitUrl, clickAt, wheelAt, pressKey, typeText, t,
}: BrowserBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const { id: tabId, signal, visible } = tab
  const state = useStore(store => store.byTab[tabId])
  const status = state?.status
  const running = status?.running === true
  const tabs = status?.tabs ?? []
  const activeTab = tabs.find(entry => entry.active) ?? tabs[0]
  const activeTabId = activeTab?.id
  const takeover = state?.takeover === true
  const viewRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  // The address bar's draft, keyed by the browser tab it was typed for: while
  // untouched the bar tracks the active tab's URL; a typed draft wins until it
  // is submitted or the active tab changes under it.
  const [draft, setDraft] = useState<{ readonly tab: string | undefined; readonly value: string }>()

  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (state !== undefined || signal.aborted) return
    begin(tabId, signal)
  }, [state, tabId, signal, begin])

  useEffect(() => {
    if (!visible || signal.aborted) return undefined
    refresh(tabId, signal)
    const timer = setInterval(() => { refresh(tabId, signal) }, STATUS_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [visible, tabId, signal, refresh])

  useEffect(() => {
    if (!visible || !running || activeTabId === undefined || signal.aborted) return undefined
    capture(tabId, activeTabId, signal)
    const timer = setInterval(() => { capture(tabId, activeTabId, signal) }, FRAME_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [visible, running, activeTabId, tabId, signal, capture])

  // React delegates `wheel` as a passive listener at the root, so a synthetic
  // onWheel cannot keep the pane from scrolling; the direct non-passive
  // listener can, and lives only while take-over is on. The view box mounts
  // with the first frame, so the frame's presence is a dependency.
  const frameOnScreen = state?.frame !== undefined
  useEffect(() => {
    const view = viewRef.current
    if (!takeover || !frameOnScreen || view === null || activeTabId === undefined) return undefined
    const onWheel = (event: WheelEvent): void => {
      const img = imgRef.current
      if (img === null || img.clientWidth === 0 || img.clientHeight === 0 || img.naturalWidth === 0) return
      event.preventDefault()
      wheelAt(
        tabId, activeTabId,
        Math.round(event.offsetX * (img.naturalWidth / img.clientWidth)),
        Math.round(event.offsetY * (img.naturalHeight / img.clientHeight)),
        event.deltaX, event.deltaY, signal,
      )
    }
    view.addEventListener('wheel', onWheel, { passive: false })
    return () => { view.removeEventListener('wheel', onWheel) }
  }, [takeover, frameOnScreen, activeTabId, tabId, signal, wheelAt])

  if (state === undefined) return null

  const onFrameClick = (event: ReactMouseEvent<HTMLImageElement>): void => {
    if (!takeover || activeTabId === undefined) return
    const img = event.currentTarget
    if (img.clientWidth === 0 || img.clientHeight === 0 || img.naturalWidth === 0) return
    clickAt(
      tabId, activeTabId,
      Math.round(event.nativeEvent.offsetX * (img.naturalWidth / img.clientWidth)),
      Math.round(event.nativeEvent.offsetY * (img.naturalHeight / img.clientHeight)),
      signal,
    )
  }

  const onViewKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!takeover || activeTabId === undefined) return
    if (event.target !== event.currentTarget) return
    if (HANDLED_KEYS.has(event.key)) {
      event.preventDefault()
      pressKey(tabId, activeTabId, event.key, signal)
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      typeText(tabId, activeTabId, event.key, signal)
    }
  }

  const addressText = draft !== undefined && draft.tab === activeTabId ? draft.value : (activeTab?.url ?? '')
  const onAddressKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    const raw = addressText.trim()
    if (raw === '') return
    event.preventDefault()
    setDraft(undefined)
    submitUrl(tabId, activeTabId, hasScheme(raw) ? raw : `https://${raw}`, signal)
  }

  const frameGone = state.frameGone
  return (
    <div className={css.root} data-browser-root>
      <div className={css.header}>
        <StateDot state={running ? 'ongoing' : 'idle'} className={css.dot} />
        <span className={css.statusText}>{running ? t('status.running') : t('status.down')}</span>
        {activeTab !== undefined && (
          <span className={css.tabTitle} title={activeTab.url} data-browser-tab>
            {activeTab.title || activeTab.url}
            {activeTab.title !== '' && activeTab.title !== activeTab.url && (
              <span className={css.tabUrl} data-browser-tab-url>{activeTab.url}</span>
            )}
          </span>
        )}
        <Button
          size="sm"
          className={css.lifecycle}
          disabled={state.lifecycleBusy}
          onClick={() => { setRunning(tabId, !running, signal) }}
          data-browser-lifecycle
        >
          {running ? t('action.stop') : t('action.start')}
        </Button>
        {running && tabs.length > 0 && (
          <span className={css.takeover} data-browser-takeover>
            <Switch
              checked={takeover}
              onChange={(on) => { actions.takeoverSet(tabId, on) }}
              label={t('takeover.label')}
            />
            <span className={css.takeoverText}>{t('takeover.label')}</span>
          </span>
        )}
      </div>
      {state.failure !== undefined && (
        <p className={css.failure} data-browser-failure={state.failure.code}>{state.failure.message}</p>
      )}
      {running && (
        <div className={css.bar}>
          <Input
            value={addressText}
            placeholder={t('url.placeholder')}
            aria-label={t('url.ariaLabel')}
            onChange={(event) => { setDraft({ tab: activeTabId, value: event.target.value }) }}
            onKeyDown={onAddressKeyDown}
            data-browser-url
          />
        </div>
      )}
      {status === undefined && (
        <div className={css.panel} data-browser-state="connecting">
          <p className={css.panelText}>{t('state.connecting')}</p>
        </div>
      )}
      {status !== undefined && !running && (
        <div className={css.panel} data-browser-state="down">
          <p className={css.panelText}>{t('state.down')}</p>
          <Button
            variant="primary"
            disabled={state.lifecycleBusy}
            onClick={() => { setRunning(tabId, true, signal) }}
            data-browser-start
          >
            {t('action.start')}
          </Button>
        </div>
      )}
      {running && tabs.length === 0 && (
        <div className={css.panel} data-browser-state="no-tabs">
          <p className={css.panelText}>{t('state.noTabs')}</p>
        </div>
      )}
      {running && tabs.length > 0 && state.frame === undefined && (
        <div className={css.panel} data-browser-state={frameGone ? 'no-tabs' : 'connecting'}>
          <p className={css.panelText}>{frameGone ? t('state.noTabs') : t('state.connecting')}</p>
        </div>
      )}
      {running && tabs.length > 0 && state.frame !== undefined && (
        <div
          ref={viewRef}
          tabIndex={0}
          className={clsx(css.view, takeover && css.viewTakeover)}
          onKeyDown={onViewKeyDown}
          data-browser-state="live"
          data-browser-takeover-active={takeover ? '' : undefined}
        >
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${state.frame.data}`}
            width={state.frame.width}
            height={state.frame.height}
            alt={t('frame.alt')}
            draggable={false}
            className={css.frame}
            onClick={onFrameClick}
            data-browser-frame
          />
          {takeover && <p className={css.hint} data-browser-hint>{t('takeover.hint')}</p>}
        </div>
      )}
    </div>
  )
}
