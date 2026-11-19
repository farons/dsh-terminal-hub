/**
 * Regression tests for the per-terminal jump.
 *
 * The jump helpers are part of the hand-written browser bundle, not a separate
 * module, so this test reads client.js and evaluates the block between its
 * sentinels. The shipped plugin stays one file, and the test still runs the exact
 * source that the browser runs.
 *
 * Run with `node --test test/`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const BEGIN = '// BEGIN terminal-jump helpers'
const END = '// END terminal-jump helpers'
const begin = source.indexOf(BEGIN)
const end = source.indexOf(END)
assert.ok(begin >= 0 && end > begin, 'client.js carries the terminal-jump helper sentinels')
const helperBody = source.slice(begin + BEGIN.length, end)

/**
 * Build the helper set from the shipped source.
 * @param timeoutMs - jump deadline for the test (the bundle uses 4000).
 * @param pollMs - poll interval for the test (the bundle uses 50).
 * @param log - console replacement that records warnings.
 */
function helpers(timeoutMs = 400, pollMs = 2, log = console) {
  const build = new Function(
    'scheduleTimeout',
    'JUMP_TIMEOUT_MS',
    'JUMP_POLL_MS',
    'console',
    `${helperBody}
return { tabsInOf, terminalTabsOf, terminalTabOf, focusSidebarTab, openBoundTerminalTab, revealTerminalTab }`,
  )
  return build((callback, ms) => setTimeout(callback, ms), timeoutMs, pollMs, log)
}

/** Let `ms` elapse, then apply a mutation. */
function after(ms, mutate) {
  return new Promise((resolve) => {
    setTimeout(() => {
      mutate()
      resolve()
    }, ms)
  })
}

/**
 * Fake sidebar-right and terminal services with just the surface the helpers read.
 * Commands throw until `ready` flips, reproducing a seat that has not minted its
 * store yet.
 */
function createWorld(options = {}) {
  const sessionId = options.sessionId ?? 'session-1'
  const calls = { focus: [], openTabIn: [], bind: [], toggle: 0 }
  const state = {
    onScreen: options.onScreen,
    ready: false,
    expanded: options.expanded ?? true,
    activeTabId: undefined,
    tabs: [...(options.tabs ?? [])],
    inventory: [...(options.inventory ?? [])],
  }
  const ensure = () => {
    if (!state.ready) throw new Error('sidebarRight: no session surface is mounted')
  }
  const sidebarRight = {
    mounted: { getSnapshot: () => state.onScreen },
    openTabs: { getSnapshot: () => state.inventory },
    tabDomain: {
      occurrence: () => {
        ensure()
        return { navigation: { getSnapshot: () => ({ params: {} }) } }
      },
    },
    tabsIn: () => (state.ready ? state.tabs : []),
    isExpanded: () => {
      ensure()
      return state.expanded
    },
    toggleExpanded: () => {
      ensure()
      state.expanded = !state.expanded
      calls.toggle += 1
    },
    focus: (tabId) => {
      ensure()
      calls.focus.push(tabId)
      state.activeTabId = tabId
    },
    active: () => (state.ready ? { id: state.activeTabId } : undefined),
    openTabIn: (target, kind, openOptions) => {
      ensure()
      calls.openTabIn.push({ sessionId: target, kind, ...openOptions })
      state.tabs = [...state.tabs, { id: 'tab-new', kind, contentId: 'content-new' }]
    },
  }
  const webTerminals = {
    boundTerminal: (_sessionId, contentId) => (options.bindings ?? {})[contentId],
    bind: (_sessionId, contentId, id) => {
      calls.bind.push({ contentId, id })
    },
  }
  return { api: { sidebarRight, webTerminals }, state, calls, sessionId }
}

