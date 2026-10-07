/**
 * The pane's write set, one sidebar tab at a time.
 *
 * The load-bearing facts: a fetch in flight never blanks the frame on screen
 * (only a landed frame replaces it), a `browser/not-found` frame failure both
 * drops the picture and sticks the empty state until a frame lands again, and
 * a settled status clears the shown failure without touching the frame.
 */
import { describe, expect, it } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createBrowserStore } from '../src/client/store.ts'
import { DOWN, frame, RUNNING } from './scripted-browser.client.ts'

const TAB = 'tab-1' as TabId

describe('createBrowserStore', () => {
  it('mints an independent instance per call', () => {
    const first = createBrowserStore().create()
    const second = createBrowserStore().create()
    first.actions.begin(TAB)
    expect(second.getSnapshot().byTab[TAB]).toBeUndefined()
  })

  it('seeds a tab watch-only with nothing known and nothing in flight', () => {
    const store = createBrowserStore().create()
    store.actions.begin(TAB)
    expect(store.getSnapshot().byTab[TAB]).toEqual({
      status: undefined, frame: undefined, failure: undefined, frameGone: false, takeover: false, lifecycleBusy: false,
    })
  })

  it('records a status and clears the shown failure with it', () => {
    const store = createBrowserStore().create()
    const { actions } = store
    actions.begin(TAB)
    actions.callFailed(TAB, { code: 'browser/unavailable', message: 'no backend' })
    actions.statusReceived(TAB, RUNNING)
    expect(store.getSnapshot().byTab[TAB]!.status).toBe(RUNNING)
    expect(store.getSnapshot().byTab[TAB]!.failure).toBeUndefined()
  })

  it('replaces the frame only when one lands, and clears the gone flag with it', () => {
    const store = createBrowserStore().create()
    const { actions } = store
    actions.begin(TAB)
    actions.frameReceived(TAB, frame('a'))
    expect(store.getSnapshot().byTab[TAB]!.frame).toEqual(frame('a'))
    // A failure from another call leaves the picture alone.
    actions.callFailed(TAB, { code: 'browser/unauthorized', message: 'nope' })
    expect(store.getSnapshot().byTab[TAB]!.frame).toEqual(frame('a'))
    expect(store.getSnapshot().byTab[TAB]!.failure).toEqual({ code: 'browser/unauthorized', message: 'nope' })
    actions.frameReceived(TAB, frame('b'))
    expect(store.getSnapshot().byTab[TAB]!.frame).toEqual(frame('b'))
    expect(store.getSnapshot().byTab[TAB]!.failure).toBeUndefined()
  })

  it('a not-found frame failure drops the picture and sticks the empty state until a frame lands', () => {
    const store = createBrowserStore().create()
    const { actions } = store
    actions.begin(TAB)
    actions.frameReceived(TAB, frame('a'))
    actions.frameFailed(TAB, { code: 'browser/not-found', message: 'gone' })
    expect(store.getSnapshot().byTab[TAB]!.frame).toBeUndefined()
    expect(store.getSnapshot().byTab[TAB]!.frameGone).toBe(true)
    // A settled status clears the note but cannot put a picture back.
    actions.statusReceived(TAB, RUNNING)
    expect(store.getSnapshot().byTab[TAB]!.failure).toBeUndefined()
    expect(store.getSnapshot().byTab[TAB]!.frameGone).toBe(true)
    actions.frameReceived(TAB, frame('b'))
    expect(store.getSnapshot().byTab[TAB]!.frameGone).toBe(false)
  })

  it('an ordinary frame failure keeps the picture on screen', () => {
    const store = createBrowserStore().create()
    const { actions } = store
    actions.begin(TAB)
    actions.frameReceived(TAB, frame('a'))
    actions.frameFailed(TAB, { code: 'browser/unavailable', message: 'backend hiccup' })
    expect(store.getSnapshot().byTab[TAB]!.frame).toEqual(frame('a'))
    expect(store.getSnapshot().byTab[TAB]!.frameGone).toBe(false)
    expect(store.getSnapshot().byTab[TAB]!.failure?.code).toBe('browser/unavailable')
  })

  it('tracks the lifecycle busy flag and the take-over toggle', () => {
    const store = createBrowserStore().create()
    const { actions } = store
    actions.begin(TAB)
    actions.lifecycleBusy(TAB, true)
    expect(store.getSnapshot().byTab[TAB]!.lifecycleBusy).toBe(true)
    actions.lifecycleBusy(TAB, false)
    expect(store.getSnapshot().byTab[TAB]!.lifecycleBusy).toBe(false)
    actions.takeoverSet(TAB, true)
    expect(store.getSnapshot().byTab[TAB]!.takeover).toBe(true)
    actions.takeoverSet(TAB, false)
    expect(store.getSnapshot().byTab[TAB]!.takeover).toBe(false)
  })

  it('refuses to write a view for a tab that was never begun', () => {
    const { actions } = createBrowserStore().create()
    expect(() => { actions.statusReceived('tab-nowhere' as TabId, DOWN) }).toThrow('no view for tab "tab-nowhere"')
  })

  it('forget removes exactly the tab that went away', () => {
    const store = createBrowserStore().create()
    const { actions } = store
    actions.begin(TAB)
    actions.begin('tab-2' as TabId)
    actions.forget(TAB)
    expect(Object.keys(store.getSnapshot().byTab)).toEqual(['tab-2'])
  })
})
