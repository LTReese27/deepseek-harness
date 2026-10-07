/**
 * Mount the body over a real store instance and a scripted browser namespace.
 *
 * The component reads a handful of its props; the rest of the standard kit is
 * framework-injected and never touched here, so one documented cast keeps the
 * harness to what is actually exercised. `visible` sits behind a holder so a
 * spec can flip it and re-render, which is the gesture that must stop every
 * poll.
 */
import { useSyncExternalStore } from 'react'
import { render } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SidebarRightTabActions } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { browserFace } from '../src/client/face.ts'
import type { BrowserInjected } from '../src/client/face.ts'
import { BrowserBody } from '../src/client/BrowserBody.tsx'
import type { BrowserBodyProps } from '../src/client/BrowserBody.tsx'
import { zh } from '../src/client/locales.ts'
import { createBrowserStore } from '../src/client/store.ts'
import { scriptedBrowser } from './scripted-browser.client.ts'
import type { ScriptedBrowser } from './scripted-browser.client.ts'

export const SESSION = 's-test'
export const TAB = 'tab-1' as TabId

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S {
    return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot))
  }
}

/** A live instance of the pane's store, as the framework would mint one per session. */
type BrowserStoreInstance = ReturnType<ReturnType<typeof createBrowserStore>['create']>

/** The owner's tab actions as recording mocks. */
interface MockedTabActions {
  readonly openResource: Mock<SidebarRightTabActions['openResource']>
  readonly openTab: Mock<SidebarRightTabActions['openTab']>
  readonly close: Mock<SidebarRightTabActions['close']>
}

/** What a spec holds after mounting: the rendered view and every hand on the pane. */
export interface Mounted {
  readonly view: RenderResult
  readonly instance: BrowserStoreInstance
  readonly script: ScriptedBrowser
  readonly face: BrowserInjected
  readonly controller: AbortController
  readonly tabActions: MockedTabActions
  /** Flip what `useTabInfo().tab.visible` reports; takes effect on the next {@link Mounted.rerender}. */
  readonly setVisible: (visible: boolean) => void
  /** Re-render with the same prop share, picking up a flipped `visible`. */
  readonly rerender: () => void
}

/** One store instance, one face, one owner share. */
function harness(visible: boolean) {
  const instance = createBrowserStore().create()
  const script = scriptedBrowser()
  const face = browserFace(script.remote)(SESSION, instance.actions)
  const controller = new AbortController()
  const holder = { visible }
  const tabActions: MockedTabActions = {
    openResource: vi.fn<SidebarRightTabActions['openResource']>(),
    openTab: vi.fn<SidebarRightTabActions['openTab']>(),
    close: vi.fn<SidebarRightTabActions['close']>(),
  }
  const shared = {
    // A page tab's address is the shell's to mint; the body never reads it.
    useTabInfo: () => ({
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'pane-1' },
      tab: {
        id: TAB, kind: 'agent-browser', contentId: 'agent-browser', title: zh['type.label'], visible: holder.visible,
        navigation: { address: 'agent-browser', params: undefined, revision: 1 },
        signal: controller.signal,
        actions: tabActions,
      },
    }),
    sessionId: SESSION,
    useStore: hookOf(instance),
    actions: instance.actions,
    ...face,
    t: makeTranslate(zh),
  }
  return {
    instance, script, face, controller, tabActions,
    setVisible: (next: boolean) => { holder.visible = next },
    shared,
  }
}

/**
 * Mount the body.
 * @param visible - what the tab record reports; `false` for a hidden body.
 */
export function mountBody(visible = true): Mounted {
  const { shared, ...hands } = harness(visible)
  const view = render(<BrowserBody {...shared as unknown as BrowserBodyProps} />)
  return { ...hands, view, rerender: () => { view.rerender(<BrowserBody {...shared as unknown as BrowserBodyProps} />) } }
}
