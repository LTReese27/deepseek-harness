---
description: "The right Sidebar's browser tab type for the dsh web client: a live ≈1 fps view of the agent-driven browser over the browser Remote namespace, with an explicit take-over for clicks, scrolling, keys, and navigation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-agent-browser

English | [中文](README.zh.md)

## Summary

The right Sidebar's browser tab type: the agent-driven browser the Host runs, watched live as a width-fitted screenshot stream (≈1 fps) over the `browser` Remote namespace of `@deepseek-ai/dsh-api-browser-controller`, with an explicit take-over toggle that turns the picture into the user's own controls. It is a page type reached from the guide and claims no address — there is one browser per host, so there is nothing to address.

## Table of Contents

- [What it registers](#what-it-registers)
- [The pane](#the-pane)
- [Take-over](#take-over)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

- **The type** — `ctx.sidebarRightTabs.register(...)` with kind `browser`, id `@deepseek-ai/dsh-client-ui-sidebar-agent-browser`, band `builtin`, no patterns, and one guide entry (order 20, its title and description from the `sidebarAgentBrowser` namespace, its glyph the shared globe icon) that opens the type.
- **The body** — the keyed `sidebar.right.pane.tab` seat under that id: a header row under the strip (status dot and word, the active tab's title, the Start/Stop lifecycle button, the take-over toggle), an inline failure line when the last call failed, the address bar whenever the browser runs, and below them the state area.
- **No chip title** — the `sidebar.right.pane.tab.title` seat is deliberately left unregistered: the tab's title is the type's static label, captured when the tab opens.

Seven source files under `src/client/`: `definition.tsx` (the type), `store.ts` (what it keeps), `face.ts` (how it calls the browser, Remote binding included), `BrowserBody.tsx` (what it draws), `locales.ts` (what it says), and `index.ts` (the wiring).

<a id="the-pane"></a>
## The pane

While the tab is `visible`, the body polls `status` every 2 s and, while the browser runs with at least one tab, fetches a frame of the active tab at 1 Hz; hiding the tab stops every poll, and showing it resumes both with an immediate call. A fetch in flight never blanks the picture — a new frame replaces the one on screen only when it lands. A frame fetch that reports `browser/not-found` drops the picture and draws the empty state until a frame lands again. Every Remote call settles as a `RemoteResult` whose error branch carries the Host's `browser/*`-coded failure; the face reduces it — or an assembly fault's rejection — to a code and a message rendered inline, and nothing throws past the component. All states are copy-owned: connecting, server down (explanation plus the prominent Start button), running with no tabs, and the live frame.

The address bar tracks the active tab's URL until the user types; Enter opens a first tab when the browser has none and navigates the active tab otherwise, prepending `https://` when the text has no scheme, and a settled call prompts a status refresh so the header catches up. Start and Stop disable themselves while their call is in flight and re-render from the returned status.

State lives in the type's own store, bucketed by sidebar tab id: `status`, `frame`, `failure`, the sticky `frameGone`, `takeover`, and `lifecycleBusy`. The owner's `signal` ends a bucket: on abort the tab is forgotten, generation guards retire in-flight polls, and a settlement afterwards writes nothing.

<a id="take-over"></a>
## Take-over

Watch-only is the default: the pane sends nothing the user did not explicitly ask for. The toggle in the header arms it; while on, the frame carries the brand-primary border and the crosshair cursor, the hint line says so, and the view box takes the keyboard focus. A click on the image maps its display offset back into CSS viewport pixels (`offsetX × naturalWidth / clientWidth` — the JPEG's pixels are the viewport's CSS pixels) and lands as `click`, with one frame refresh about 250 ms later rather than waiting for the next poll tick. Wheel gestures forward with the same mapping through a non-passive listener, so the pane does not scroll under the pointer. Named keys (`Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Arrow*`) land as `key`; single printable characters land as `typeText`; modified or unmapped keys stay home.

<a id="model-experience"></a>
## Model Experience

None, as this package draws the agent-driven browser in the web UI and registers nothing model-facing; the agent drives the same browser through the Host's own tools.

#### KV Cache effect

None; frames travel over the Remote and assemble no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Polling, not streaming.** The frame rate is a 1 Hz poll; there is no push channel, so fast page changes can skip intermediate states.
- **One tab, the active one.** The pane always shows the browser's active tab; there is no tab strip to pick another, and the address bar navigates the active tab or opens the first one.
- **Gestures only.** Take-over forwards clicks, wheel, and keys — no text selection, clipboard, drag-and-drop, file chooser, or pointer movement.
- **Memory-only.** Nothing is persisted; a reload returns every tab's view to the connecting state.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The wire contract (`browser` namespace methods, payload types, and `browser/*` failure codes) is owned by `@deepseek-ai/dsh-api-browser-controller`; this package imports its `/types` and the generated `/remote` declaration merge and adds nothing to either.

</details>

**Runtime invariant:** No companion is published. The pane's only runtime state is one Slot store per sidebar tab, written by the body that owns it and forgotten on the tab record's abort signal; there is no second observation of it to compare against.
