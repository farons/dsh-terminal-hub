# dsh-terminal-hub

[English](README.md) | 中文

> DeepSeek Harness 的**终端总览**插件：一个侧栏面板，列出**所有会话**的终端，显示状态，点一下就切到该终端所属的会话并选中这个终端；另带一个**只读的启动器候选清单** Tab（主机 Tab）。

DSH 的终端是**会话所有**的——右侧栏每个会话一块，切到别的会话就看不到之前开的终端。这个插件把"所有终端"聚到一处，解决"我得先想起终端开在哪个会话"的问题。

## 功能

- **跨会话总览**：一次列出所有会话的终端（含当前未打开的会话），按会话分组
- **点击定位**：点任意一行，切到该终端所属会话，并在右侧栏选中这个终端；右侧栏折叠时自动展开
- **没有标签也能定位**：该终端在本窗口还没有标签、且仍在运行时，新开一个绑定到它的标签（复用官方终端 UI 打开 Agent 终端的同一条路径）
- **双名显示**：主标题是**显示名**（没有显示名就用**真实标题**，再没有就用 `shell + 短 id`），**真实标题**始终作为灰色副标题可见
- **状态点**：绿=运行中、灰=已退出、红=已失败，附带来源（用户 / Agent 启动）
- **副标题**：`真实标题 · shell 名 · 启动目录`，完整路径在悬停提示里
- **自动编号**：同会话 + 同目录 + 同 shell 的终端自动带 `#1 #2`
- **显示名**：双击标题原地改名，名字只在本面板生效，不改变 DSH 终端顶部的标题
- **关闭**：二次确认后真正杀掉终端进程（只对当前会话的终端生效）
- **标签与配色**：给终端加短标签并从 5 色板选色，只在面板内生效
- **搜索**：一个搜索框同时过滤两个 Tab（显示名 / 真实标题 / 标签 / 目录 / 会话名 / 启动器名与路径）
- **两个 Tab**：`终端 (N)` / `主机 (M)`，数字是**当前搜索结果**的数量
- **主机 Tab（只读、无配置）**：直接列出终端控制器实际注册的启动器候选（`name` 去掉 `.cmd` + 完整路径），不做过滤，不提供任何操作按钮
- **折叠已退出**：已退出与失败的终端默认收起，可展开
- 元数据存在浏览器 `localStorage`，终端消失后自动清理过期条目

## 安装

从 npm：

```sh
dsh plugin --profile web add dsh-terminal-hub
```

从 GitHub（跟最新代码）：

```sh
dsh plugin --profile web add github:<owner>/dsh-terminal-hub
```

本地开发：

```sh
git clone <repo-url> dsh-terminal-hub
dsh plugin --profile web add link:$PWD/dsh-terminal-hub
```

装完**重启 `dsh web`**（客户端插件在启动时加载进 `window.__DSH_BOOT__`）。之后修改 `client.js` 一般会被 `dsh-client-hmr` 热更新，最多按一次 F5。

## 工作原理

- 会话清单来自客户端 `ctx.sessions.list`（`SnapshotStore`）
- 每个会话的终端来自 Host 的 `remote.terminal.list(sessionId)`——**该方法接受任意会话 id（含离线会话）**，这是跨会话总览成立的前提
- 有终端的会话会额外订阅 `ctx.webTerminals.watch(sessionId, listener)`，拿到实时 roster
- 跳转走 `ctx.uiWorkspace.openSession(sessionId)`，它只负责切会话
- 选中终端靠 `ctx.sidebarRight`：会话切换后，右侧栏座位要先渲染、它的 store 才被 mint，所以插件**先等 `mounted` 变成目标会话**，再从跨会话标签清单（`sidebarRight.openTabs`）和终端绑定（`webTerminals.boundTerminal`）里找出绑定到该终端的标签，必要时展开栏位并 `focus(tabId)`
- 找不到标签、且终端仍在运行时，用 `sidebarRight.openTabIn(sessionId, 'terminal', { params: { terminalId } })` 新开一个标签再 `webTerminals.bind(...)` 绑到那个进程——和官方终端 UI 打开 Agent 终端是同一条路径
- 定位是**异步且有时限**的（4 秒）：`openSession` 会先关掉本面板，所以后续步骤不再碰 React 状态，只轮询服务；每一步都读回 `active()` 确认，失败只在控制台留一条警告，不会伪造成功
- 关闭直接调 `remote.terminal.close(sessionId, id)`。网关用调用方连接自身的 agent 校验 wire 上的 `agentId`，因此**只能操作当前会话的终端**；跨会话会被边界校验拒绝，面板会给出可读提示
- 显示名只存在浏览器 `localStorage`，不写 Host，也不影响 DSH 的终端顶部标题
- 主机 Tab 的数据来自 `ctx.webTerminals.launchShells(sessionId, signal)`（官方终端 UI 的路径），失败时退回 `remote.terminal.shells(...)`（内部还会试三种 wire 形状）；它**不读任何插件配置**，也没有内置副本

