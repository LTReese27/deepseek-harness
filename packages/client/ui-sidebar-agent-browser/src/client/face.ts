/**
 * The pane's asynchronous half: calling the `browser` Remote namespace and
 * writing the outcomes into the store.
 *
 * The component never awaits anything. It asks the face to `refresh`, to
 * `capture`, or to deliver one take-over gesture, and this face performs the
 * Remote call and writes the outcome through the store's own actions — the
 * Slot-standard `inject` shape, so the write set stays the store's and tests
 * script the Remote face directly.
 *
 * Every generated Remote method resolves a `RemoteResult`: the carrier folds
 * the Host's `browser/*`-coded `RemoteError` into the error branch, and only
 * assembly faults (an unmounted method, a missing adapter) still reject. This
 * face turns either into store state — nothing throws past it, and the pane
 * renders the failure's message inline.
 *
 * One status poll and one frame fetch per tab have one answer in force: asking
 * again — the next poll tick, the prompt refresh after a click — retires the
 * call still in flight, whose settlement then writes nothing. Cleanup rides the
 * tab record's `signal`: no request is made for a record that already ended,
 * and when it goes away its bucket and generation bookkeeping are forgotten,
 * so no later settlement writes to it.
 */
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
// Merges the generated `browser` namespace into the Remote face.
import type {} from '@deepseek-ai/dsh-api-browser-controller/remote'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { createBrowserStore, BrowserFailure } from './store.ts'

/**
 * The slice of the Client Remote face this package calls: the `browser`
 * namespace's methods, exactly as the Host's generated client declares them.
 */
export type BrowserNamespace = Pick<ClientRemote['browser'],
  'status' | 'start' | 'stop' | 'screenshot' | 'openTab' | 'navigate' | 'click' | 'wheel' | 'key' | 'typeText'>

/** The Client Remote as this package sees it. */
export interface BrowserRemote {
  /** The `browser` namespace. */
  readonly browser: BrowserNamespace
}

/**
 * Delay between a delivered click and the prompt frame refresh: long enough
 * for the click's rendering to reach a screenshot, short enough to read as the
 * click's own result rather than the next 1 Hz poll tick. Fixed UI timing, not
 * a deployment choice.
 */
export const CLICK_REFRESH_DELAY_MS = 250

/**
 * Reduce a call failure to what the pane shows: the `RemoteError`'s code and
 * message as the wire carried them. Anything that is not a coded failure — a
 * rejection from the assembly layer, not the wire — is reported under the
 * carrier's unclassified code.
 * @param error - the failure branch's error, or a rejection (typed `unknown`).
 * @returns the code/message pair to render inline.
 */
export function failureOf(error: unknown): BrowserFailure {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    const { code, message } = error
    if (typeof code === 'string' && typeof message === 'string') return { code, message }
  }
  return { code: 'gateway/internal', message: String(error) }
}

/** One call's settlement: the resolved value, or the failure to show. */
type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: BrowserFailure }

/**
 * Settle one Remote call into an {@link Outcome}: the resolved `RemoteResult`
 * as it stands, or a caught assembly-fault rejection folded into the failure
 * branch — the one place a rejection can still escape the generated face.
 * @param call - the in-flight Remote call.
 * @returns the settlement; never rejects.
 */
async function settleCall<T>(call: Promise<RemoteResult<T>>): Promise<Outcome<T>> {
  try {
    const result = await call
    return result.ok ? { ok: true, value: result.value } : { ok: false, failure: failureOf(result.error) }
  } catch (error) {
    return { ok: false, failure: failureOf(error) }
  }
}

