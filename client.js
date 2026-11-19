/**
 * dsh-terminal-hub, browser half.
 *
 * DSH terminals are Session-owned: each Session keeps its own terminal roster in
 * this window, so switching to another Session hides the terminals opened
 * before. This bundle adds one sidebar entry and one main panel that read the
 * roster of EVERY listed Session through the Host terminal Remote
 * (`remote.terminal.list(sessionId)`, which accepts offline Session ids) and let
 * one click jump back to the Session a terminal belongs to
 * (`uiWorkspace.openSession(sessionId)`).
 *
 * Round 2 adds per-terminal bookkeeping and process control:
 * - Close calls `remote.terminal.close(sessionId, id)` directly, not through
 *   `ctx.webTerminals` (that service only owns views of the current window).
 * - The Gateway validates the wire `agentId` against the calling connection's own
 *   agent, so a terminal of another Session can be listed and jumped to but never
 *   renamed or closed from here; that boundary is reported as a readable notice
 *   instead of a raw wire error.
 * - Display names, tags, tag colours live in localStorage keyed by terminal id;
 *   expired ids are pruned after a clean scan. A display name never leaves this
 *   panel — the DSH terminal header keeps its own title.
 *
 * Round 3 adds a second, read-only tab and separates the two names:
 * - Each terminal row shows a display name first, with the Host's own title (the
 *   real title) always visible as the grey sub line; one search box filters
 *   both tabs by every name, tag, directory and Session.
 * - The Hosts tab lists the launcher candidates the terminal controller actually
 *   registered — read through `ctx.webTerminals.launchShells` first and the raw
 *   `remote.terminal.shells` behind it — so the tab carries no configuration of
 *   its own and never drifts from the system. Rows are read-only: the candidate's
 *   name without `.cmd`, and its full path.
 * - Nothing is filtered out of that list: a launcher outside `ssh-hosts` is shown
 *   too, because the point is "what does this Host actually have".
 * - A refused read (the Gateway authorises the resolved agent against the calling
 *   connection) leaves the tab empty with the failing `code: message` on screen,
 *   never a silently blank list.
 *
 * Round 4 targets the terminal, not just the Session:
 * - A row click now carries the Host terminal id through the deferred jump. After
 *   `openSession` the panel is gone, so the remaining work runs on services alone:
 *   wait for the Session's right sidebar seat to mount, resolve the tab bound to
 *   that terminal from the cross-Session tab inventory (`openTabs`) and the
 *   controller bindings (`boundTerminal`), expand the column if it is collapsed,
 *   and select the tab. A terminal with no tab gets one only while it is running,
 *   opened with `openTabIn(...{ params: { terminalId } })` and bound, which is the
 *   path the official terminal UI uses for Agent terminals.
 * - Sidebar commands address the store the seat mints when it renders, so every
 *   step is polled against a deadline and read back (`active()`), never assumed:
 *   an unadopted surface silently ignores `focus`. When no `sidebarRight` service
 *   exists the jump degrades to the previous Session-only behaviour.
 *
 * The factory below is free of side effects: every registration happens inside
 * `apply`, and each disposable it creates rides the caller's Cordis fiber.
 */
