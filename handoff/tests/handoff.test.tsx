import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMeasureInput, SessionMessage } from 'claude-code'

const BAND = {
  plugin: 'handoff',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const CWD = '/Users/me/projects/demo-app'
const KEY = `pointer:${CWD}`
const NOW = Date.UTC(2026, 9, 31, 10, 0)

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const resumes = (prompts: string[]) => prompts.filter(p => p.startsWith('Resume from my handoff'))
const pointer = (ago: number, sessionId: string) => ({
  dir: '/h',
  briefPath: '/h/brief.md',
  transcriptPath: '/h/transcript.md',
  at: NOW - ago,
  pending: 3,
  sessionId,
})

// Stands for the engine beneath the mod: a store, files and one session.
// `own` names the events a test answers itself. Returns the prompts the mod submits.
const engine = (on: On, sessionId: string, store: Map<string, unknown>, files: Map<string, string>, own: string[] = []) => {
  const prompts: string[] = []
  on('session.id', () => ({ value: sessionId }))
  on('session.cwd', () => ({ value: CWD }))
  if (!own.includes('clock')) {
    on('clock.now', () => ({ value: NOW }))
  }
  on('env.get', () => ({ value: '/Users/me' }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }))
  on('turn.complete', (_, e) => ({ text: e.answer ?? '' }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  if (!own.includes('fs.write')) {
    on('fs.write', (_, e) => (files.set(e.path, e.text), { value: undefined }))
  }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  if (!own.includes('session.usage')) {
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  }
  if (!own.includes('prompt.submit')) {
    on('prompt.submit', (_, e) => (prompts.push(e.text), { text: e.text }))
  }
  on('session.end', () => ({ sessionId }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return prompts
}

test('a failed brief still keeps the transcript and offers Retry', async ($, on) => {
  const store = new Map<string, unknown>()
  const files = new Map<string, string>()
  engine(on, 's1', store, files)
  on('session.messages', (): { value: SessionMessage[] } => ({ value: [{ role: 'user', text: 'hello', toolUses: [] }] }))
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: USAGE } }))

  const out = await $.command.run({ ...RUN, command: 'handoff' })

  expect(out.text).toContain('empty-reply')
  expect([...files.keys()].some(p => p.endsWith('transcript.md'))).toBe(true)
  expect(store.has(KEY)).toBe(false)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button', key: 'retry' })).toBeDefined()
  await ui.unmount()
})

test('after /clear the next conversation starts by itself with the brief, once', async ($, on) => {
  const store = new Map<string, unknown>([[KEY, pointer(0, 's1')]])
  const prompts = engine(on, 's1', store, new Map(), ['clock'])
  const clock = mock.clock(on, { now: NOW })

  // The session that wrote it does nothing until it is cleared.
  await clock.advance(5_000)
  expect(resumes(prompts)).toHaveLength(0)

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(5_000)
  expect(resumes(prompts)).toHaveLength(1)
  expect(prompts[0]).toContain('/h/brief.md')

  // Clearing the resumed conversation does not start it again.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(5_000)
  expect(resumes(prompts)).toHaveLength(1)
})

test('Skip before the resume fires keeps it from starting', async ($, on) => {
  const store = new Map<string, unknown>([[KEY, pointer(60_000, 'old')]])
  const prompts = engine(on, 'new', store, new Map(), ['clock'])
  const clock = mock.clock(on, { now: NOW })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  await $.command.run({ ...RUN, command: 'handoff-skip' })
  await clock.advance(5_000)
  expect(resumes(prompts)).toHaveLength(0)
})

test('a handoff older than two days waits for Load', async ($, on) => {
  const store = new Map<string, unknown>([[KEY, pointer(3 * 86_400_000, 'old')]])
  const prompts = engine(on, 'new', store, new Map(), ['clock'])
  const clock = mock.clock(on, { now: NOW })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  await clock.advance(5_000)
  expect(resumes(prompts)).toHaveLength(0)

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'load' })
  await ui.unmount()
  expect(resumes(prompts)).toHaveLength(1)
})

test('a refused resume prompt shows where the brief is', async ($, on) => {
  const store = new Map<string, unknown>([[KEY, pointer(60_000, 'old')]])
  engine(on, 'new', store, new Map(), ['clock', 'prompt.submit'])
  const clock = mock.clock(on, { now: NOW })
  on('prompt.submit', () => {
    throw new Error('policy')
  })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await clock.advance(5_000)

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /could not resume/ }))?.text).toContain('/h/brief.md')
  await ui.unmount()
  expect(store.get(KEY)).not.toEqual(expect.objectContaining({ resumedBy: 'new' }))
})

