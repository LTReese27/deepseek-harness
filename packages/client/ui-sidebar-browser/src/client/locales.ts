/**
 * `sidebarBrowser` namespace dictionaries, and the namespace's declaration.
 *
 * The copy covers the four pane states (connecting, server down, running with
 * no tab, live frame), the two lifecycle actions, the address bar, and the
 * take-over toggle with its hint. Wire data — the failure message the Host
 * sends, tab titles, URLs — renders verbatim and owns no key here.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'sidebarBrowser'>` or `PropsLocale<'sidebarBrowser'>` needs only
 * this file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Browser-viewer type name, guide entry, pane states, and take-over copy. */
    sidebarBrowser: SidebarBrowserKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': '浏览器',
  'guide.title': '智能体浏览器',
  'guide.description': '实时观看智能体使用的浏览器，需要时可以接管',
  'state.connecting': '正在连接浏览器…',
  'state.down': '浏览器没有运行。启动后，这里会实时显示智能体浏览网页的画面。',
  'state.noTabs': '智能体开始浏览时会自动打开标签页——也可以在上方输入网址。',
  'status.running': '运行中',
  'status.down': '未运行',
  'action.start': '启动',
  'action.stop': '停止',
  'url.placeholder': '输入网址后按回车',
  'url.ariaLabel': '浏览器地址栏',
  'takeover.label': '接管浏览器',
  'takeover.hint': '已接管：点击、滚动和键盘输入都会直接发送给浏览器。',
  'frame.alt': '浏览器视口画面',
} satisfies Record<string, string>

/** Browser dictionary key union. */
export type SidebarBrowserKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Browser',
  'guide.title': 'Agent browser',
  'guide.description': 'Watch the agent\'s browser live and take over when needed',
  'state.connecting': 'Connecting to the browser…',
  'state.down': 'The browser is not running. Start it to watch the agent browse the web live.',
  'state.noTabs': 'The agent will open a tab when it browses — or enter a URL above.',
  'status.running': 'Running',
  'status.down': 'Not running',
  'action.start': 'Start',
  'action.stop': 'Stop',
  'url.placeholder': 'Enter a URL and press Enter',
  'url.ariaLabel': 'Browser address bar',
  'takeover.label': 'Take over the browser',
  'takeover.hint': 'Take-over is on: clicks, scrolling, and keystrokes go straight to the browser.',
  'frame.alt': 'Browser viewport frame',
} satisfies Record<SidebarBrowserKey, string>