window.__ModuleLoader__.load({
  id: 'dsh-terminal-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Own dictionary namespace (also the `locale` option of every registration). */
    const NS = 'terminal-hub'
    /** Sidebar entry id AND main-panel key: the sidebar row opens the panel by id. */
    const PANEL_ID = 'terminal-hub'
    /** Ascending sidebar row order; the shipped panels use 0 (Plugins) and 10 (Tasks). */
    const PANEL_ORDER = 30
    /** Sessions scanned in one panel visit (a guard against an unbounded roster). */
    const SCAN_LIMIT = 400
    /** Concurrent `remote.terminal.list` requests per batch. */
    const SCAN_CONCURRENCY = 6
    /** localStorage record for aliases, tags and the last confirmed rename. */
    const META_KEY = 'dsh-terminal-hub:meta:v1'
    const META_VERSION = 1
    /** Host-side title rule (`terminalTitle`): 1–120 characters after trimming. */
    const TITLE_MAX = 120
    const ALIAS_MAX = 60
    const TAG_MAX = 16
    /** A single click opens the Session; a second click inside this window means rename. */
    const JUMP_DELAY_MS = 260
    /** How long one jump may spend waiting for the Session's right sidebar to mount. */
    const JUMP_TIMEOUT_MS = 4000
    /** Poll interval while waiting for that mount and for the focus to take effect. */
    const JUMP_POLL_MS = 50
    /** The panel's two views: the terminal overview and the read-only host list. */
    const TAB_TERMINALS = 'terminals'
    const TAB_HOSTS = 'hosts'
    /** Suffix the terminal controller appends to a launcher candidate's executable name. */
    const HOST_LAUNCHER_SUFFIX = '.cmd'
    /** Leading characters of a terminal id, used when no name exists at all. */
    const SHORT_ID_LENGTH = 6
    /** Sessions probed for launcher candidates before giving up (the Gateway authorises the caller's own). */
    const PROBE_SESSION_LIMIT = 16

    /** Fixed tag palette; a tag only changes how this panel draws the row. */
    const TAG_COLORS = [
      { id: 'red', background: '#d64545', color: '#ffffff' },
      { id: 'yellow', background: '#c98a06', color: '#ffffff' },
      { id: 'green', background: '#2f9e44', color: '#ffffff' },
      { id: 'blue', background: '#1c7ed6', color: '#ffffff' },
      { id: 'gray', background: '#6b7280', color: '#ffffff' },
    ]
    const DEFAULT_COLOR = 'gray'

    const zh = {
      'panel.label': '终端总览',
      'panel.title': '终端总览',
      'panel.intro': '这里列出所有会话的终端，并可查看终端控制器注册的启动器。单击一条终端，切到它所属的会话并在右侧栏选中这个终端；双击标题可原地设置显示名。',
      'panel.missing': '面板缺少客户端服务：{services}。这是插件依赖问题，请重新安装或更新插件。',
      'panel.loading': '正在读取会话的终端…',
      'panel.empty': '没有找到任何终端。系统里所有会话目前都没有活着的终端。',
      'panel.empty.hint': '在任意会话里打开一个终端后再回来，或者点“刷新”。',
      'panel.refresh': '刷新',
      'panel.scanning': '读取中…',
      'panel.groups': '{sessions} 个会话，{terminals} 个终端',
      'panel.matched': '匹配到 {terminals} 个终端',
      'panel.truncated': '会话过多，只扫描了前 {limit} 个。',
      'panel.searchPlaceholder': '搜索：显示名 / 真实标题 / 标签 / 目录 / 会话名 / 启动器',
      'panel.noMatch': '没有匹配的终端。',
      'group.count': '{count} 个终端',
      'group.exited': '已退出 ({count})',
      'scan.partial': '{count} 个会话的终端读取失败：{detail}',
      'scan.failed': '读取终端列表失败：{message}',
      'jump.failed': '跳转到会话失败：{message}',
      'jump.missing': '目标会话不在会话列表里，无法跳转：{id}',
      'terminal.state.running': '运行中',
      'terminal.state.exited': '已退出',
      'terminal.state.failed': '已失败',
      'terminal.origin.agent': 'Agent 启动',
      'terminal.origin.user': '用户启动',
      'terminal.row.hint': '切到该终端所属的会话并选中这个终端（折叠的右侧栏会自动展开；双击标题改显示名）',
      'term.tools': '更多操作',
      'term.ids': '终端 id：{id}',
      'term.paths': 'shell：{shell}\n启动目录：{cwd}',
      'field.title': '真实标题（只读）',
      'field.alias': '显示名',
      'field.tag': '标签',
      'field.color': '颜色',
      'field.titlePlaceholder': '由 DSH 决定，本面板不可修改',
      'field.aliasPlaceholder': '只在本面板显示，1–{max} 字',
      'field.tagPlaceholder': '例如 prod / db / 备用',
      'action.save': '保存',
      'action.saveAlias': '保存显示名与标签',
      'action.rename': '设置显示名',
      'action.cancel': '取消',
      'action.clear': '清除',
      'action.close': '关闭终端（杀进程）',
      'action.confirmClose': '确认关闭',
      'action.cancelClose': '不关了',
      'hint.crossSession': '显示名只在本面板生效；关闭操作会发往该终端所属的会话。',
      'hint.closeWarns': '关闭会真的杀掉该终端进程，且无法撤销。',
      'msg.renamed': '显示名已更新：{title}',
      'msg.closed': '已关闭：{title}',
      'msg.saved': '已保存显示名。',
      'msg.error': '{code}: {message}',
      'err.titleInvalid': '标题需要 1–{max} 个字符。',
      'err.methodMissing': '客户端没有 remote.terminal.{method} 方法，未执行任何操作（无静默降级）。',
      'err.unexpectedResult': '返回值不是 RemoteResult：{value}',
      'err.threw': '{message}',
      'err.crossSession': '该终端属于其它会话；网关只允许操作当前会话的终端。先跳到它所属的会话，再试一次。',
      'color.red': '红',
      'color.yellow': '黄',
      'color.green': '绿',
      'color.blue': '蓝',
      'color.gray': '灰',
      'tab.terminals': '终端 ({count})',
      'tab.hosts': '主机 ({count})',
      'hosts.intro': '这里列出终端控制器实际注册的启动器候选，只读。',
      'hosts.readOnly': '只读视图：这里不提供任何操作按钮。',
      'hosts.sourceCandidates': '来源：终端候选清单',
      'hosts.counter': '{shown}/{total} 个候选启动器',
      'hosts.candidatesCount': '{count} 个候选启动器',
      'hosts.probing': '正在从终端控制器读取启动器候选…',
      'hosts.shellsShape': 'shells() 形状：{shape} · 探测会话：{session}',
      'hosts.shellsShapeUnknown': 'shells() 形状：未确认',
      'hosts.shellsFailed': '读取启动器候选失败：{code}: {message}',
      'hosts.emptyCandidates': '终端控制器没有返回任何候选启动器。',
      'hosts.noCandidates': '候选清单不可用，所以这里没有可列出的启动器。',
      'hosts.triedSessions': '已依次尝试 {count} 个会话。',
      'hosts.noMatch': '没有匹配的启动器。',
    }

    const en = {
      'panel.label': 'Terminal hub',
      'panel.title': 'Terminal hub',
      'panel.intro': 'Every terminal of every session, plus the launcher candidates the terminal controller registered. Click a terminal row to open its session with that terminal selected; double-click a title to set its display name.',
      'panel.missing': 'The panel is missing client services: {services}. This is a plugin dependency problem; reinstall or update the plugin.',
      'panel.loading': 'Reading terminals of every session…',
      'panel.empty': 'No terminals found. No session currently keeps a live terminal.',
      'panel.empty.hint': 'Open a terminal in a session, come back, or press Refresh.',
      'panel.refresh': 'Refresh',
      'panel.scanning': 'Reading…',
      'panel.groups': '{sessions} sessions, {terminals} terminals',
      'panel.matched': '{terminals} terminals matched',
      'panel.truncated': 'Too many sessions; only the first {limit} were scanned.',
      'panel.searchPlaceholder': 'Search: display name / real title / tag / directory / session / launcher',
      'panel.noMatch': 'No terminal matched.',
      'group.count': '{count} terminals',
      'group.exited': 'Exited ({count})',
      'scan.partial': 'Terminals of {count} sessions could not be read: {detail}',
      'scan.failed': 'Reading the terminal list failed: {message}',
      'jump.failed': 'Jumping to the session failed: {message}',
      'jump.missing': 'The target session is not in the session list and cannot be opened: {id}',
      'terminal.state.running': 'running',
      'terminal.state.exited': 'exited',
      'terminal.state.failed': 'failed',
      'terminal.origin.agent': 'started by agent',
      'terminal.origin.user': 'started by user',
      'terminal.row.hint': 'Open the session that owns this terminal and select it (a collapsed right sidebar expands; double-click the title to edit its display name)',
      'term.tools': 'More actions',
      'term.ids': 'terminal id: {id}',
      'term.paths': 'shell: {shell}\nstart directory: {cwd}',
      'field.title': 'Real title (read-only)',
      'field.alias': 'Display name',
      'field.tag': 'Tag',
      'field.color': 'Colour',
      'field.titlePlaceholder': 'Decided by DSH; read-only here',
      'field.aliasPlaceholder': 'Shown in this panel only, 1–{max} characters',
      'field.tagPlaceholder': 'for example prod / db / spare',
      'action.save': 'Save',
      'action.saveAlias': 'Save display name and tag',
      'action.rename': 'Set display name',
      'action.cancel': 'Cancel',
      'action.clear': 'Clear',
      'action.close': 'Close terminal (kills the process)',
      'action.confirmClose': 'Confirm close',
      'action.cancelClose': 'Keep it',
      'hint.crossSession': 'The display name lives in this panel only; Close is sent to the terminal\'s own session.',
      'hint.closeWarns': 'Closing really kills that terminal process and cannot be undone.',
      'msg.renamed': 'Display name updated: {title}',
      'msg.closed': 'Closed: {title}',
      'msg.saved': 'Display name saved.',
      'msg.error': '{code}: {message}',
      'err.titleInvalid': 'A title needs 1–{max} characters.',
      'err.methodMissing': 'This client has no remote.terminal.{method} method; nothing was sent (no silent fallback).',
      'err.unexpectedResult': 'The call did not return a RemoteResult: {value}',
      'err.threw': '{message}',
      'err.crossSession': 'This terminal belongs to another session; the gateway only allows operating terminals of the current session. Jump to its session first, then try again.',
      'color.red': 'red',
      'color.yellow': 'yellow',
      'color.green': 'green',
      'color.blue': 'blue',
      'color.gray': 'gray',
      'tab.terminals': 'Terminals ({count})',
      'tab.hosts': 'Hosts ({count})',
      'hosts.intro': 'The launcher candidates the terminal controller actually registered, read-only.',
      'hosts.readOnly': 'Read-only view: no action buttons here.',
      'hosts.sourceCandidates': 'Source: terminal candidate list',
      'hosts.counter': '{shown}/{total} launcher candidates',
      'hosts.candidatesCount': '{count} launcher candidates',
      'hosts.probing': 'Reading launcher candidates from the terminal controller…',
      'hosts.shellsShape': 'shells() shape: {shape} · probe session: {session}',
      'hosts.shellsShapeUnknown': 'shells() shape: unconfirmed',
      'hosts.shellsFailed': 'Reading launcher candidates failed: {code}: {message}',
      'hosts.emptyCandidates': 'The terminal controller returned no launcher candidates.',
      'hosts.noCandidates': 'The candidate list is unavailable, so there is nothing to list here.',
      'hosts.triedSessions': 'Tried {count} sessions in order.',
      'hosts.noMatch': 'No launcher matched.',
    }

    /** Theme-following colours; every token keeps a literal fallback. */
    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      secondary: 'var(--dsw-alias-label-secondary, #6b6b6b)',
      tertiary: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
      border: 'var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.28))',
      surface: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.10))',
      surfaceHover: 'var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, 0.17))',
      inputBackground: 'var(--dsw-alias-bg-base, #ffffff)',
      running: 'var(--dsw-alias-state-success-primary, #2f9e44)',
      exited: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
      failed: 'var(--dsw-alias-state-error-primary, #e03131)',
      danger: 'var(--dsw-alias-state-error-primary, #e03131)',
      warn: 'var(--dsw-alias-state-warn-tertiary, rgba(240, 173, 78, 0.20))',
      radius: 'var(--dsw-radius-md, 12px)',
    }

    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        minHeight: 0,
        height: '100%',
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: C.text,
        fontFamily: 'var(--dsw-font-family, inherit)',
      },
      head: {
        flex: '0 0 auto',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: '12px',
        // Never sit under the window's top strip (macOS traffic lights, the
        // Windows caption) and never add a band that is not there.
        padding: 'max(20px, var(--dsh-frame-top-clearance, 0px)) 24px 0',
      },
      title: { margin: 0, fontSize: '20px', fontWeight: 500, lineHeight: '28px' },
      counter: { fontSize: '13px', lineHeight: '20px', color: C.secondary },
      intro: {
        flex: '0 0 auto',
        margin: '4px 0 0',
        padding: '0 24px',
        fontSize: '13px',
        lineHeight: '20px',
        color: C.secondary,
      },
      refresh: {
        marginLeft: 'auto',
        padding: '4px 14px',
        border: '0.5px solid ' + C.border,
        borderRadius: '999px',
        background: C.surface,
        color: C.text,
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        cursor: 'pointer',
      },
      searchRow: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 24px 0',
      },
      search: {
        flex: '1 1 auto',
        minWidth: 0,
        boxSizing: 'border-box',
        padding: '5px 10px',
        border: '0.5px solid ' + C.border,
        borderRadius: '999px',
        background: C.inputBackground,
        color: C.text,
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
      },
      banner: {
        flex: '0 0 auto',
        margin: '12px 24px 0',
        padding: '8px 12px',
        borderRadius: C.radius,
        background: C.warn,
        color: C.text,
        fontSize: '12.5px',
        lineHeight: '18px',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      },
      error: {
        flex: '0 0 auto',
        margin: '12px 24px 0',
        padding: '10px 12px',
        border: '0.5px solid ' + C.danger,
        borderRadius: C.radius,
        color: C.danger,
        background: C.surface,
        fontSize: '13px',
        lineHeight: '20px',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      },
      scroller: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        padding: '12px 24px 24px',
      },
      group: { margin: '0 0 18px' },
      groupHead: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        padding: '0 0 6px 2px',
        borderBottom: '0.5px solid ' + C.border,
      },
      groupTitle: {
        minWidth: 0,
        flex: '0 1 auto',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '13.5px',
        fontWeight: 500,
      },
      groupCount: { flex: '0 0 auto', marginLeft: 'auto', fontSize: '12px', color: C.tertiary },
      exitedToggle: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        width: '100%',
        margin: '6px 0 0',
        padding: '4px 2px',
        border: 0,
        background: 'none',
        color: C.tertiary,
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        textAlign: 'left',
        cursor: 'pointer',
      },
      row: {
        margin: '6px 0 0',
        border: '0.5px solid ' + C.border,
        borderRadius: C.radius,
        background: C.surface,
      },
      rowLine: { display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '8px 10px' },
      jump: {
        flex: '1 1 auto',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        border: 0,
        padding: 0,
        background: 'none',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        textAlign: 'left',
        cursor: 'pointer',
      },
      titleLine: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
      rowTitle: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      numChip: {
        flex: '0 0 auto',
        padding: '0 4px',
        borderRadius: '4px',
        background: C.surfaceHover,
        color: C.secondary,
        fontSize: '11px',
        lineHeight: '16px',
      },
      tagChip: {
        flex: '0 0 auto',
        padding: '0 7px',
        borderRadius: '999px',
        fontSize: '11px',
        lineHeight: '16px',
        fontWeight: 500,
      },
      subLine: {
        fontSize: '11.5px',
        lineHeight: '16px',
        color: C.tertiary,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      right: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '6px' },
      stateText: { fontSize: '11.5px', lineHeight: '16px', whiteSpace: 'nowrap' },
      tools: {
        border: '0.5px solid transparent',
        borderRadius: '6px',
        padding: '0 6px',
        background: 'none',
        color: C.secondary,
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '18px',
        cursor: 'pointer',
      },
      editor: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '0 10px 10px' },
      fieldRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      fieldLabel: { flex: '0 0 auto', width: '98px', fontSize: '11.5px', color: C.tertiary },
      input: {
        flex: '1 1 160px',
        minWidth: '120px',
        boxSizing: 'border-box',
        padding: '3px 8px',
        border: '0.5px solid ' + C.border,
        borderRadius: '8px',
        background: C.inputBackground,
        color: 'inherit',
        font: 'inherit',
        fontSize: '12.5px',
        lineHeight: '18px',
      },
      titleInput: {
        flex: '1 1 auto',
        minWidth: 0,
        boxSizing: 'border-box',
        padding: '2px 8px',
        border: '0.5px solid ' + C.border,
        borderRadius: '8px',
        background: C.inputBackground,
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
      },
      button: {
        flex: '0 0 auto',
        padding: '3px 10px',
        border: '0.5px solid ' + C.border,
        borderRadius: '999px',
        background: C.surfaceHover,
        color: C.text,
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
      },
      dangerButton: {
        flex: '0 0 auto',
        padding: '3px 10px',
        border: '0.5px solid ' + C.danger,
        borderRadius: '999px',
        background: 'transparent',
        color: C.danger,
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
      },
      colorDot: {
        width: '16px',
        height: '16px',
        padding: 0,
        borderRadius: '50%',
        border: '2px solid transparent',
        cursor: 'pointer',
      },
      hint: { fontSize: '11.5px', lineHeight: '16px', color: C.tertiary },
      rowError: {
        padding: '0 10px 10px',
        fontSize: '12px',
        lineHeight: '18px',
        color: C.danger,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      },
      confirm: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
        padding: '0 10px 10px',
        fontSize: '12px',
        lineHeight: '18px',
        color: C.danger,
      },
      empty: { padding: '28px 2px', color: C.secondary, fontSize: '13px', lineHeight: '20px' },
      emptyHint: { marginTop: '6px', color: C.tertiary, fontSize: '12px' },
      tabs: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '12px 24px 0',
      },
      tab: {
        padding: '4px 14px',
        border: '0.5px solid ' + C.border,
        borderRadius: '999px',
        background: 'transparent',
        color: C.secondary,
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        cursor: 'pointer',
      },
      tabActive: {
        background: C.surfaceHover,
        color: C.text,
        fontWeight: 500,
      },
      hostsMeta: {
        padding: '0 0 6px',
        fontSize: '11.5px',
        lineHeight: '16px',
        color: C.tertiary,
        overflowWrap: 'anywhere',
      },
      hostRow: {
        margin: '6px 0 0',
        border: '0.5px solid ' + C.border,
        borderRadius: C.radius,
        background: C.surface,
      },
      hostLine: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px' },
      hostMark: { flex: '0 0 auto', display: 'flex', alignItems: 'center', color: C.tertiary, opacity: 0.75 },
      hostBody: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      hostPrimary: {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '13px',
        fontWeight: 500,
        lineHeight: '20px',
      },
      hostSub: {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '11.5px',
        lineHeight: '16px',
        color: C.tertiary,
        opacity: 0.78,
      },
      hostBadge: { flex: '0 0 auto', fontSize: '11.5px', lineHeight: '16px', whiteSpace: 'nowrap' },
    }

    // ── small value helpers ───────────────────────────────────────────────────

    /** Human text of any thrown value, without assuming an Error instance. */
    function messageOf(error) {
      if (error === undefined || error === null) return 'unknown error'
      if (typeof error === 'string') return error
      const message = error.message
      if (typeof message === 'string' && message !== '') return message
      const code = error.code
      if (typeof code === 'string' && code !== '') return code
      try {
        return JSON.stringify(error)
      } catch {
        return String(error)
      }
    }

    /** Read one Client service without letting an absent or throwing provider escape. */
    function serviceOf(ctx, name) {
      try {
        return typeof ctx.get === 'function' ? ctx.get(name) : undefined
      } catch {
        return undefined
      }
    }

    /** The generated terminal Remote namespace, by either service spelling. */
    function terminalRemoteOf(ctx, remote) {
      const direct = serviceOf(ctx, 'remote.terminal')
      if (direct && typeof direct.list === 'function') return direct
      if (remote && remote.terminal && typeof remote.terminal.list === 'function') return remote.terminal
      return undefined
    }

    /** Client services this panel reads, resolved lazily on every use. */
    function resolveServices(ctx) {
      const missing = []
      const sessions = serviceOf(ctx, 'sessions')
      const uiWorkspace = serviceOf(ctx, 'uiWorkspace')
      const layout = serviceOf(ctx, 'layout')
      const webTerminals = serviceOf(ctx, 'webTerminals')
      // Optional: without it a jump still switches Sessions, it just cannot
      // select the terminal's tab (see revealTerminalTab).
      const sidebarRight = serviceOf(ctx, 'sidebarRight')
      const remote = serviceOf(ctx, 'remote')
      const terminalRemote = terminalRemoteOf(ctx, remote)
      if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') missing.push('sessions')
      if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') missing.push('uiWorkspace')
      if (!terminalRemote) missing.push('remote.terminal')
      return { sessions, uiWorkspace, layout, webTerminals, sidebarRight, remote, terminalRemote, missing }
    }

    /** Catalog rows of every listed Session, in the Host's own order. */
    function sessionRowsOf(sessions) {
      let snapshot
      try {
        snapshot = sessions.list.getSnapshot()
      } catch {
        return []
      }
      if (!snapshot || typeof snapshot !== 'object') return []
      const byId = snapshot.byId && typeof snapshot.byId === 'object' ? snapshot.byId : {}
      const listed = Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(byId)
      const rows = []
      for (const id of listed) {
        if (typeof id !== 'string' || id === '') continue
        const summary = byId[id]
        const title = summary && typeof summary.displayTitle === 'string' && summary.displayTitle !== ''
          ? summary.displayTitle
          : id
        rows.push({ id, title })
      }
      return rows
    }

    /** Last path segment of a Windows or POSIX path. */
    function basenameOf(path) {
      if (typeof path !== 'string') return ''
      const parts = path.split(/[\\/]+/)
      for (let index = parts.length - 1; index >= 0; index--) {
        const part = parts[index].trim()
        if (part !== '') return part
      }
      return ''
    }

    /** Shell name the Host reports, falling back to the shell path's basename. */
    function shellNameOf(info) {
      const shell = info && info.shell
      if (shell && typeof shell.name === 'string' && shell.name.trim() !== '') return shell.name.trim()
      const base = basenameOf(shell && typeof shell.path === 'string' ? shell.path : '')
      return base !== '' ? base : 'shell'
    }

    /** One Host terminal description reduced to what the panel renders. */
    function normalizeTerminal(info) {
      const shell = info && info.shell && typeof info.shell === 'object' ? info.shell : {}
      const state = info && typeof info.state === 'string' ? info.state : 'exited'
      return {
        id: info && info.id !== undefined ? String(info.id) : 'unknown-' + Math.random().toString(36).slice(2),
        title: info && typeof info.title === 'string' && info.title !== '' ? info.title : 'terminal',
        state,
        origin: info && typeof info.origin === 'string' ? info.origin : 'user',
        cwd: info && typeof info.cwd === 'string' ? info.cwd : '',
        shellName: shellNameOf(info),
        shellPath: typeof shell.path === 'string' ? shell.path : '',
      }
    }

    /** Read one Session's retained terminals; never rejects. */
    async function listOne(terminalRemote, sessionId) {
      try {
        const result = await terminalRemote.list(sessionId)
        if (Array.isArray(result)) return { ok: true, terminals: result }
        if (result && result.ok === true) {
          return { ok: true, terminals: Array.isArray(result.value) ? result.value : [] }
        }
        if (result && result.ok === false) return { ok: false, message: messageOf(result.error) }
        return { ok: false, message: 'list() returned an unrecognized result' }
      } catch (error) {
        return { ok: false, message: messageOf(error) }
      }
    }

    /**
     * Read every Session's terminals in bounded batches.
     * @returns Groups that own at least one terminal, plus per-Session failures.
     */
    async function scanAll(terminalRemote, rows) {
      const groups = []
      const failures = []
      for (let start = 0; start < rows.length; start += SCAN_CONCURRENCY) {
        const batch = rows.slice(start, start + SCAN_CONCURRENCY)
        const settled = await Promise.all(batch.map(async (row) => ({ row, result: await listOne(terminalRemote, row.id) })))
        for (const { row, result } of settled) {
          if (!result.ok) {
            failures.push(row.title + ' — ' + result.message)
            continue
          }
          if (result.terminals.length === 0) continue
          groups.push({
            sessionId: row.id,
            sessionTitle: row.title,
            terminals: result.terminals.map(normalizeTerminal),
          })
        }
      }
      return { groups, failures }
    }

    /**
     * Call one unary terminal Remote method and keep its RemoteResult envelope.
     * Never throws, never silently succeeds: a missing method is reported as such.
     * @returns `{ ok: true, value }` or `{ ok: false, code, message, missing? }`.
     */
    async function callRemote(terminalRemote, method, args) {
      const target = terminalRemote ? terminalRemote[method] : undefined
      if (typeof target !== 'function') {
        return {
          ok: false,
          missing: true,
          method,
          code: 'client/method-missing',
          message: 'remote.terminal.' + method + ' is undefined on this client',
        }
      }
      try {
        const result = await target.apply(terminalRemote, args)
        if (result && result.ok === true) return { ok: true, value: result.value }
        if (result && result.ok === false) {
          const failure = result.error && typeof result.error === 'object' ? result.error : {}
          return {
            ok: false,
            code: typeof failure.code === 'string' && failure.code !== '' ? failure.code : 'remote/unknown-code',
            message: typeof failure.message === 'string' ? failure.message : messageOf(result.error),
          }
        }
        let serialized = ''
        try {
          serialized = JSON.stringify(result)
        } catch {
          serialized = messageOf(result)
        }
        return { ok: false, code: 'client/unexpected-result', message: serialized === undefined ? 'undefined' : serialized }
      } catch (error) {
        const remote = error && error.remoteError === true ? error : undefined
        if (remote !== undefined) return { ok: false, code: String(remote.code), message: String(remote.message) }
        return { ok: false, code: 'client/threw', message: messageOf(error) }
      }
    }

    /**
     * Call a terminal Remote whose first parameter is the Gateway-resolved owner
     * (`{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent' }`).
     *
     * The client API validates three positional arguments, yet a bare Session id
     * in position 0 is accepted by the client and then rejected by the Gateway as
     * `missing "agentId"` — so the two layers disagree on how the lookup
     * parameter travels. Try the plausible shapes in order, stop at the first
     * accepted one, and report every failure so the next round is not guesswork.
     */
    async function callAgentScoped(terminalRemote, method, sessionId, fields, positional) {
      const candidates = [
        { shape: 'agent-object', args: [{ id: sessionId }, ...positional] },
        { shape: 'positional', args: [sessionId, ...positional] },
        { shape: 'named', args: [{ agentId: sessionId, ...fields }] },
      ]
      const failures = []
      for (const candidate of candidates) {
        const result = await callRemote(terminalRemote, method, candidate.args)
        if (result.ok) return { ...result, shape: candidate.shape }
        failures.push(candidate.shape + ' → ' + String(result.code) + ': ' + String(result.message))
      }

      // The Gateway authorises `agentId` against the calling connection's own
      // agent, so a terminal of another Session can be listed but never renamed
      // or closed from here. Say so instead of surfacing a raw wire error.
      if (failures.some((failure) => /boundary validation/i.test(failure))) {
        return {
          ok: false,
          code: 'hub/cross-session-blocked',
          message: 'this terminal belongs to another Session; the Gateway only allows terminals of the calling Session',
        }
      }
      return { ok: false, code: 'client/all-shapes-failed', message: failures.join('  |  ') }
    }

    // ── localStorage bookkeeping (aliases, tags, last confirmed rename) ──────

    function emptyMeta() {
      return { v: META_VERSION, terminals: {}, exitedOpen: {} }
    }

    function storageOf() {
      try {
        const store = typeof window === 'object' && window !== null ? window.localStorage : undefined
        return store && typeof store.getItem === 'function' ? store : undefined
      } catch {
        return undefined
      }
    }

    function isKnownColor(value) {
      return typeof value === 'string' && TAG_COLORS.some((entry) => entry.id === value)
    }

    /** Read the record store; any corrupt or foreign value degrades to empty. */
    function loadMeta() {
      const store = storageOf()
      if (store === undefined) return emptyMeta()
      try {
        const raw = store.getItem(META_KEY)
        if (typeof raw !== 'string' || raw === '') return emptyMeta()
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return emptyMeta()
        const terminals = {}
        const sourceTerminals = parsed.terminals !== null && typeof parsed.terminals === 'object' ? parsed.terminals : {}
        for (const [id, value] of Object.entries(sourceTerminals)) {
          if (typeof id !== 'string' || value === null || typeof value !== 'object') continue
          const record = {}
          if (typeof value.alias === 'string' && value.alias.trim() !== '') record.alias = value.alias.slice(0, ALIAS_MAX)
          if (typeof value.tag === 'string' && value.tag.trim() !== '') record.tag = value.tag.slice(0, TAG_MAX)
          if (isKnownColor(value.color)) record.color = value.color
          if (typeof value.hostTitle === 'string' && value.hostTitle !== '') record.hostTitle = value.hostTitle
          if (typeof value.hostTitleFrom === 'string') record.hostTitleFrom = value.hostTitleFrom
          if (Object.keys(record).length > 0) terminals[id] = record
        }
        const exitedOpen = {}
        const sourceOpen = parsed.exitedOpen !== null && typeof parsed.exitedOpen === 'object' ? parsed.exitedOpen : {}
        for (const [id, value] of Object.entries(sourceOpen)) if (value === true) exitedOpen[id] = true
        return { v: META_VERSION, terminals, exitedOpen }
      } catch {
        return emptyMeta()
      }
    }

    function saveMeta(meta) {
      const store = storageOf()
      if (store === undefined) return
      try {
        store.setItem(META_KEY, JSON.stringify(meta))
      } catch {
        // Quota or private mode: the panel keeps working without persistence.
      }
    }

    /** Write one terminal's record, dropping it when every field is empty. */
    function withTerminalRecord(meta, terminalId, record) {
      const terminals = { ...meta.terminals }
      if (record === undefined || Object.keys(record).length === 0) delete terminals[terminalId]
      else terminals[terminalId] = record
      return { ...meta, terminals }
    }

    /** Drop records of terminal ids that no clean scan reported any more. */
    function pruneTerminals(meta, aliveIds) {
      const terminals = {}
      let changed = false
      for (const [id, record] of Object.entries(meta.terminals)) {
        if (aliveIds.has(id)) terminals[id] = record
        else changed = true
      }
      return changed ? { ...meta, terminals } : meta
    }

    /** Display title: the panel-only display name first, then the Host title. */
    function displayTitleOf(terminal, record) {
      if (record && typeof record.alias === 'string' && record.alias !== '') return record.alias
      if (record && typeof record.hostTitle === 'string' && record.hostTitle !== ''
        && record.hostTitleFrom === terminal.title) return record.hostTitle
      return terminal.title
    }

    // ── names: display name / real title ─────────────────────────────────────

    /** Leading characters of a terminal id, for the last-resort name. */
    function shortIdOf(id) {
      const text = typeof id === 'string' ? id : String(id)
      return text.length <= SHORT_ID_LENGTH ? text : text.slice(0, SHORT_ID_LENGTH)
    }

    /** The Host's own title (the real title), including a rename the roster has not shown yet. */
    function realTitleOf(terminal, record) {
      if (record && typeof record.hostTitle === 'string' && record.hostTitle !== ''
        && record.hostTitleFrom === terminal.title) return record.hostTitle
      const title = typeof terminal.title === 'string' ? terminal.title.trim() : ''
      return title === '' ? undefined : title
    }

    /**
     * Main row title: the display name first, then the real title, then `shell · short id`, so
     * a row is never nameless even when the Host titled it with a blank string.
     */
    function primaryTitleOf(terminal, record) {
      if (record && typeof record.alias === 'string' && record.alias.trim() !== '') return record.alias.trim()
      const real = realTitleOf(terminal, record)
      if (real !== undefined) return real
      return terminal.shellName + ' · ' + shortIdOf(terminal.id)
    }

    // ── hosts tab: the terminal controller's launcher candidates ─────────────

    /** Executable name of one shell candidate, as `discoverShells` reports it. */
    function candidateNameOf(candidate) {
      if (candidate === null || typeof candidate !== 'object') return ''
      const name = typeof candidate.name === 'string' && candidate.name.trim() !== '' ? candidate.name.trim() : ''
      if (name !== '') return name
      return basenameOf(typeof candidate.path === 'string' ? candidate.path : '')
    }

    /** Row title of one candidate: its executable name without the `.cmd` suffix. */
    function candidateTitleOf(name) {
      const text = typeof name === 'string' ? name.trim() : ''
      return text.toLowerCase().endsWith(HOST_LAUNCHER_SUFFIX)
        ? text.slice(0, text.length - HOST_LAUNCHER_SUFFIX.length)
        : text
    }

    /** Normalize one Host shell candidate to what the panel renders. */
    function normalizeCandidate(raw) {
      const name = candidateNameOf(raw)
      const path = raw !== null && typeof raw === 'object' && typeof raw.path === 'string' ? raw.path : ''
      return {
        id: path !== '' ? path : name,
        name,
        path,
        title: candidateTitleOf(name),
      }
    }

    /**
     * Read the launcher candidates the terminal controller actually registered.
     *
     * `ctx.webTerminals.launchShells` is the path the shipped terminal UI itself
     * uses, so it is tried first; the raw `remote.terminal.shells` behind it then
     * supplies the three wire shapes the Gateway may or may not accept for the
     * same call.
     *
     * Session ids are tried in catalog order because the Gateway resolves the
     * `agent` parameter through its `agentId` lookup and authorises it against the
     * calling connection, so only the caller's own Session is guaranteed to pass.
     *
     * @returns `{ ok, candidates, sessionId, shape, error, attempts, tried }`.
     */
    async function discoverCandidates(api, sessionIds, signal) {
      const attempts = []
      const tried = new Set()
      const record = (sessionId, source, failure) => {
        attempts.push({ sessionId, source, code: failure.code, message: failure.message })
        tried.add(sessionId)
      }

      const webTerminals = api.webTerminals
      const terminalRemote = api.terminalRemote
      const official = Boolean(webTerminals && typeof webTerminals.launchShells === 'function')
      if (!official && !terminalRemote) {
        return {
          ok: false,
          candidates: [],
          sessionId: undefined,
          shape: undefined,
          error: { code: 'client/service-missing', message: 'neither webTerminals.launchShells nor remote.terminal.shells is available' },
          attempts,
          tried: 0,
        }
      }

      for (const sessionId of sessionIds) {
        if (signal.aborted) {
          return { ok: false, candidates: [], sessionId: undefined, shape: undefined, error: { code: 'client/aborted', message: 'probe cancelled' }, attempts, tried: tried.size }
        }

        if (official) {
          try {
            const launched = await webTerminals.launchShells(sessionId, signal)
            const shells = launched && Array.isArray(launched.shells) ? launched.shells : []
            return { ok: true, candidates: shells.map(normalizeCandidate), sessionId, shape: 'webTerminals.launchShells', attempts, tried: tried.size }
          } catch (error) {
            // launchShells reports only `error.message`, so the raw Remote below
            // is what restores the business code for the failure banner.
            record(sessionId, 'webTerminals.launchShells', { code: 'client/threw', message: messageOf(error) })
          }
        }

        if (terminalRemote) {
          const result = await callAgentScoped(terminalRemote, 'shells', sessionId, {}, [signal])
          if (result.ok) {
            const shells = Array.isArray(result.value) ? result.value : []
            return { ok: true, candidates: shells.map(normalizeCandidate), sessionId, shape: result.shape, attempts, tried: tried.size }
          }
          record(sessionId, 'remote.terminal.shells', result)
        }
      }

      const last = attempts.length > 0 ? attempts[attempts.length - 1] : undefined
      return {
        ok: false,
        candidates: [],
        sessionId: undefined,
        shape: undefined,
        error: last === undefined
          ? { code: 'client/no-session', message: 'no listed Session to probe with' }
          : { code: last.code, message: last.message },
        attempts,
        tried: tried.size,
      }
    }

    // ── state shaping ────────────────────────────────────────────────────────

    /** Replace, insert or drop one Session's group after a live roster frame. */
    function withGroup(state, sessionId, sessionTitle, terminals) {
      const groups = state.groups || []
      const index = groups.findIndex((group) => group.sessionId === sessionId)
      if (terminals.length === 0) {
        if (index === -1) return state
        return { ...state, groups: groups.filter((group) => group.sessionId !== sessionId) }
      }
      if (index === -1) {
        return { ...state, groups: groups.concat([{ sessionId, sessionTitle, terminals }]) }
      }
      const next = groups.slice()
      next[index] = { sessionId, sessionTitle, terminals }
      return { ...state, groups: next }
    }

    /** Drop one terminal (and its now-empty group) after a confirmed close. */
    function removeTerminalFromState(state, sessionId, terminalId) {
      const groups = []
      for (const group of state.groups) {
        if (group.sessionId !== sessionId) {
          groups.push(group)
          continue
        }
        const terminals = group.terminals.filter((terminal) => terminal.id !== terminalId)
        if (terminals.length > 0) groups.push({ ...group, terminals })
      }
      return { ...state, groups }
    }

    /** Total terminals across the groups. */
    function terminalCountOf(groups) {
      let total = 0
      for (const group of groups) total += group.terminals.length
      return total
    }

    /**
     * `#n` for terminals that share a Session, a start directory and a shell —
     * the case where several SSH `.cmd` wrappers carry the same face.
     * @returns terminal id → ordinal, only for keys that occur more than once.
     */
    function numberingOf(terminals) {
      const totals = new Map()
      for (const terminal of terminals) {
        const key = terminal.cwd + '\u0000' + terminal.shellPath
        totals.set(key, (totals.get(key) || 0) + 1)
      }
      const seen = new Map()
      const numbers = new Map()
      for (const terminal of terminals) {
        const key = terminal.cwd + '\u0000' + terminal.shellPath
        if ((totals.get(key) || 0) < 2) continue
        const next = (seen.get(key) || 0) + 1
        seen.set(key, next)
        numbers.set(terminal.id, next)
      }
      return numbers
    }

    /** Colour entry of a record, defaulting to gray. */
    function colorOf(record) {
      const wanted = record && isKnownColor(record.color) ? record.color : DEFAULT_COLOR
      for (const entry of TAG_COLORS) if (entry.id === wanted) return entry
      return TAG_COLORS[TAG_COLORS.length - 1]
    }

    function withoutKey(map, key) {
      if (map[key] === undefined) return map
      const next = { ...map }
      delete next[key]
      return next
    }

    function scheduleTimeout(callback, delayMs) {
      try {
        return window.setTimeout(callback, delayMs)
      } catch {
        return undefined
      }
    }

    function cancelTimeout(handle) {
      if (handle === undefined) return
      try {
        window.clearTimeout(handle)
      } catch {
        // A timer that already fired needs no cancellation.
      }
    }

    // ── per-terminal jump ────────────────────────────────────────────────────
    // The panel navigates by Session, but a terminal is shown by a tab of the
    // right sidebar. These helpers bridge the two: they resolve the Host terminal
    // id the panel lists to the sidebar tab bound to it, and only touch services
    // (never React state), because `openSession` closes the panel before they run.
    // Kept free of React and of this file's component state so the block between
    // the sentinels can be evaluated by a Node test on its own.

    // BEGIN terminal-jump helpers
    /** Wait one poll interval without blocking the event loop. */
    function delay(ms) {
      return new Promise((resolve) => {
        scheduleTimeout(resolve, ms)
      })
    }

    /** One Session's committed sidebar tabs; empty until its store has been adopted. */
    function tabsInOf(sidebarRight, sessionId) {
      try {
        const tabs = sidebarRight.tabsIn(sessionId)
        return Array.isArray(tabs) ? tabs : []
      } catch {
        return []
      }
    }

    /** The terminal id recorded in a sidebar tab's navigation parameters, if any. */
    function navigationTerminalIdOf(sidebarRight, sessionId, tabId) {
      try {
        const domain = sidebarRight.tabDomain
        if (!domain || typeof domain.occurrence !== 'function') return undefined
        const occurrence = domain.occurrence(sessionId, { id: tabId })
        const navigation = occurrence && occurrence.navigation
        const params = navigation && typeof navigation.getSnapshot === 'function'
          ? navigation.getSnapshot().params
          : undefined
        if (!params || params.terminalId === undefined) return undefined
        return String(params.terminalId)
      } catch {
        return undefined
      }
    }

    /**
     * Whether one sidebar tab is the tab of this Host terminal. The controller's
     * binding is the authority (the body attaches to it); the navigation
     * parameters are the fallback for a tab whose body never mounted here.
     */
    function tabShowsTerminal(sidebarRight, webTerminals, sessionId, tabId, contentId, terminalId) {
      if (webTerminals && typeof webTerminals.boundTerminal === 'function') {
        try {
          if (webTerminals.boundTerminal(sessionId, contentId) === terminalId) return true
        } catch {
          // Fall through to the recorded navigation parameters.
        }
      }
      return navigationTerminalIdOf(sidebarRight, sessionId, tabId) === terminalId
    }

    /**
     * Terminal-kind tabs of one Session, from the saved-layout inventory and the
     * live layout. The inventory covers Sessions whose seat has not rendered yet,
     * which is exactly the cross-Session case this panel exists for.
     */
    function terminalTabsOf(sidebarRight, sessionId) {
      const byId = new Map()
      try {
        const source = sidebarRight.openTabs
        const inventory = source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : undefined
        if (Array.isArray(inventory)) {
          for (const entry of inventory) {
            if (entry && entry.sessionId === sessionId && entry.kind === 'terminal' && typeof entry.tabId === 'string') {
              byId.set(entry.tabId, { tabId: entry.tabId, contentId: entry.contentId })
            }
          }
        }
      } catch {
        // The inventory is only a hint; the live layout below is authoritative.
      }
      for (const tab of tabsInOf(sidebarRight, sessionId)) {
        if (tab && tab.kind === 'terminal' && !byId.has(tab.id)) {
          byId.set(tab.id, { tabId: tab.id, contentId: tab.contentId })
        }
      }
      return [...byId.values()]
    }

    /** The sidebar tab bound to one Host terminal, or undefined when this window shows none. */
    function terminalTabOf(sidebarRight, webTerminals, sessionId, terminalId) {
      for (const tab of terminalTabsOf(sidebarRight, sessionId)) {
        if (tabShowsTerminal(sidebarRight, webTerminals, sessionId, tab.tabId, tab.contentId, terminalId)) return tab
      }
      return undefined
    }

    /**
     * Expand the column when needed and select one tab.
     *
     * Sidebar commands throw while the Session's store has not been minted yet,
     * so a failed attempt is reported instead of escaping. The read-back keeps a
     * silent no-op (an unadopted surface ignores `focus`) from counting as done.
     *
     * @returns whether the column reports that tab active afterwards.
     */
    function focusSidebarTab(sidebarRight, tabId) {
      try {
        if (typeof sidebarRight.isExpanded === 'function' && sidebarRight.isExpanded() === false) {
          sidebarRight.toggleExpanded()
        }
      } catch {
        return false
      }
      try {
        sidebarRight.focus(tabId)
      } catch {
        return false
      }
      try {
        const active = sidebarRight.active()
        return Boolean(active && active.id === tabId)
      } catch {
        return false
      }
    }

    /**
     * Open a terminal tab bound to an existing Host terminal, the way the official
     * terminal UI opens Agent terminals: open the tab with the terminal id in its
     * parameters, then save the binding so a reload reattaches to that process.
     *
     * `openTabIn` writes through the Session's adopted store, so a call issued
     * before the seat renders does nothing (or throws); the loop retries until
     * the tab appears or time is up. A committed call makes the tab visible on
     * the next read, so no retry can duplicate a tab that already exists.
     *
     * @returns the new tab's id, or undefined when none could be opened.
     */
    async function openBoundTerminalTab(api, sessionId, terminal, deadline) {
      const sidebarRight = api.sidebarRight
      if (typeof sidebarRight.openTabIn !== 'function') return undefined
      const before = new Set(tabsInOf(sidebarRight, sessionId).map((tab) => tab.id))
      for (;;) {
        const opened = tabsInOf(sidebarRight, sessionId)
          .find((tab) => tab.kind === 'terminal' && !before.has(tab.id))
        if (opened !== undefined) {
          const webTerminals = api.webTerminals
          if (webTerminals && typeof webTerminals.bind === 'function') {
            try {
              webTerminals.bind(sessionId, opened.contentId, terminal.id)
            } catch {
              // The parameters already name the terminal; the binding only adds reload recovery.
            }
          }
          return opened.id
        }
        if (Date.now() >= deadline) return undefined
        try {
          sidebarRight.openTabIn(sessionId, 'terminal', { params: { terminalId: terminal.id } })
        } catch {
          // The seat has not minted its store yet; the next poll retries.
        }
        await delay(JUMP_POLL_MS)
      }
    }

    /**
     * Bring one Host terminal on screen after the Session switch.
     *
     * Wait for `mounted` first: every sidebar command addresses the store that
     * the Session's seat mints when it renders, which happens after the selection
     * changes. Then resolve the tab from the cross-Session inventory, wait until
     * the restored layout carries it, and expand + select it. A terminal with no
     * tab is given one only while it is still running — an exited terminal has no
     * process for a fresh tab to attach to.
     *
     * Nothing here may throw: the panel that asked for the jump has closed.
     */
    async function revealTerminalTab(api, sessionId, terminal) {
      const sidebarRight = api.sidebarRight
      if (!sidebarRight || !terminal) return
      const deadline = Date.now() + JUMP_TIMEOUT_MS
      const mounted = sidebarRight.mounted
      let onScreen
      for (;;) {
        try {
          onScreen = mounted && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : undefined
        } catch {
          onScreen = undefined
        }
        if (onScreen === sessionId || Date.now() >= deadline) break
        await delay(JUMP_POLL_MS)
      }
      // The switch may have been superseded; never write into another Session.
      if (onScreen !== sessionId) return
      let tabId
      const known = terminalTabOf(sidebarRight, api.webTerminals, sessionId, terminal.id)
      if (known !== undefined) tabId = known.tabId
      else if (terminal.state === 'running') tabId = await openBoundTerminalTab(api, sessionId, terminal, deadline)
      if (tabId === undefined) return
      while (Date.now() < deadline) {
        const restored = tabsInOf(sidebarRight, sessionId).some((tab) => tab.id === tabId)
        if (restored && focusSidebarTab(sidebarRight, tabId)) return
        await delay(JUMP_POLL_MS)
      }
      console.warn('[dsh-terminal-hub] terminal ' + terminal.id + ' could not be shown in session ' + sessionId)
    }
    // END terminal-jump helpers

    // ── components ───────────────────────────────────────────────────────────

    /** The sidebar glyph: a terminal window with a prompt caret. */
    function TerminalHubIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18
      const active = props.active === true
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 1.9 : 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block', pointerEvents: 'none' },
      }, [
        h('rect', { key: 'frame', x: 2.75, y: 4.5, width: 18.5, height: 15, rx: 3 }),
        h('path', { key: 'caret', d: 'M6.9 9.6 9.7 12.2 6.9 14.8' }),
        h('path', { key: 'prompt', d: 'M12.4 15.1h4.6' }),
      ])
    }

    /** The terminal overview panel of the main column. */
    function TerminalHubPanel(props) {
      const tr = typeof props.t === 'function' ? props.t : (key) => key
      const resolve = typeof props.resolveServices === 'function' ? props.resolveServices : () => ({ missing: ['services'] })
      const apiRef = React.useRef(undefined)
      apiRef.current = resolve()

      const metaRef = React.useRef(undefined)
      if (metaRef.current === undefined) metaRef.current = loadMeta()

      const [state, setState] = React.useState({ phase: 'loading', groups: [], failures: [], error: undefined, truncated: false })
      const [meta, setMeta] = React.useState(metaRef.current)
      const [notice, setNotice] = React.useState(undefined)
      const [rowErrors, setRowErrors] = React.useState({})
      const [busyId, setBusyId] = React.useState(undefined)
      const [openId, setOpenId] = React.useState(undefined)
      const [aliasDraft, setAliasDraft] = React.useState('')
      const [tagDraft, setTagDraft] = React.useState('')
      const [colorDraft, setColorDraft] = React.useState(DEFAULT_COLOR)
      const [titleEdit, setTitleEdit] = React.useState(undefined)
      const [pendingClose, setPendingClose] = React.useState(undefined)
      const [query, setQuery] = React.useState('')
      const [reloadKey, setReloadKey] = React.useState(0)
      const [tab, setTab] = React.useState(TAB_TERMINALS)
      const [hostsProbe, setHostsProbe] = React.useState({
        phase: 'idle',
        candidates: [],
        shape: undefined,
        sessionId: undefined,
        error: undefined,
        tried: 0,
      })
      const hostsRunRef = React.useRef(-1)
      const jumpTimer = React.useRef(undefined)

      /** Commit one metadata mutation to state and localStorage. */
      const applyMeta = (mutate) => {
        const next = mutate(metaRef.current)
        if (next === metaRef.current) return
        metaRef.current = next
        setMeta(next)
        saveMeta(next)
      }

      React.useEffect(() => () => {
        cancelTimeout(jumpTimer.current)
        jumpTimer.current = undefined
      }, [])

      React.useEffect(() => {
        const api = apiRef.current
        if (api.missing && api.missing.length > 0) {
          setState({ phase: 'error', groups: [], failures: [], error: tr('panel.missing', { services: api.missing.join(', ') }), truncated: false })
          return () => {}
        }

        let cancelled = false
        const releases = []
        const titles = new Map()
        const allRows = sessionRowsOf(api.sessions)
        const rows = allRows.slice(0, SCAN_LIMIT)
        const truncated = allRows.length > rows.length
        for (const row of rows) titles.set(row.id, row.title)
        setState((previous) => ({ ...previous, phase: 'loading', error: undefined, truncated }))

        if (rows.length === 0) {
          setState({ phase: 'ready', groups: [], failures: [], error: undefined, truncated: false })
          return () => {}
        }

        const run = async () => {
          const scanned = await scanAll(api.terminalRemote, rows)
          if (cancelled) return
          setState({ phase: 'ready', groups: scanned.groups, failures: scanned.failures, error: undefined, truncated })

          // A complete read is the only authority for dropping expired records;
          // a partial or truncated scan must never delete a live alias.
          if (scanned.failures.length === 0 && !truncated) {
            const alive = new Set()
            for (const group of scanned.groups) for (const terminal of group.terminals) alive.add(terminal.id)
            applyMeta((previous) => pruneTerminals(previous, alive))
          }

          // Live rosters keep titles and states current for Sessions that have
          // terminals. A Session with none is never watched: the Host keeps no
          // owner for it, so a roster stream there would only fail.
          const webTerminals = api.webTerminals
          if (!webTerminals || typeof webTerminals.watch !== 'function') return
          for (const group of scanned.groups) {
            if (cancelled) return
            try {
              const release = webTerminals.watch(group.sessionId, (terminals) => {
                if (cancelled) return
                const next = Array.isArray(terminals) ? terminals.map(normalizeTerminal) : []
                const title = titles.get(group.sessionId) || group.sessionTitle
                setState((previous) => withGroup(previous, group.sessionId, title, next))
              })
              if (typeof release === 'function') releases.push(release)
            } catch {
              // One stream that cannot open must not take the whole panel down.
            }
          }
        }

        void run().catch((error) => {
          if (cancelled) return
          setState({ phase: 'error', groups: [], failures: [], error: tr('scan.failed', { message: messageOf(error) }), truncated })
        })

        return () => {
          cancelled = true
          for (const release of releases) {
            try {
              release()
            } catch {
              // A dispose failure is already reported by the terminal service.
            }
          }
        }
      }, [reloadKey, tr])

      // ── hosts tab: read the launcher candidates (read-only) ─────────────────

      React.useEffect(() => {
        if (tab !== TAB_HOSTS) return () => {}
        if (hostsRunRef.current === reloadKey) return () => {}
        hostsRunRef.current = reloadKey

        let cancelled = false
        setHostsProbe({ phase: 'loading', candidates: [], shape: undefined, sessionId: undefined, error: undefined, tried: 0 })

        const api = apiRef.current
        // The Gateway resolves `shells`' agent parameter against the calling
        // connection, so probe the catalog in order and keep the first Session that
        // answers instead of assuming any particular one works.
        const sessionIds = sessionRowsOf(api.sessions).map((row) => row.id).slice(0, PROBE_SESSION_LIMIT)
        if (sessionIds.length === 0) {
          setHostsProbe({
            phase: 'ready',
            candidates: [],
            shape: undefined,
            sessionId: undefined,
            error: { code: 'client/no-session', message: 'no listed Session to probe with' },
            tried: 0,
          })
          return () => {}
        }

        const controller = new AbortController()
        const run = async () => {
          const result = await discoverCandidates(api, sessionIds, controller.signal)
          if (cancelled) return
          setHostsProbe({
            phase: 'ready',
            candidates: result.candidates,
            shape: result.shape,
            sessionId: result.sessionId,
            error: result.ok ? undefined : result.error,
            tried: result.tried,
          })
        }
        void run().catch((error) => {
          if (cancelled) return
          setHostsProbe({
            phase: 'ready',
            candidates: [],
            shape: undefined,
            sessionId: undefined,
            error: { code: 'client/threw', message: messageOf(error) },
            tried: 0,
          })
        })

        return () => {
          cancelled = true
          try {
            controller.abort()
          } catch {
            // An aborted probe needs no further cancellation.
          }
        }
      }, [tab, reloadKey])

      // ── actions ────────────────────────────────────────────────────────────

      /**
       * Switch to the terminal's Session and, when the row names one terminal,
       * select that terminal's own right-sidebar tab. The Session switch closes
       * this panel, so the tab work continues on services alone.
       */
      const jumpNow = (sessionId, terminal) => {
        const api = apiRef.current
        if (api.missing && api.missing.length > 0) {
          setNotice(tr('panel.missing', { services: api.missing.join(', ') }))
          return
        }
        const rows = sessionRowsOf(api.sessions)
        if (!rows.some((row) => row.id === sessionId)) {
          setNotice(tr('jump.missing', { id: sessionId }))
          return
        }
        try {
          api.uiWorkspace.openSession(sessionId)
          setNotice(undefined)
        } catch (error) {
          setNotice(tr('jump.failed', { message: messageOf(error) }))
          return
        }
        void revealTerminalTab(api, sessionId, terminal).catch(() => {})
      }

      /** Delay the jump so a double click on the title can cancel it. */
      const scheduleJump = (sessionId, terminal) => {
        if (jumpTimer.current !== undefined) return
        jumpTimer.current = scheduleTimeout(() => {
          jumpTimer.current = undefined
          jumpNow(sessionId, terminal)
        }, JUMP_DELAY_MS)
      }

      const cancelJump = () => {
        cancelTimeout(jumpTimer.current)
        jumpTimer.current = undefined
      }

      const failRow = (terminalId, result) => {
        const text = result && result.missing === true
          ? tr('err.methodMissing', { method: result.method })
          : result && result.code === 'client/unexpected-result'
            ? tr('err.unexpectedResult', { value: result.message })
            : result && result.code === 'hub/cross-session-blocked'
              ? tr('err.crossSession')
              : tr('msg.error', { code: result ? result.code : 'client/unknown', message: result ? result.message : '' })
        setRowErrors((previous) => ({ ...previous, [terminalId]: text }))
      }

      const beginTitleEdit = (terminal) => {
        cancelJump()
        setPendingClose(undefined)
        setOpenId(undefined)
        setRowErrors((previous) => withoutKey(previous, terminal.id))
        const record = metaRef.current.terminals[terminal.id] || {}
        setTitleEdit({
          id: terminal.id,
          sessionId: terminal.sessionId,
          from: terminal.title,
          // Prefill the display name only: an empty box means "no display name yet",
          // and the real title keeps its own line in the row.
          draft: typeof record.alias === 'string' ? record.alias : '',
        })
      }

      /**
       * Set the panel-only display name of one terminal.
       *
       * It never touches the Host title: the DSH terminal header is owned by the
       * terminal UI and the Gateway refuses a rename for any terminal outside the
       * calling session, so writing there cannot work from this panel.
       */
      const submitTitle = (terminal, edit) => {
        const draft = String(edit.draft === undefined ? '' : edit.draft)
        const title = draft.trim()
        if (title.length === 0 || title.length > ALIAS_MAX) {
          setRowErrors((previous) => ({ ...previous, [terminal.id]: tr('err.titleInvalid', { max: ALIAS_MAX }) }))
          return
        }
        setRowErrors((previous) => withoutKey(previous, terminal.id))
        applyMeta((previous) => withTerminalRecord(previous, terminal.id, {
          ...(previous.terminals[terminal.id] || {}),
          alias: title,
        }))
        setTitleEdit(undefined)
        setNotice(tr('msg.renamed', { title }))
      }

      const requestClose = (terminal) => {
        cancelJump()
        setTitleEdit(undefined)
        setOpenId(undefined)
        setPendingClose(terminal.id)
      }

      /** Close the terminal's process in its own Session, cross-session included. */
      const confirmClose = async (terminal, sessionId) => {
        const api = apiRef.current
        setBusyId(terminal.id)
        const result = await callAgentScoped(api.terminalRemote, 'close', sessionId, { id: terminal.id }, [terminal.id])
        setBusyId(undefined)
        setPendingClose(undefined)
        if (!result.ok) {
          failRow(terminal.id, result)
          return
        }
        setRowErrors((previous) => withoutKey(previous, terminal.id))
        setState((previous) => removeTerminalFromState(previous, sessionId, terminal.id))
        applyMeta((previous) => withTerminalRecord(previous, terminal.id, undefined))
        setNotice(tr('msg.closed', { title: displayTitleOf(terminal, metaRef.current.terminals[terminal.id]) }))
        setReloadKey((value) => value + 1)
      }

      const openEditor = (terminal) => {
        cancelJump()
        setTitleEdit(undefined)
        setPendingClose(undefined)
        if (openId === terminal.id) {
          setOpenId(undefined)
          return
        }
        const record = metaRef.current.terminals[terminal.id] || {}
        setAliasDraft(typeof record.alias === 'string' ? record.alias : '')
        setTagDraft(typeof record.tag === 'string' ? record.tag : '')
        setColorDraft(isKnownColor(record.color) ? record.color : DEFAULT_COLOR)
        setOpenId(terminal.id)
      }

      const saveEditor = (terminal) => {
        const alias = String(aliasDraft).trim().slice(0, ALIAS_MAX)
        const tag = String(tagDraft).trim().slice(0, TAG_MAX)
        const color = isKnownColor(colorDraft) ? colorDraft : DEFAULT_COLOR
        applyMeta((previous) => {
          const merged = { ...(previous.terminals[terminal.id] || {}) }
          if (alias !== '') merged.alias = alias
          else delete merged.alias
          if (tag !== '') merged.tag = tag
          else delete merged.tag
          if (tag !== '') merged.color = color
          else delete merged.color
          return withTerminalRecord(previous, terminal.id, merged)
        })
        setOpenId(undefined)
        setNotice(tr('msg.saved'))
      }

      const toggleExited = (sessionId) => {
        applyMeta((previous) => {
          const exitedOpen = { ...previous.exitedOpen }
          if (exitedOpen[sessionId] === true) delete exitedOpen[sessionId]
          else exitedOpen[sessionId] = true
          return { ...previous, exitedOpen }
        })
      }

      // ── render helpers ─────────────────────────────────────────────────────

      const stateLabel = (value) => {
        if (value === 'running') return tr('terminal.state.running')
        if (value === 'failed') return tr('terminal.state.failed')
        return tr('terminal.state.exited')
      }
      const stateColor = (value) => {
        if (value === 'running') return C.running
        if (value === 'failed') return C.failed
        return C.exited
      }
      const originLabel = (value) => (value === 'agent' ? tr('terminal.origin.agent') : tr('terminal.origin.user'))

      const needle = query.trim().toLowerCase()
      const matches = (terminal, group, record) => {
        if (needle === '') return true
        const haystack = [
          primaryTitleOf(terminal, record),
          realTitleOf(terminal, record) || '',
          record && record.alias ? record.alias : '',
          record && record.tag ? record.tag : '',
          terminal.cwd,
          terminal.shellName,
          terminal.shellPath,
          group.sessionTitle,
        ].join(' ').toLowerCase()
        return haystack.indexOf(needle) !== -1
      }

      /** One row: jump target, state, tool affordances, and the panels they open. */
      const renderTerminal = (terminal, group, record, number) => {
        const editing = titleEdit !== undefined && titleEdit.id === terminal.id
        const isOpen = openId === terminal.id
        const error = rowErrors[terminal.id]
        const busy = busyId === terminal.id
        const confirming = pendingClose === terminal.id
        const displayTitle = primaryTitleOf(terminal, record)
        const realTitle = realTitleOf(terminal, record)
        const subParts = []
        // The real title stays visible whenever it is not already the main title.
        if (realTitle !== undefined && realTitle !== displayTitle) subParts.push(realTitle)
        subParts.push(terminal.shellName + ' · ' + (basenameOf(terminal.cwd) || '—'))
        const subText = subParts.join('  ·  ')
        const color = colorOf(record)
        const titleLine = [
          h('span', { key: 'title', style: S.rowTitle }, displayTitle),
          number === undefined ? null : h('span', { key: 'num', style: S.numChip }, '#' + number),
          record && typeof record.tag === 'string' && record.tag !== ''
            ? h('span', { key: 'tag', style: { ...S.tagChip, background: color.background, color: color.color } }, record.tag)
            : null,
        ]

        const line = h('div', { key: 'line', style: S.rowLine }, [
          h('span', { key: 'dot', style: { ...S.dot, background: stateColor(terminal.state) } }),
          editing
            ? h('div', { key: 'editing', style: S.titleEditRow }, [
              h('input', {
                key: 'input',
                type: 'text',
                value: titleEdit.draft,
                maxLength: ALIAS_MAX,
                placeholder: tr('field.aliasPlaceholder', { max: ALIAS_MAX }),
                style: S.titleInput,
                onChange: (event) => setTitleEdit({ ...titleEdit, draft: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void submitTitle(terminal, titleEdit)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    setTitleEdit(undefined)
                  }
                },
                ref: (node) => {
                  if (node && typeof node.focus === 'function' && node.dataset.dshFocused !== 'true') {
                    node.dataset.dshFocused = 'true'
                    node.focus()
                    if (typeof node.select === 'function') node.select()
                  }
                },
              }),
              h('button', {
                key: 'save',
                type: 'button',
                style: S.button,
                disabled: busy,
                onClick: () => { void submitTitle(terminal, titleEdit) },
              }, busy ? '…' : tr('action.save')),
              h('button', {
                key: 'cancel',
                type: 'button',
                style: S.button,
                onClick: () => setTitleEdit(undefined),
              }, tr('action.cancel')),
            ])
            : h('button', {
              key: 'jump',
              type: 'button',
              style: S.jump,
              title: tr('terminal.row.hint'),
              onClick: () => scheduleJump(group.sessionId, terminal),
              onDoubleClick: () => beginTitleEdit({ ...terminal, sessionId: group.sessionId }),
            }, [
              h('span', { key: 'titleLine', style: S.titleLine }, titleLine),
              h('span', {
                key: 'sub',
                style: S.subLine,
                title: terminal.cwd,
              }, subText),
            ]),
          h('span', { key: 'right', style: S.right }, [
            h('span', { key: 'state', style: { ...S.stateText, color: stateColor(terminal.state) } }, stateLabel(terminal.state)),
            h('button', {
              key: 'tools',
              type: 'button',
              style: S.tools,
              title: tr('term.tools'),
              'aria-expanded': isOpen ? 'true' : 'false',
              onClick: () => openEditor(terminal),
            }, isOpen ? '▴' : '⋯'),
          ]),
        ])

        const parts = [line]

        if (error !== undefined) parts.push(h('div', { key: 'error', role: 'alert', style: S.rowError }, error))

        if (confirming) {
          parts.push(h('div', { key: 'confirm', style: S.confirm }, [
            h('span', { key: 'warn' }, tr('hint.closeWarns')),
            h('button', {
              key: 'yes',
              type: 'button',
              style: S.dangerButton,
              disabled: busy,
              onClick: () => { void confirmClose({ ...terminal, sessionId: group.sessionId }, group.sessionId) },
            }, busy ? '…' : tr('action.confirmClose')),
            h('button', {
              key: 'no',
              type: 'button',
              style: S.button,
              onClick: () => setPendingClose(undefined),
            }, tr('action.cancelClose')),
          ]))
        }

        if (isOpen) {
          const colorDots = TAG_COLORS.map((entry) => h('button', {
            key: entry.id,
            type: 'button',
            title: tr('color.' + entry.id),
            'aria-label': tr('color.' + entry.id),
            'aria-pressed': colorDraft === entry.id ? 'true' : 'false',
            style: {
              ...S.colorDot,
              background: entry.background,
              borderColor: colorDraft === entry.id ? C.text : 'transparent',
            },
            onClick: () => setColorDraft(entry.id),
          }))
          parts.push(h('div', { key: 'editor', style: S.editor }, [
            h('div', { key: 'aliasRow', style: S.fieldRow }, [
              h('span', { key: 'label', style: S.fieldLabel }, tr('field.alias')),
              h('input', {
                key: 'input',
                type: 'text',
                value: aliasDraft,
                maxLength: ALIAS_MAX,
                placeholder: tr('field.aliasPlaceholder'),
                style: S.input,
                onChange: (event) => setAliasDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    saveEditor(terminal)
                  }
                },
              }),
            ]),
            h('div', { key: 'tagRow', style: S.fieldRow }, [
              h('span', { key: 'label', style: S.fieldLabel }, tr('field.tag')),
              h('input', {
                key: 'input',
                type: 'text',
                value: tagDraft,
                maxLength: TAG_MAX,
                placeholder: tr('field.tagPlaceholder'),
                style: S.input,
                onChange: (event) => setTagDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    saveEditor(terminal)
                  }
                },
              }),
              h('span', { key: 'colors', style: { display: 'flex', gap: '4px', alignItems: 'center' } }, colorDots),
            ]),
            h('div', { key: 'saveRow', style: S.fieldRow }, [
              h('button', {
                key: 'save',
                type: 'button',
                style: S.button,
                onClick: () => saveEditor(terminal),
              }, tr('action.saveAlias')),
            ]),
            h('div', { key: 'renameRow', style: S.fieldRow }, [
              h('button', {
                key: 'rename',
                type: 'button',
                style: S.button,
                disabled: busy,
                onClick: () => beginTitleEdit(terminal),
              }, tr('action.rename')),
              h('button', {
                key: 'close',
                type: 'button',
                style: S.dangerButton,
                disabled: busy,
                onClick: () => requestClose(terminal),
              }, tr('action.close')),
            ]),
            h('div', { key: 'paths', style: S.hint, title: tr('term.paths', { shell: terminal.shellPath, cwd: terminal.cwd }) },
              terminal.shellName + ' · ' + (basenameOf(terminal.cwd) || '—')
              + ' · ' + tr('term.ids', { id: terminal.id })),
            h('div', { key: 'cross', style: S.hint }, tr('hint.crossSession')),
          ]))
        }

        return h('div', { key: terminal.id, style: S.row }, parts)
      }

      // ── render ─────────────────────────────────────────────────────────────

      const groups = state.groups || []
      const stored = meta.terminals || {}
      const visible = needle === ''
        ? groups.map((group) => ({ group, terminals: group.terminals }))
        : groups
          .map((group) => ({
            group,
            terminals: group.terminals.filter((terminal) => matches(terminal, group, stored[terminal.id])),
          }))
          .filter((entry) => entry.terminals.length > 0)
      const matchedTerminals = visible.reduce((total, entry) => total + entry.terminals.length, 0)
      const totalTerminals = terminalCountOf(groups)

      // Hosts tab: exactly the launcher candidates the terminal controller reported.
      const candidates = hostsProbe.candidates || []
      const candidateMatchesSearch = (candidate) => needle === ''
        || (candidate.name + ' ' + candidate.path + ' ' + candidate.title).toLowerCase().indexOf(needle) !== -1
      const shownCandidates = candidates
        .filter(candidateMatchesSearch)
        .slice()
        // Order by the name the row shows (the executable name without `.cmd`), so
        // `web-01` reads before `web-01-eu`.
        .sort((left, right) => left.title.localeCompare(right.title))
      const hostTabCount = shownCandidates.length
      const hostTotal = candidates.length

      const head = []
      head.push(h('h1', { key: 'title', style: S.title }, tr('panel.title')))
      if (tab !== TAB_HOSTS) {
        head.push(h('span', { key: 'counter', style: S.counter }, state.phase === 'loading'
          ? tr('panel.scanning')
          : needle === ''
            ? tr('panel.groups', { sessions: groups.length, terminals: totalTerminals })
            : tr('panel.matched', { terminals: matchedTerminals })))
      }
      head.push(h('button', {
        key: 'refresh',
        type: 'button',
        style: S.refresh,
        onClick: () => { setNotice(undefined); setRowErrors({}); setPendingClose(undefined); setReloadKey((value) => value + 1) },
      }, tr('panel.refresh')))

      const tabs = h('div', { key: 'tabs', style: S.tabs }, [
        h('button', {
          key: 'terminals',
          type: 'button',
          style: tab === TAB_TERMINALS ? { ...S.tab, ...S.tabActive } : S.tab,
          'aria-pressed': tab === TAB_TERMINALS ? 'true' : 'false',
          onClick: () => setTab(TAB_TERMINALS),
        }, tr('tab.terminals', { count: matchedTerminals })),
        h('button', {
          key: 'hosts',
          type: 'button',
          style: tab === TAB_HOSTS ? { ...S.tab, ...S.tabActive } : S.tab,
          'aria-pressed': tab === TAB_HOSTS ? 'true' : 'false',
          onClick: () => setTab(TAB_HOSTS),
        }, tr('tab.hosts', { count: hostTabCount })),
      ])

      /** Banners that belong to both views (service problems and action outcomes). */
      const globalBody = []
      if (state.error !== undefined) {
        globalBody.push(h('div', { key: 'error', role: 'alert', style: S.error }, String(state.error)))
      }
      if (notice !== undefined) {
        globalBody.push(h('div', { key: 'notice', role: 'alert', style: S.error }, String(notice)))
      }

      /** Scan-quality banners: terminal data only. */
      const terminalBody = []
      if (state.truncated === true) {
        terminalBody.push(h('div', { key: 'truncated', style: S.banner }, tr('panel.truncated', { limit: SCAN_LIMIT })))
      }
      if (state.failures && state.failures.length > 0) {
        terminalBody.push(h('div', { key: 'failures', style: S.banner },
          tr('scan.partial', { count: state.failures.length, detail: state.failures.slice(0, 4).join('; ') })))
      }

      // Provenance and probe shape are diagnostics, not interface: keep them in the
      // console and show only the failure banner a person can act on.
      const hostBody = []
      console.info('[terminal-hub] launcher probe', {
        shape: hostsProbe.shape,
        sessionId: hostsProbe.sessionId,
        tried: hostsProbe.tried,
        candidates: candidates.length,
      })
      if (hostsProbe.phase === 'loading') {
        hostBody.push(h('div', { key: 'probing', style: S.hostsMeta }, tr('hosts.probing')))
      }
      if (hostsProbe.error !== undefined) {
        hostBody.push(h('div', { key: 'shells-error', role: 'alert', style: S.banner },
          tr('hosts.shellsFailed', { code: hostsProbe.error.code, message: hostsProbe.error.message })))
      }

      const list = []
      if (state.phase === 'loading' && groups.length === 0 && state.error === undefined) {
        list.push(h('div', { key: 'loading', style: S.empty }, tr('panel.loading')))
      } else if (state.error === undefined && groups.length === 0 && (state.failures || []).length === 0) {
        list.push(h('div', { key: 'empty', style: S.empty }, [
          h('div', { key: 'text' }, tr('panel.empty')),
          h('div', { key: 'hint', style: S.emptyHint }, tr('panel.empty.hint')),
        ]))
      } else if (state.error === undefined && visible.length === 0 && groups.length > 0) {
        list.push(h('div', { key: 'nomatch', style: S.empty }, tr('panel.noMatch')))
      }

      for (const entry of visible) {
        const group = entry.group
        const numbers = numberingOf(group.terminals)
        const live = []
        const exited = []
        for (const terminal of entry.terminals) {
          if (terminal.state === 'running') live.push(terminal)
          else exited.push(terminal)
        }
        // A search result inside the collapsed tail must not stay invisible.
        const exitedOpen = meta.exitedOpen[group.sessionId] === true || needle !== ''
        const rows = []
        for (const terminal of live) rows.push(renderTerminal(terminal, group, stored[terminal.id], numbers.get(terminal.id)))
        if (exited.length > 0) {
          rows.push(h('button', {
            key: 'exited-toggle',
            type: 'button',
            style: S.exitedToggle,
            'aria-expanded': exitedOpen ? 'true' : 'false',
            onClick: () => toggleExited(group.sessionId),
          }, (exitedOpen ? '▾ ' : '▸ ') + tr('group.exited', { count: exited.length })))
          if (exitedOpen) {
            for (const terminal of exited) rows.push(renderTerminal(terminal, group, stored[terminal.id], numbers.get(terminal.id)))
          }
        }
        list.push(h('section', { key: group.sessionId, style: S.group }, [
          h('div', { key: 'head', style: S.groupHead }, [
            h('span', { key: 'title', style: S.groupTitle, title: group.sessionTitle }, group.sessionTitle),
            h('span', { key: 'count', style: S.groupCount }, tr('group.count', { count: entry.terminals.length })),
          ]),
          ...rows,
        ]))
      }

      // ── hosts list: the candidates themselves, nothing derived ──────────────

      const renderCandidate = (candidate) => h('div', { key: candidate.id, style: S.hostRow }, [
        h('div', { key: 'line', style: S.hostLine }, [
          h('span', { key: 'mark', style: S.hostMark, 'aria-hidden': true },
            h(TerminalHubIcon, { size: 14 })),
          h('div', { key: 'body', style: S.hostBody }, [
            h('div', { key: 'primary', style: S.hostPrimary, title: candidate.name }, candidate.title),
            h('div', { key: 'sub', style: S.hostSub, title: candidate.path }, candidate.path === '' ? '—' : candidate.path),
          ]),
        ]),
      ])

      const hostList = []
      if (hostsProbe.phase === 'loading' && candidates.length === 0) {
        hostList.push(h('div', { key: 'host-probing', style: S.empty }, tr('hosts.probing')))
      } else if (candidates.length === 0) {
        hostList.push(h('div', { key: 'host-unavailable', style: S.empty }, [
          h('div', { key: 'text' }, hostsProbe.error === undefined ? tr('hosts.emptyCandidates') : tr('hosts.noCandidates')),
          h('div', { key: 'hint', style: S.emptyHint }, tr('hosts.triedSessions', { count: hostsProbe.tried })),
        ]))
      } else if (shownCandidates.length === 0) {
        hostList.push(h('div', { key: 'host-nomatch', style: S.empty }, tr('hosts.noMatch')))
      } else {
        for (const candidate of shownCandidates) hostList.push(renderCandidate(candidate))
      }

      return h('div', { style: S.page, 'data-dsh-terminal-hub': '' }, [
        h('div', { key: 'head', style: S.head }, head),
        tabs,
        h('div', { key: 'searchRow', style: S.searchRow }, [
          h('input', {
            key: 'search',
            type: 'search',
            value: query,
            placeholder: tr('panel.searchPlaceholder'),
            style: S.search,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setQuery('')
              }
            },
          }),
        ]),
        ...globalBody,
        ...(tab === TAB_HOSTS ? hostBody : terminalBody),
        h('div', { key: 'scroller', style: S.scroller }, tab === TAB_HOSTS ? hostList : list),
      ])
    }

    /**
     * Client plugin body: dictionaries, the Sidebar entry, and the main panel.
     * @param ctx - Client root Context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'terminal-hub: dictionaries')

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => t('panel.label'),
        locale: NS,
      }, TerminalHubIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ resolveServices: () => resolveServices(ctx) }),
      }, TerminalHubPanel))
    }

    return {
      /** Required client services; the terminal Remote itself is read lazily so an
       * absent one shows an in-panel error instead of leaving the panel unmounted. */
      inject: ['slots', 'locale', 'layout', 'sessions', 'uiWorkspace'],
      apply,
    }
  },
})
