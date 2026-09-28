/**
 * The browser pane's view state: the last status, the frame on screen, the
 * take-over toggle, and the lifecycle busy flag.
 *
 * One bucket per sidebar tab id: two browser tabs in one session watch
 * independently, and each bucket lives from the face's `begin` until the tab
 * record's `signal` aborts, which is when `forget` runs.
 *
 * The frame is never cleared by a fetch starting: a new frame replaces it only
 * when one lands, so the picture does not flicker between polls. It is cleared
 * when the Host reports the shown tab is gone (`browser/not-found`), which is
 * the pane's cue to draw the no-tab state instead of a stale picture.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserFrame, BrowserStatus } from '@deepseek-ai/dsh-api-browser-controller/types'

/** One Remote call's failure, reduced to what the pane shows: its code and its message. */
export interface BrowserFailure {
  /** Stable failure code (`browser/unavailable`, `browser/not-found`, …). */
  readonly code: string
  /** Human diagnostic carried across the wire, rendered verbatim. */
  readonly message: string
}

/** One sidebar tab's view of the agent-driven browser. */
export interface BrowserTabState {
  /** The last status the Host reported; `undefined` until the first poll settles. */
  status: BrowserStatus | undefined
  /** The frame on screen; kept while the next fetch is in flight. */
  frame: BrowserFrame | undefined
  /** The most recent call failure to show inline; cleared by the next success. */
  failure: BrowserFailure | undefined
  /**
   * The frame fetch reported the shown tab gone (`browser/not-found`), so the
   * pane draws the empty state until a frame lands again. Sticky across status
   * polls, which clear `failure` but cannot put a picture back.
   */
  frameGone: boolean
  /** Take-over: off means watch-only — the pane sends nothing the user did not explicitly ask for. */
  takeover: boolean
  /** A `start`/`stop` call is in flight; the lifecycle button stays disabled meanwhile. */
  lifecycleBusy: boolean
}

/** Every sidebar tab's view state, keyed by tab id. */
export interface BrowserState {
  byTab: Record<TabId, BrowserTabState>
}

/**
 * One tab's bucket, which every writer after `begin` relies on: the face only
 * dispatches while the record's signal is live, and `forget` runs on its abort.
 * @param state - the draft.
 * @param tabId - the tab being written.
 * @returns the tab's view state.
 */
function bucket(state: BrowserState, tabId: TabId): BrowserTabState {
  const view = state.byTab[tabId]
  if (view === undefined) throw new Error(`ui-sidebar-browser: no view for tab "${tabId}"`)
  return view
}

/** The browser store's write set; every action names the sidebar tab it writes. */
type BrowserActions = {
  begin: (draft: BrowserState, tabId: TabId) => void
  forget: (draft: BrowserState, tabId: TabId) => void
  statusReceived: (draft: BrowserState, tabId: TabId, status: BrowserStatus) => void
  frameReceived: (draft: BrowserState, tabId: TabId, frame: BrowserFrame) => void
  frameFailed: (draft: BrowserState, tabId: TabId, failure: BrowserFailure) => void
  callFailed: (draft: BrowserState, tabId: TabId, failure: BrowserFailure) => void
  lifecycleBusy: (draft: BrowserState, tabId: TabId, busy: boolean) => void
  takeoverSet: (draft: BrowserState, tabId: TabId, on: boolean) => void
}

/**
 * Declare the browser pane's store.
 *
 * A factory rather than a shared handle: the registration declares it as an
 * exclusive store, so the framework mints one instance per session.
 * @returns the store handle to declare on the registration.
 */
export function createBrowserStore(): EngineStoreHandle<BrowserState, BrowserActions> {
  return defineStore({
    init: (): BrowserState => ({ byTab: {} }),
    actions: {
      /**
       * Seed one tab's view: nothing known, watch-only, nothing in flight.
       * @param d - draft state.
       * @param tabId - the sidebar tab being drawn.
       */
      begin: (d, tabId: TabId) => {
        d.byTab[tabId] = {
          status: undefined, frame: undefined, failure: undefined, frameGone: false, takeover: false, lifecycleBusy: false,
        }
      },
      /**
       * Forget one tab's view, for a tab record that is gone.
       * @param d - draft state.
       * @param tabId - the tab that went away.
       */
      forget: (d, tabId: TabId) => {
        d.byTab = Object.fromEntries(Object.entries(d.byTab).filter(([id]) => id !== tabId))
      },
      /**
       * Record a status answer; a settled status clears the shown failure.
       * @param d - draft state.
       * @param tabId - the sidebar tab being drawn.
       * @param status - the Host's report: running flag plus its tabs.
       */
      statusReceived: (d, tabId: TabId, status: BrowserStatus) => {
        const view = bucket(d, tabId)
        view.status = status
        view.failure = undefined
      },
      /**
       * Put a fresh frame on screen; a landed frame clears the shown failure.
       * @param d - draft state.
       * @param tabId - the sidebar tab being drawn.
       * @param frame - the JPEG frame and its CSS-pixel dimensions.
       */
      frameReceived: (d, tabId: TabId, frame: BrowserFrame) => {
        const view = bucket(d, tabId)
        view.frame = frame
        view.frameGone = false
        view.failure = undefined
      },
      /**
       * Record a frame fetch's failure. `browser/not-found` means the shown
       * tab is gone, so the stale frame leaves the screen with it.
       * @param d - draft state.
       * @param tabId - the sidebar tab being drawn.
       * @param failure - the settled call failure.
       */
      frameFailed: (d, tabId: TabId, failure: BrowserFailure) => {
        const view = bucket(d, tabId)
        view.failure = failure
        if (failure.code === 'browser/not-found') {
          view.frame = undefined
          view.frameGone = true
        }
      },
      /**
       * Record any other call's failure; the frame on screen stays.
       * @param d - draft state.
       * @param tabId - the sidebar tab being drawn.
       * @param failure - the settled call failure.
       */
      callFailed: (d, tabId: TabId, failure: BrowserFailure) => {
        bucket(d, tabId).failure = failure
      },
      /**
       * Mark a lifecycle call as in flight or settled.
       * @param d - draft state.
       * @param tabId - the sidebar tab being drawn.
       * @param busy - whether a `start`/`stop` call is in flight.
       */
      lifecycleBusy: (d, tabId: TabId, busy: boolean) => {
        bucket(d, tabId).lifecycleBusy = busy
      },
      /**
       * Flip the take-over toggle.
       * @param d - draft state.
       * @param tabId - the sidebar tab being drawn.
       * @param on - the state the user asked for.
       */
      takeoverSet: (d, tabId: TabId, on: boolean) => {
        bucket(d, tabId).takeover = on
      },
    },
  })
}
