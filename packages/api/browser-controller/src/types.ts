/**
 * Wire types of the `browser` Remote namespace. Types only: generated Remote
 * clients consume this module without Host runtime code.
 *
 * The PinchTab bearer token never appears in this vocabulary: every value
 * crossing the namespace is safe to reach the browser client, and failure
 * details name configuration locations, never credentials.
 *
 * @module @deepseek-ai/dsh-api-browser-controller/types
 */

// Import the protocol module so the declaration at the end of this file
// augments its error map rather than defining an unrelated ambient module.
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** One browser tab as the Web GUI lists it. */
export interface BrowserTabInfo {
  /** PinchTab's tab id; addresses the tab in every tab-scoped call. */
  readonly id: string
  /** Current document title; empty when the page declares none. */
  readonly title: string
  /** Current document URL. */
  readonly url: string
  /** Whether PinchTab reports the tab's status as `active`. */
  readonly active: boolean
}

/** Reachability of the PinchTab server, with its tab list when it is up. */
export interface BrowserStatus {
  /**
   * Whether the server answered an authenticated health probe. False also
   * covers a server that has never run (no token file yet).
   */
  readonly running: boolean
  /** Open tabs at observation time; empty whenever the server is not running. */
  readonly tabs: BrowserTabInfo[]
}

/** One captured browser frame for the Web GUI's watch surface. */
export interface BrowserFrame {
  /** JPEG bytes, base64. Image pixels equal CSS viewport pixels (the host rescales by the configured device scale factor). */
  readonly data: string
  /** CSS viewport dimensions = image pixel dimensions. */
  readonly width: number
  /** CSS viewport dimensions = image pixel dimensions. */
  readonly height: number
  /** ms epoch when the host received the frame. */
  readonly takenAt: number
}

// PinchTab action failures additionally cross the wire as
// `browser/<PinchTab code>` (for example `browser/idpi_domain_blocked`,
// `browser/invalid_action_request`, `browser/error`). That family is
// open-ended upstream, so it cannot be enumerated in the map below; those
// failures carry the upstream message — with PinchTab's remedy text appended
// for IDPI allowlist refusals — and untyped `{}` details.
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * The PinchTab server cannot serve the call: it is unreachable, has never
     * run (no readable token file), rejected the bearer token, failed to
     * spawn, or did not converge inside the configured start/stop timeout.
     * The message names the operator remedy; the token never appears.
     */
    'browser/unavailable': { readonly baseUrl: string }
    /** The addressed tab does not exist, or no tab exists to address. */
    'browser/not-found': { readonly tabId?: string }
  }
}
