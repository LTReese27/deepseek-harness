---
description: "ctx.web 的 Tavily 搜索提供方：部署方如何挂载厂商原生 web 搜索，获得可移植 snippet 与发布日期。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-tavily

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-tavily`，harness 可以通过 Tavily 搜索 web，获得带可移植 snippet 与发布日期的厂商原生结果。当部署持有 Tavily API 密钥、并希望使用 Tavily 的通用 web 搜索时选择它。请求固定 `include_answer: false`——harness 模型会用来源撰写自己的答案——因此结果不携带 `content`，只产出可引用的来源。没有非空白摘录的来源会被丢弃，因此一次调用返回的来源可能少于请求数量。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `tavily` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: tavily` 固定。

### 何时选择

当部署持有 Tavily API 密钥，并希望使用 Tavily 的通用 web 搜索、获得每项结果的摘录 snippet 与发布日期时，选择此后端。密钥为空或端点基址无法解析时，提供方不可用——每次搜索调用都会以结构化错误失败。

### 最小配置

加载 web 服务与本提供方；API 密钥回退到启动环境中的 `$TAVILY_API_KEY`，其余设置都有安全默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKey: !!js process.env.TAVILY_API_KEY
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$TAVILY_API_KEY` | Tavily API 密钥；为空或缺失时提供方不可用 |
| `baseURL` | `https://api.tavily.com` | 端点基址；追加 `/search`。无法解析时提供方不可用 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-tavily)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索返回什么

每项 Tavily 结果映射为 `WebSearchSource`：`url`、`title`、以去除首尾空白的原始内容摘录作为 `snippet`、`published_date` 在 Tavily 报告时作为 `publishedAt`；没有摘录的来源缺少可移植的 snippet，会被丢弃。请求的 `maxResults` 作为 Tavily 的 `max_results` 发送，并截断到 Tavily 的硬上限 20，让消费方上限保持为一个 API 合法的值——最终上限由服务强制执行：截断并标记。请求固定 `include_answer: false`，因此结果不携带 `content`。

### 失败与恢复

提供方失败——HTTP 错误、网络失败、响应体无法解析或结构不符——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。调用方根据错误码进行分流；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 Tavily API 之上的薄适配器，遵循两条刻意的规则：

- **只取可移植的 snippet。** 来源只有在真实内容摘录存在时才获得 `snippet`；用其他字段捏造会让 seam 说谎，因此没有摘录的结果被整个丢弃。
- **不虚构答案。** harness 模型会用来源撰写自己的答案，因此请求固定 `include_answer: false`，结果省略 `content`，而不是携带模型可能因此偏信的提供方文本。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `TavilySearchProvider`：请求分发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | Tavily 协议类型：`TavilySearchResponse`、`TavilyResult`、`TavilyError` |

### 请求与映射流程

`search()` 以 `redirect: 'error'` 把查询、可选的 `max_results`（截断到 Tavily 上限 20）与 include 开关 POST 到 `{baseURL}/search`，因此重定向会在不接触目标的情况下使请求失败。解析后的 `results[]` 逐项映射，没有摘录的条目被丢弃，服务在返回路径上应用最终的 `maxResults` 上限。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——七包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-tavily)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-web` 间接影响模型体验。该工具保留本提供方经 `maxResults` 限制的 URL、标题、原始内容摘录以及 Tavily 报告时的发布日期；如果发生失败，则会在消费方的错误包装层内保留原样错误消息 `Tavily search aborted`、`Tavily search request failed: <error>` 和 `Tavily returned an unprocessable response body: <error>`。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **没有非空白内容摘录的来源会被整个丢弃**——没有可映射的可移植 snippet，因此返回来源可能少于请求数量。
- **只公开 `apiKey`／`baseURL`**——Tavily 的其他控制项（topic、搜索深度、时间范围、域名过滤条件）等待提供方无关的服务字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：更宽的 Tavily 控制面

Tavily 的 topic、搜索深度、时间范围以及域名过滤条件仍未公开。公开它们需要先有提供方无关的服务字段，让家族以一个协调一致的控制项、而非厂商专有参数的方式新增。

</details>