/** The pane's injected business face, as the body receives it. */
export interface BrowserInjected {
  /**
   * Seed this tab's view bucket; on the record's abort the bucket and its
   * bookkeeping are forgotten and pending follow-ups are dropped.
   * @param tabId - the sidebar tab being drawn.
   * @param signal - the tab record's lifetime.
   */
  readonly begin: (tabId: TabId, signal: AbortSignal) => void
  /**
   * Poll the browser status once.
   * @param tabId - the sidebar tab being drawn.
   * @param signal - the tab record's lifetime.
   */
  readonly refresh: (tabId: TabId, signal: AbortSignal) => void
  /**
   * Fetch one frame of one browser tab, keeping the previous frame until it lands.
   * @param tabId - the sidebar tab being drawn.
   * @param target - the browser tab to shoot; `undefined` asks for the active one.
   * @param signal - the tab record's lifetime.
   */
  readonly capture: (tabId: TabId, target: string | undefined, signal: AbortSignal) => void
  /**
   * Start or stop the browser, recording the returned status; the lifecycle
   * busy flag is up for the call's duration.
   * @param tabId - the sidebar tab being drawn.
   * @param run - `true` starts, `false` stops.
   * @param signal - the tab record's lifetime.
   */
  readonly setRunning: (tabId: TabId, run: boolean, signal: AbortSignal) => void
  /**
   * Send the address bar's URL: open it in a first tab when the browser has
   * none, navigate the given tab otherwise; a settled call prompts a status
   * refresh so the header catches up.
   * @param tabId - the sidebar tab being drawn.
   * @param target - the browser tab to navigate; `undefined` opens a new one.
   * @param url - the fully qualified URL to load.
   * @param signal - the tab record's lifetime.
   */
  readonly submitUrl: (tabId: TabId, target: string | undefined, url: string, signal: AbortSignal) => void
  /**
   * Deliver one click, then refresh the frame after {@link CLICK_REFRESH_DELAY_MS}
   * instead of waiting for the next poll tick.
   * @param tabId - the sidebar tab being drawn.
   * @param target - the browser tab clicked.
   * @param x - CSS viewport x of the click.
   * @param y - CSS viewport y of the click.
   * @param signal - the tab record's lifetime.
   */
  readonly clickAt: (tabId: TabId, target: string, x: number, y: number, signal: AbortSignal) => void
  /**
   * Deliver one scroll-wheel gesture.
   * @param tabId - the sidebar tab being drawn.
   * @param target - the browser tab scrolled.
   * @param x - CSS viewport x under the pointer.
   * @param y - CSS viewport y under the pointer.
   * @param deltaX - wheel delta x in pixels.
   * @param deltaY - wheel delta y in pixels.
   * @param signal - the tab record's lifetime.
   */
  readonly wheelAt: (tabId: TabId, target: string, x: number, y: number, deltaX: number, deltaY: number, signal: AbortSignal) => void
  /**
   * Deliver one named key (`Enter`, `Tab`, `Escape`, `Backspace`, `Arrow*`, …).
   * @param tabId - the sidebar tab being drawn.
   * @param target - the browser tab focused.
   * @param key - the `KeyboardEvent.key` name.
   * @param signal - the tab record's lifetime.
   */
  readonly pressKey: (tabId: TabId, target: string, key: string, signal: AbortSignal) => void
  /**
   * Type text into the focused element.
   * @param tabId - the sidebar tab being drawn.
   * @param target - the browser tab focused.
   * @param text - the characters to type.
   * @param signal - the tab record's lifetime.
   */
  readonly typeText: (tabId: TabId, target: string, text: string, signal: AbortSignal) => void
}

