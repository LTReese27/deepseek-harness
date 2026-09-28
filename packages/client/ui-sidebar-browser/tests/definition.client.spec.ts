// @vitest-environment jsdom
/**
 * Stage one, as the registry sees it: the type is a page that claims no
 * address, sits in the builtin band, and offers the guide page one entry that
 * opens its kind.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import {
  BROWSER_ID, BROWSER_KIND, browserDefinition,
} from '../src/client/definition.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)

afterEach(cleanup)

describe('browserDefinition', () => {
  it('registers under its kind and id and claims no address', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(browserDefinition(t))
    expect(registry.get(BROWSER_KIND)?.id).toBe(BROWSER_ID)
    expect(registry.candidates('dsh-resource://file/session/s1/anywhere/page.html')).toEqual([])
  })

  it('offers the guide page one entry at order 20 that opens the browser kind', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(browserDefinition(t))
    const [entry, ...rest] = registry.guide()
    expect(rest).toEqual([])
    expect(entry?.order).toBe(20)
    expect(entry?.kind).toBe(BROWSER_KIND)
    expect(entry?.title()).toBe(zh['guide.title'])
    expect(entry?.description?.()).toBe(zh['guide.description'])
    if (entry?.icon === undefined) throw new Error('expected the guide icon')
    const icon = render(createElement(entry.icon, { size: 26 }))
    expect(icon.container.querySelector('svg')?.getAttribute('width')).toBe('26')
  })

  it('sits in the builtin band and titles itself from the dictionary', () => {
    const definition = browserDefinition(t)
    expect(definition.priority).toBe('builtin')
    expect(definition.patterns).toBeUndefined()
    expect(definition.title('')).toBe(zh['type.label'])
  })
})