test('selects the tab already bound to the terminal once the seat mounts', async () => {
  const world = createWorld({
    inventory: [{ sessionId: 'session-1', tabId: 'tab-7', kind: 'terminal', contentId: 'content-7' }],
    bindings: { 'content-7': 'terminal-1' },
    tabs: [{ id: 'tab-7', kind: 'terminal', contentId: 'content-7' }],
    expanded: false,
  })
  const jump = helpers()
  const running = jump.revealTerminalTab(world.api, 'session-1', { id: 'terminal-1', state: 'running' })
  void after(5, () => {
    world.state.onScreen = 'session-1'
  })
  void after(15, () => {
    world.state.ready = true
  })
  await running
  assert.deepEqual(world.calls.focus, ['tab-7'])
  assert.equal(world.calls.toggle, 1)
  assert.equal(world.state.expanded, true)
  assert.equal(world.state.activeTabId, 'tab-7')
  assert.equal(world.calls.openTabIn.length, 0)
})

test('opens and binds a tab for a running terminal this window does not show', async () => {
  const world = createWorld()
  const jump = helpers()
  const running = jump.revealTerminalTab(world.api, 'session-1', { id: 'terminal-9', state: 'running' })
  void after(5, () => {
    world.state.onScreen = 'session-1'
    world.state.ready = true
  })
  await running
  assert.equal(world.calls.openTabIn.length, 1)
  assert.deepEqual(world.calls.openTabIn[0].params, { terminalId: 'terminal-9' })
  assert.deepEqual(world.calls.bind, [{ contentId: 'content-new', id: 'terminal-9' }])
  assert.equal(world.state.activeTabId, 'tab-new')
})

test('leaves an exited terminal without a tab alone', async () => {
  const world = createWorld()
  const jump = helpers()
  const running = jump.revealTerminalTab(world.api, 'session-1', { id: 'terminal-2', state: 'exited' })
  void after(5, () => {
    world.state.onScreen = 'session-1'
    world.state.ready = true
  })
  await running
  assert.equal(world.calls.openTabIn.length, 0)
  assert.equal(world.calls.focus.length, 0)
})

test('does nothing without a sidebar service instead of throwing', async () => {
  const jump = helpers()
  await jump.revealTerminalTab({ webTerminals: {} }, 'session-1', { id: 'terminal-1', state: 'running' })
})

test('warns when the tab never becomes the active one', async () => {
  const warnings = []
  const world = createWorld({
    inventory: [{ sessionId: 'session-1', tabId: 'tab-7', kind: 'terminal', contentId: 'content-7' }],
    bindings: { 'content-7': 'terminal-1' },
    tabs: [{ id: 'tab-7', kind: 'terminal', contentId: 'content-7' }],
  })
  world.api.sidebarRight.active = () => ({ id: 'tab-other' })
  const jump = helpers(60, 2, { warn: (message) => warnings.push(message) })
  const running = jump.revealTerminalTab(world.api, 'session-1', { id: 'terminal-1', state: 'running' })
  void after(5, () => {
    world.state.onScreen = 'session-1'
    world.state.ready = true
  })
  await running
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /terminal-1/)
})

test('the bundle loads and registers its sidebar entry and main panel', () => {
  let loaded
  const React = {
    createElement: () => ({}),
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useMemo: (build) => build(),
    useCallback: (callback) => callback,
  }
  const requireStub = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  }
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (definition) => { loaded = definition } } },
    console,
    require: requireStub,
    setTimeout,
    clearTimeout,
  })
  vm.runInContext(source, context)
  assert.ok(loaded, 'the bundle called the module loader')
  assert.equal(loaded.id, 'dsh-terminal-hub')
  const module = loaded.factory(requireStub)
  assert.equal(typeof module.apply, 'function')
  assert.ok(module.inject.includes('uiWorkspace'))

  const registered = []
  const ctx = {
    locale: { bind: () => (key) => key, register: () => () => {} },
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: {
      inject: (_slot, register) => {
        register()
        return () => {}
      },
      register: (definition) => {
        registered.push(definition.name)
        return () => {}
      },
    },
  }
  module.apply(ctx)
  assert.deepEqual(registered.sort(), ['main', 'sidebar.panellist'])
})
