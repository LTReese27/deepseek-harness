/**
 * Stage one of this package's registration: what the `browser` tab type IS.
 *
 * The type is a page, not a viewer: it claims no address. The guide page offers
 * it as an entry box, and the pane shows the one agent-driven browser the Host
 * runs for the session's machine — there is nothing to address beyond the type.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from './locales.ts'
import { IconGlobeOutline14, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** The tab kind this package owns. */
export const BROWSER_KIND = 'browser'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const BROWSER_ID = '@deepseek-ai/dsh-client-ui-sidebar-browser'

/** The type's globe glyph at the guide capsule's size. */
function GlobeGlyph({ size, className }: IconProps) {
  return <IconGlobeOutline14 size={size} className={className} />
}

/**
 * The browser type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function browserDefinition(t: TranslateNS<'sidebarBrowser'>): SidebarRightTabDefinition {
  return {
    id: BROWSER_ID,
    kind: BROWSER_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      order: 20,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: GlobeGlyph,
    }],
  }
}