## 主机 Tab（只读）

这个 Tab **只读、无配置**：它显示的是终端控制器（`terminal-controller`）在**当前运行环境里实际注册的启动器候选**，所以永远与系统一致，不存在需要维护的第二份清单。

### 数据来源

按顺序尝试，第一条成功就用：

1. `ctx.webTerminals.launchShells(sessionId, signal)` —— 官方终端 UI 自己走的路径
2. `remote.terminal.shells(sessionId, signal)` —— 底层 Remote 兜底

第 2 条内部仍会依次尝试三种 wire 形状（`{id}` / 裸字符串 / `{agentId}`），并把成功的那一种记下来。

Tab 顶部会显示：

```
来源：终端候选清单
18 个候选启动器
shells() 形状：webTerminals.launchShells · 探测会话：<会话 id>
只读视图：这里不提供任何操作按钮。
```

### 会话 id 怎么选

`shells()` 的 agent 参数由网关查表（`agentId` lookup）并按**调用方连接**授权，因此插件按 `ctx.sessions.list` 快照**逐个试**（最多前 16 个），**第一个成功返回的**就用，并把它的 id 显示在来源行。

全部失败时：

- 顶部黄条：`读取启动器候选失败：<code>: <message>`（最后一次失败的原始 code/message）
- 列表区：`候选清单不可用，所以这里没有可列出的启动器。` 以及已尝试的会话数

**不会**把"读不到"显示成"没有启动器"，也不会显示一个不作解释的空列表。

### 行内容

| 位置 | 内容 |
|---|---|
| 主标题 | 候选的 `name`，去掉 `.cmd` 后缀（如 `web-01`） |
| 副行（灰色） | 候选的完整 `path`（悬停也显示完整路径） |
| 排序 | 按主标题（即 `name`）升序 |
| 搜索 | 匹配 `name` 与 `path`（共用顶部搜索框） |

候选**不做任何过滤**：即使某个启动器不在 `~/.dsh/ssh-hosts` 下，也照样列出——这个 Tab 的意义就是"看这台机器上有什么"。

## 已知限制

- **定位依赖右侧栏服务**：没有 `sidebarRight` 服务的 DSH 版本上，点击退化为"只切会话"（不报错，也不假装选中）
- **已退出且无标签的终端不会新开标签**：跳过去只会切到所属会话——没有进程可接，新开标签只会显示"不可用"
- **定位的 4 秒时限**：会话的右侧栏座位迟迟不渲染（例如界面卡住）时，插件到期就放弃聚焦，只在控制台留警告；会话切换本身仍然完成
- **不是跨会话接管**：面板负责"看见 + 导航 + 选中"，不能把别的会话的终端搬到当前会话里操作
- **启动目录不会跟随 `cd`**：`cwd` 是终端的启动目录，不是实时目录
- **显示名与颜色只在本面板可见**：DSH 的终端顶部标题由终端 UI 自己持有，本插件不修改它
- **关闭跨会话不可用**：网关边界校验只放行调用方自己会话的终端
- **主机 Tab 依赖网关授权**：`shells()` 的 agent 参数按调用方连接校验；如果所有候选会话都被拒，Tab 只会给出错误 code/message，不会伪造列表
- **离线会话的终端**：Host 只在进程生命周期内保留终端，DSH 重启后旧终端自然消失
- 一次最多扫描 400 个会话，超出会在面板里提示

## 兼容性

- 需要 `dsh >= 0.2.0`
- 依赖 DSH 内置客户端的 `sessions` / `webTerminals` / `uiWorkspace` / `sidebarRight` / `slots` / `locale` 服务，以及 `terminal-controller` 的 Remote 方法与绑定
- 这些是 DSH 内部 API，**升级 DSH 后可能需要适配**（`tabsIn` / `openTabIn` / `tabDomain` 不在 `ISidebarRight` 的类型面上，运行期存在；升级后先跑测试）
- 界面同时带英文与中文字典，DSH 按用户语言选择

## 开发

```sh
git clone <repo>
dsh plugin --profile web add link:$PWD
```

`client.js` 是手写的浏览器 bundle，格式为：

```js
window.__ModuleLoader__.load({ id: '<包名>', factory(require) { ... return { inject, apply } } })
```

无构建步骤，`node --check client.js` 可做语法校验。测试：

```sh
npm test    # node --test：定位逻辑 + 模块装配，不依赖浏览器
```

`test/jump.test.mjs` 直接读 `client.js`，求值 `// BEGIN/END terminal-jump helpers` 之间的源码（契约写死在同一份文件里），再用假的 `sidebarRight` / `webTerminals` 服务跑定位流程。

## 许可

MIT
