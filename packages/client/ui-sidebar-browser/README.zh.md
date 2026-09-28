---
description: "dsh Web 客户端右侧 Sidebar 的浏览器 tab 类型：经 browser Remote 命名空间以约 1 fps 实时观看智能体驱动的浏览器，并可显式接管点击、滚动、键盘和导航。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-browser

[English](README.md) | 中文

## 概述

右侧 Sidebar 的浏览器 tab 类型：把 Host 运行的智能体浏览器以宽度自适应的截图流（约 1 fps）实时画出来，走 `@deepseek-ai/dsh-api-browser-controller` 的 `browser` Remote 命名空间；一个显式的接管开关能把画面变成用户自己的操控入口。它是从引导页进入的页类型，不认领任何地址——每台宿主只有一个浏览器，没有可寻址的东西。

## 目录

- [注册了什么](#what-it-registers)
- [窗格](#the-pane)
- [接管](#take-over)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

- **类型** — `ctx.sidebarRightTabs.register(...)`：kind 为 `browser`，id 为 `@deepseek-ai/dsh-client-ui-sidebar-browser`，`builtin` 档，无 patterns，带一个引导页条目（order 20，标题与描述取自 `sidebarBrowser` 命名空间，图标用共享的地球图标），点开即打开该类型。
- **主体** — 以该 id 为键注册到 `sidebar.right.pane.tab` 槽位：页签条下方一行头部（状态点与状态词、当前标签页标题、启动/停止按钮、接管开关），最近一次调用失败时的内联失败行，浏览器运行时出现的地址栏，以及下方的状态区。
- **不注册页签标题** — 刻意空着 `sidebar.right.pane.tab.title` 槽位：页签标题就是打开时捕获的类型静态名称。

`src/client/` 下共七个源文件：`definition.tsx`（类型）、`store.ts`（存什么）、`face.ts`（怎么调用浏览器，含 Remote 绑定）、`BrowserBody.tsx`（画什么）、`locales.ts`（说什么）、`index.ts`（接线）。

<a id="the-pane"></a>
## 窗格

页签 `visible` 期间，主体每 2 秒轮询一次 `status`；浏览器运行且至少有一个标签页时，以 1 Hz 抓取活动标签页的画面；页签一隐藏，所有轮询立即停止，重新可见时两个循环都先立刻调用一次再继续。进行中的抓取从不清空画面——新帧落地才替换屏幕上的旧帧。帧抓取报 `browser/not-found` 时丢掉画面并改画空状态，直到下一帧落地。每个 Remote 调用都落定为一个 `RemoteResult`，其错误分支带着 Host 的 `browser/*` 失败码；face 把它——或装配层的罕见拒绝——归约为 code 和 message 内联渲染，绝不抛出组件边界。所有状态文案都归词典所有：连接中、浏览器未运行（解释加醒目的启动按钮）、运行中但无标签页、实时画面。

地址栏跟随活动标签页的 URL，用户一旦输入就让位；回车时，浏览器没有标签页就开第一个，否则导航当前活动标签页，文本没有协议头时补上 `https://`；调用落地后立即触发一次状态刷新，让头部跟上。启动和停止按钮在调用进行中禁用，并按返回的状态重渲染。

状态放在本类型自己的 store 里，按侧栏页签 id 分桶：`status`、`frame`、`failure`、黏性的 `frameGone`、`takeover`、`lifecycleBusy`。属主的 `signal` 终结一个桶：abort 时遗忘该页签，代次守卫让在途轮询作废，之后落地的结果什么都不写。

<a id="take-over"></a>
## 接管

默认只看不动手：用户没有明确要求的事，窗格一件也不发。头部的开关显式打开后，画面带上品牌主色描边和十字光标，提示行说明已接管，视图容器获得键盘焦点。点击图片时，把显示偏移换算回 CSS 视口坐标（`offsetX × naturalWidth / clientWidth`——JPEG 的像素就是视口的 CSS 像素）并以 `click` 发出，约 250 毫秒后补抓一帧，而不是干等下一个轮询节拍。滚轮手势用同一换算经非 passive 监听器转发，窗格本身不会跟着滚动。命名键（`Enter`、`Tab`、`Escape`、`Backspace`、`Delete`、`Arrow*`）以 `key` 发出；单个可打印字符以 `typeText` 发出；带修饰键或未映射的键留在本地。

<a id="model-experience"></a>
## 模型体验

无：本包只把智能体驱动的浏览器画进 Web UI，不注册任何面向模型的东西；智能体通过 Host 自己的工具驱动同一个浏览器。

#### KV 缓存影响

无；画面经 Remote 传输，不组装任何模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **轮询而非推流。** 帧率是 1 Hz 轮询，没有推送通道，页面变化快时中间状态会被跳过。
- **只看活动标签页。** 窗格始终跟随浏览器的活动标签页；没有标签页条可切换，地址栏要么导航活动标签页，要么打开第一个。
- **只有手势。** 接管只转发点击、滚轮和按键——没有文本选择、剪贴板、拖拽、文件选择框或指针移动。
- **仅存内存。** 什么都不持久化；刷新后每个页签的视图都回到连接中状态。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

线上契约（`browser` 命名空间的方法、负载类型和 `browser/*` 失败码）归 `@deepseek-ai/dsh-api-browser-controller` 所有；本包只导入它的 `/types` 和生成的 `/remote` 声明合并，两边都不增加任何东西。

</details>

**运行时不变量：** 不发布伴随包。窗格唯一的运行时状态是每个侧栏页签一个 Slot store，由拥有它的主体写入，在页签记录的 abort 信号处遗忘；不存在第二个可能与之分叉的观察点。