const measure = (percent: number): SessionMeasureInput => ({
  context: { window: 1_000_000, percent },
  rateLimits: [],
  changed: ['context'],
})

test('with a 200k compaction window on a 1M model, the button comes before compaction', async ($, on) => {
  engine(on, 's1', new Map(), new Map(), ['session.usage'])
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        window: 1_000_000,
        breakdown: {
          categories: [],
          totalTokens: 0,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          autocompactSource: 'model-default',
          percentage: 0,
          gridRows: [],
          model: 'claude-opus-5-5',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          autoCompactThreshold: 160_000,
          isAutoCompactEnabled: true,
          apiUsage: null,
        },
      },
      rateLimits: [],
    },
  }))

  // Compaction runs at 16% of the model's window; the button shows by 11%.
  await $.session.measure(measure(11))
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button', key: 'handoff' })).toBeDefined()
  await ui.unmount()
})

test('Later hides the button until the fill grows 5 more points', async ($, on) => {
  engine(on, 's1', new Map(), new Map())
  await $.session.measure(measure(72))
  let ui = await $.ui.mount(BAND)
  await ui.press({ key: 'later' })
  await ui.unmount()

  await $.session.measure(measure(75))
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button', key: 'handoff' })).toBeUndefined()
  await ui.unmount()

  await $.session.measure(measure(77))
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button', key: 'handoff' })).toBeDefined()
  await ui.unmount()
})

test('the transcript keeps tool output, cut when long', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, 's1', new Map(), files)
  on('session.messages', (): { value: SessionMessage[] } => ({
    value: [
      {
        role: 'assistant',
        text: 'Running the tests.',
        toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'npm test' }, text: `FAIL scan.test.ts\n${'x'.repeat(5000)}`, isError: true }],
      },
    ],
  }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '# Handoff brief', usage: USAGE } }))

  await $.command.run({ ...RUN, command: 'handoff' })

  const transcript = [...files.entries()].find(([p]) => p.endsWith('transcript.md'))?.[1] ?? ''
  expect(transcript).toContain('FAIL scan.test.ts')
  expect(transcript).toContain('more characters cut')
})

test('a write that throws leaves Retry, not a stuck band', async ($, on) => {
  engine(on, 's1', new Map(), new Map(), ['fs.write'])
  on('session.messages', (): { value: SessionMessage[] } => ({ value: [] }))
  on('fs.write', () => {
    throw new Error('EACCES')
  })

  const out = await $.command.run({ ...RUN, command: 'handoff' })

  expect(out.text).toMatch(/^Handoff failed: /)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button', key: 'retry' })).toBeDefined()
  await ui.unmount()
})

// The bug seen live: the button ran /handoff through $.command.run, which skips
// the calling plugin's own hooks, so nothing answered it.
test('pressing the Handoff button writes a handoff', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, 's1', new Map(), files)
  on('command.run', () => ({ text: 'no hook answered' }))
  on('session.messages', (): { value: SessionMessage[] } => ({ value: [{ role: 'user', text: 'hello', toolUses: [] }] }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '# Handoff brief\n- [ ] one', usage: USAGE } }))
  await $.session.measure(measure(72))

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'handoff' })
  await ui.unmount()

  expect([...files.keys()].some(p => p.endsWith('brief.md'))).toBe(true)
})

// A resumed session has nothing to fork until a turn ends: the conversation
// writes the brief as a turn instead, and the end of that turn saves it.
test('with nothing to fork, Claude writes the brief as a turn and it is saved', async ($, on) => {
  const store = new Map<string, unknown>()
  const files = new Map<string, string>()
  const prompts = engine(on, 's1', store, files, ['clock'])
  const clock = mock.clock(on, { now: NOW })
  on('session.messages', (): { value: SessionMessage[] } => ({ value: [{ role: 'user', text: 'hello', toolUses: [] }] }))
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))

  await $.command.run({ ...RUN, command: 'handoff' })
  await clock.advance(10)
  const asked = prompts.find(p => p.includes('Write the brief with the Write tool'))
  const briefPath = asked?.match(/exactly this file: (\S+)/)?.[1]
  expect(briefPath).toBeDefined()
  expect(store.has(KEY)).toBe(false)

  // The turn writes the file, then ends.
  files.set(briefPath!, '# Handoff brief\n- [ ] one\n- [ ] two')
  await $.turn.complete({ answer: 'Brief written.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(store.get(KEY)).toEqual(expect.objectContaining({ pending: 2, sessionId: 's1' }))
  expect(files.get(briefPath!)).toContain('Full transcript of the earlier session')
})
