/**
 * Browser half: register `browser` as a right-Sidebar tab type.
 *
 * The public two-stage path, unmodified: the type into `ctx.sidebarRightTabs`,
 * the body into the keyed `sidebar.right.pane.tab` seat under the type's `id`.
 * The chip title seat is left unregistered on purpose: the tab's title is the
 * type's static label, captured when the tab opens.
 *
 * The file split is this package's layering: what the type IS
 * (`definition.tsx`), what it keeps (`store.ts`), how it calls the browser
 * (`face.ts`), what it draws (`BrowserBody.tsx`), what it says
 * (`locales.ts`), and this module, which only wires them together.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { BROWSER_ID, browserDefinition } from './definition.tsx'
import { browserFace } from './face.ts'
import { BrowserBody } from './BrowserBody.tsx'
import { en, zh } from './locales.ts'
import { createBrowserStore } from './store.ts'

export type { SidebarBrowserKey } from './locales.ts'
export type { BrowserFailure, BrowserState, BrowserTabState } from './store.ts'
export type { BrowserInjected, BrowserNamespace, BrowserRemote } from './face.ts'
export type { BrowserBodyProps } from './BrowserBody.tsx'

/** This package's copy namespace. */
const NS = 'sidebarBrowser'

/**
 * Required browser services: the tab registry, the keyed seat, the Remote
 * carrier and its `browser` namespace, and copy.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.browser']

/**
 * Client plugin body: register the type, its dictionaries, and its body.
 * @param ctx - client root context carrying the registry, the slots, and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(browserDefinition(t)), 'ui-sidebar-browser: browser type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar-browser: dictionaries')

  const store = createBrowserStore()
  const inject = browserFace(ctx.remote)
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: BROWSER_ID, locale: NS, store, inject },
    BrowserBody,
  )), 'ui-sidebar-browser: browser tab body')
}