/**
 * Bind the pane's face to one Remote face.
 * @param remote - the Client Remote face carrying the `browser` namespace.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function browserFace(
  remote: BrowserRemote,
): (sessionId: string, actions: BoundActions<ReturnType<typeof createBrowserStore>>) => BrowserInjected {
  // The browser namespace is session-independent: the inject factory's session
  // id (branded where the session merge is in the program) is the framework's,
  // and this face never reads it — hence the erased `string` here.
  return (_sessionId: string, actions): BrowserInjected => {
    /** Per tab: the status generation a settlement must match; the latest poll wins. */
    const statusGens = new Map<TabId, number>()
    /** Per tab: the frame generation a settlement must match; the latest fetch wins. */
    const frameGens = new Map<TabId, number>()
    /** Per tab: the pending post-click refresh timers, cleared when the record ends. */
    const refreshTimers = new Map<TabId, Set<ReturnType<typeof setTimeout>>>()
    const nextGeneration = (gens: Map<TabId, number>, tabId: TabId): number => {
      const generation = (gens.get(tabId) ?? 0) + 1
      gens.set(tabId, generation)
      return generation
    }
    const live = (gens: Map<TabId, number>, tabId: TabId, generation: number, signal: AbortSignal): boolean =>
      !signal.aborted && gens.get(tabId) === generation
    const capture = (tabId: TabId, target: string | undefined, signal: AbortSignal): void => {
      if (signal.aborted) return
      const generation = nextGeneration(frameGens, tabId)
      void settleCall(remote.browser.screenshot(target, signal)).then((outcome) => {
        if (!live(frameGens, tabId, generation, signal)) return
        if (outcome.ok) actions.frameReceived(tabId, outcome.value)
        else actions.frameFailed(tabId, outcome.failure)
      })
    }
    const refresh = (tabId: TabId, signal: AbortSignal): void => {
      if (signal.aborted) return
      const generation = nextGeneration(statusGens, tabId)
      void settleCall(remote.browser.status(signal)).then((outcome) => {
        if (!live(statusGens, tabId, generation, signal)) return
        if (outcome.ok) actions.statusReceived(tabId, outcome.value)
        else actions.callFailed(tabId, outcome.failure)
      })
    }
    /** Failures of the one-way gestures surface the same way everywhere. */
    const settleGesture = (tabId: TabId, signal: AbortSignal, call: Promise<RemoteResult<unknown>>): void => {
      void settleCall(call).then((outcome) => {
        if (!outcome.ok && !signal.aborted) actions.callFailed(tabId, outcome.failure)
      })
    }
    return {
      begin(tabId, signal) {
        actions.begin(tabId)
        signal.addEventListener('abort', () => {
          statusGens.delete(tabId)
          frameGens.delete(tabId)
          for (const timer of refreshTimers.get(tabId) ?? []) clearTimeout(timer)
          refreshTimers.delete(tabId)
          actions.forget(tabId)
        }, { once: true })
      },
      refresh,
      capture,
      setRunning(tabId, run, signal) {
        if (signal.aborted) return
        actions.lifecycleBusy(tabId, true)
        void settleCall(run ? remote.browser.start(signal) : remote.browser.stop(signal)).then((outcome) => {
          if (signal.aborted) return
          actions.lifecycleBusy(tabId, false)
          if (outcome.ok) actions.statusReceived(tabId, outcome.value)
          else actions.callFailed(tabId, outcome.failure)
        })
      },
      submitUrl(tabId, target, url, signal) {
        if (signal.aborted) return
        const call = target === undefined
          ? remote.browser.openTab(url, signal)
          : remote.browser.navigate(target, url, signal)
        void settleCall(call).then((outcome) => {
          if (outcome.ok) refresh(tabId, signal)
          else if (!signal.aborted) actions.callFailed(tabId, outcome.failure)
        })
      },
      clickAt(tabId, target, x, y, signal) {
        if (signal.aborted) return
        void settleCall(remote.browser.click(target, x, y, signal)).then((outcome) => {
          if (signal.aborted) return
          if (!outcome.ok) {
            actions.callFailed(tabId, outcome.failure)
            return
          }
          const timers = refreshTimers.get(tabId) ?? new Set<ReturnType<typeof setTimeout>>()
          refreshTimers.set(tabId, timers)
          const timer = setTimeout(() => {
            timers.delete(timer)
            capture(tabId, target, signal)
          }, CLICK_REFRESH_DELAY_MS)
          timers.add(timer)
        })
      },
      wheelAt(tabId, target, x, y, deltaX, deltaY, signal) {
        if (signal.aborted) return
        settleGesture(tabId, signal, remote.browser.wheel(target, x, y, deltaX, deltaY, signal))
      },
      pressKey(tabId, target, key, signal) {
        if (signal.aborted) return
        settleGesture(tabId, signal, remote.browser.key(target, key, signal))
      },
      typeText(tabId, target, text, signal) {
        if (signal.aborted) return
        settleGesture(tabId, signal, remote.browser.typeText(target, text, signal))
      },
    }
  }
}
