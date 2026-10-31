import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Band } from '../types'

// Show the button at this fill, or lower when auto-compact would run first.
const THRESHOLD = 70
// A handoff older than this asks before it loads.
const FRESH_MS = 48 * 60 * 60 * 1000
// Long enough to read the band and press Skip; the prompt then waits for the session to be idle.
const RESUME_DELAY_MS = 4000

// Change the tag when Band's fields change: it declines what an earlier
// version stored, which outlives a reload.
const band = atom({ plugin: 'handoff', key: 'band' } as const, { phase: 'hidden' } as Band, {
  shape: 'band-2',
})

type Pointer = {
  dir: string
  briefPath: string
  transcriptPath: string
  at: number
  pending: number
  sessionId: string
  // The session that loaded it, or 'skipped' / 'done'.
  resumedBy?: string
}

const BRIEF_PROMPT = `Write a handoff brief for this conversation. A fresh Claude Code session will continue the work from it with no other memory of this conversation, so it must stand alone. Be specific: real file paths, commands, numbers, names, IDs. No preamble; output only the markdown below.

# Handoff brief

## Task in progress
What we are working on, why, and exactly how far it got. The very next step.

## Questions raised and their status
EVERY question the user asked or that came up in this conversation, one per bullet. For each: the answer and how it was reached, or "OPEN" and what is needed to answer it. Do not drop any.

## Pending
One "- [ ] " checkbox line per unfinished item, most important first. Include things promised but not done, and verifications not yet run.

## Decisions
Each decision made and the reason, including approaches tried and rejected.

## Files and state
Files created or changed (absolute paths) and what changed; branches, commits, running processes, uncommitted work, data files.

## Gotchas
Things that went wrong or surprised us, and the user's corrections and preferences stated in this conversation.

## Skills, memories and tools to use
Skills, memory notes, MCP tools, scripts or commands the next session should load or reuse.

Do not add a line pointing to the transcript: one is appended for you.`

const pointerKey = (cwd: string) => `pointer:${cwd}`
const slug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
// Local time, so the folder name matches the clock the person reads.
const stamp = (ms: number) => {
  const local = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)

  return local.toISOString().slice(0, 19).replace(/[:T]/g, '-')
}
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const countPending = (brief: string) => (brief.match(/^\s*- \[ \]/gm) ?? []).length

// Long tool output is cut so the transcript stays readable; the cut is marked.
const RESULT_CHARS = 4000
const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters cut]` : text
const fence = (text: string) => `\`\`\`\n${text.replace(/\`\`\`/g, "'''")}\n\`\`\``

const toMarkdown = (messages: SessionMessage[]) => {
  // A result already printed under its call is not printed again.
  const shown = new Set(messages.flatMap(m => m.toolUses.filter(t => t.text !== undefined).map(t => t.tool_use_id)))
  let last: string | undefined

  return messages
    .map(m => {
      const uses = m.toolUses.map(t => {
        const call = `**${t.tool}** \`${cut(JSON.stringify(t.input), 600)}\``
        const out = t.text === undefined ? '' : `\n${t.isError ? 'Error:\n' : ''}${fence(cut(t.text, RESULT_CHARS))}`

        return call + out
      })
      const results = (m.toolResults ?? [])
        .filter(r => !shown.has(r.tool_use_id))
        .map(r => `${r.isError ? 'Tool error' : 'Tool result'}:\n${fence(cut(r.text, RESULT_CHARS))}`)
      const body = [m.text, ...uses, ...results].filter(Boolean)
      if (body.length === 0) {
        return ''
      }
      // One heading per run of rows from the same speaker.
      const who = m.role === 'user' ? 'User' : 'Claude'
      const heading = who === last ? [] : [`## ${who}`]
      last = who

      return [...heading, ...body].join('\n\n')
    })
    .filter(Boolean)
    .join('\n\n')
}

// Starts the next conversation's first turn with a prompt that has Claude read
// the brief file. A prompt rides the turn's own request: a row appended at
// turn start was stored after the person's prompt and missed the first request.
async function resume($: EngineInterface) {
  const cwd = await $.session.cwd()
  const ptr = (await $.store.get(pointerKey(cwd))) as Pointer | undefined
  if (!ptr || ptr.resumedBy !== undefined) {
    return
  }
  const sessionId = await $.session.id()
  await $.store.set(pointerKey(cwd), { ...ptr, resumedBy: sessionId })
  const text = `Resume from my handoff of ${when(ptr.at)}. Read the brief at ${ptr.briefPath} first: it is what the earlier session knew, and the full transcript is at ${ptr.transcriptPath} if a detail is missing. Load the skills and memories it lists. Then tell me briefly where the task stands, the open questions and the pending list, and wait for me before starting any work.`
  try {
    await $.prompt.submit({ text, asUser: true })
    await update($, band, (): Band => ({ phase: 'resumed', at: ptr.at, pending: ptr.pending }))
  } catch (error) {
    await $.store.set(pointerKey(cwd), ptr)
    const reason = error instanceof Error ? error.message : String(error)
    await update($, band, (): Band => ({ phase: 'failed', note: `could not resume (${reason}); ask Claude to read ${ptr.briefPath}` }))
  }
}

// Where a handoff's files go, kept while Claude writes the brief as a turn.
type Draft = { dir: string; briefPath: string; transcriptPath: string; at: number }
const draftKey = (cwd: string) => `draft:${cwd}`

// Shared by /handoff and the band's buttons. A button can't run /handoff through
// $.command.run: that call skips the calling plugin's own hooks.
async function startHandoff($: EngineInterface) {
  await update($, band, (b): Band => ({ ...b, phase: 'working' }))
  try {
    return await writeHandoff($)
  } catch (error) {
    const note = `failed: ${error instanceof Error ? error.message : String(error)}`
    await update($, band, (): Band => ({ phase: 'failed', note }))

    return { text: `Handoff ${note}` }
  }
}

async function skipHandoff($: EngineInterface) {
  const cwd = await $.session.cwd()
  const ptr = (await $.store.get(pointerKey(cwd))) as Pointer | undefined
  if (!ptr) {
    return { text: 'No saved handoff for this folder.' }
  }
  await $.store.set(pointerKey(cwd), { ...ptr, resumedBy: 'skipped' })
  await update($, band, (): Band => ({ phase: 'hidden' }))

  return { text: 'Saved handoff will not load. It stays on disk at ' + ptr.dir }
}

// Adds the transcript line, records the pointer the next session reads, and shows Saved.
async function saveBrief($: EngineInterface, draft: Draft, text: string) {
  const brief = `${text.trim()}\n\n---\nFull transcript of the earlier session: ${draft.transcriptPath}\n`
  await $.fs.write(draft.briefPath, brief)
  const pending = countPending(brief)
  const ptr: Pointer = { ...draft, pending, sessionId: await $.session.id() }
  await $.store.set(pointerKey(await $.session.cwd()), ptr)
  await update($, band, (): Band => ({ phase: 'done', at: draft.at, pending }))
  $.ui.toast(`Handoff saved · ${pending} pending`)

  return { text: `Handoff saved to ${draft.dir}\nRun /clear (or open a new session here) and it resumes by itself.` }
}

async function submitBriefTurn($: EngineInterface, text: string) {
  try {
    await $.prompt.submit({ text })
  } catch (error) {
    await $.store.delete(draftKey(await $.session.cwd()))
    const reason = error instanceof Error ? error.message : String(error)
    await update($, band, (): Band => ({ phase: 'failed', note: `could not ask Claude for the brief (${reason})` }))
  }
}

// Saves the transcript first, then the brief, then the pointer the next session reads.
async function writeHandoff($: EngineInterface) {
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? '~'
  const at = await $.clock.now()
  const dir = `${home}/.claude/handoffs/${slug(cwd)}/${stamp(at)}`
  const transcriptPath = `${dir}/transcript.md`
  const briefPath = `${dir}/brief.md`

  // The raw record first, so it exists even if the brief fails.
  const messages = await $.session.messages()
  await $.fs.write(transcriptPath, `# Transcript: ${cwd}\n\n_Saved ${when(at)}_\n\n${toMarkdown(messages)}\n`)

  const draft: Draft = { dir, briefPath, transcriptPath, at }
  const fork = await $.model.fork({ prompt: BRIEF_PROMPT })
  if (fork.isAnswered) {
    return saveBrief($, draft, fork.text)
  }
  if (fork.reason === 'nothing-to-fork') {
    // A resumed or just-started session has no snapshot to fork until a turn
    // ends, so the conversation itself writes the brief; turn.complete saves it.
    await $.store.set(draftKey(cwd), draft)
    // A command (or a press) can't submit a prompt itself: the new turn would wait
    // on the dispatch that's still running. A timer submits it right after.
    const text = `${BRIEF_PROMPT}\n\nWrite the brief with the Write tool to exactly this file: ${briefPath}\nThen reply with one line: Brief written.`
    $.clock.after(0, () => void submitBriefTurn($, text))
    await update($, band, (): Band => ({ phase: 'working', note: 'Claude is writing the brief' }))

    return { text: `No snapshot to fork yet, so Claude is writing the brief as a turn. Transcript saved: ${transcriptPath}` }
  }
  const note = `brief failed (${fork.reason}); transcript saved`
  await update($, band, (): Band => ({ phase: 'failed', note }))

  return { text: `Handoff ${note}: ${transcriptPath}` }
}

export const register: Register = on => {
  let threshold: number | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'handoff', description: 'Save a handoff brief and transcript for the next session' })
    await $.command.register({ name: 'handoff-skip', description: 'Do not load the saved handoff in this session' })

    const ptr = (await $.store.get(pointerKey(e.cwd))) as Pointer | undefined
    const sessionId = await $.session.id()
    if (ptr && ptr.resumedBy === undefined && sessionId !== ptr.sessionId) {
      const isFresh = (await $.clock.now()) - ptr.at < FRESH_MS
      await update($, band, (): Band => ({ phase: isFresh ? 'waiting' : 'stale', at: ptr.at, pending: ptr.pending }))
      if (isFresh) {
        $.clock.after(RESUME_DELAY_MS, () => void resume($))
      }
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const percent = e.context.percent
    if (percent === undefined) {
      return next(e)
    }
    if (threshold === undefined) {
      // Both sides over the model's window: `percent` is tokens / window, and a
      // compaction window may be smaller than the model's.
      const { context } = await $.session.usage({ breakdown: 'summary' })
      const b = context.breakdown
      const compactAt =
        b?.isAutoCompactEnabled && b.autoCompactThreshold
          ? Math.floor((b.autoCompactThreshold / e.context.window) * 100) - 5
          : THRESHOLD
      threshold = Math.max(1, Math.min(THRESHOLD, compactAt))
    }
    const current = await read($, band)
    const isShowable =
      current.phase === 'ready' ||
      (current.phase === 'hidden' && (current.dismissedAt === undefined || percent >= current.dismissedAt + 5))
    if (percent >= threshold && isShowable) {
      await update($, band, (): Band => ({ phase: 'ready', percent }))
    } else if (current.phase === 'ready' && percent < threshold - 10) {
      // Compacted under the line: the button waits for the fill to come back.
      await update($, band, (): Band => ({ phase: 'hidden' }))
    }

    return next(e)
  })

  on('command.run', { command: 'handoff' }, async $ => startHandoff($))

  on('command.run', { command: 'handoff-skip' }, async $ => skipHandoff($))

  // Finishes a handoff whose brief the conversation wrote as a turn.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      return result
    }
    const cwd = await $.session.cwd()
    const draft = (await $.store.get(draftKey(cwd))) as Draft | undefined
    if (!draft) {
      return result
    }
    await $.store.delete(draftKey(cwd))
    const text = await $.fs.read(draft.briefPath).catch(() => undefined)
    if (text === undefined) {
      await update($, band, (): Band => ({ phase: 'failed', note: 'Claude did not write the brief; transcript saved' }))
    } else {
      await saveBrief($, draft, text)
    }

    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const cwd = await $.session.cwd()
      const ptr = (await $.store.get(pointerKey(cwd))) as Pointer | undefined
      // The ending conversation's id: after a /clear the process runs on under a new one.
      if (ptr?.resumedBy === e.sessionId) {
        // A second clear drops the brief that was loaded.
        await $.store.set(pointerKey(cwd), { ...ptr, resumedBy: 'done' })
        await update($, band, (): Band => ({ phase: 'hidden' }))
      } else if (ptr && ptr.resumedBy === undefined) {
        await update($, band, (): Band => ({ phase: 'waiting', at: ptr.at, pending: ptr.pending }))
        $.clock.after(RESUME_DELAY_MS, () => void resume($))
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, band)
    if (e.props.hasSurvey || b.phase === 'hidden') {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const hide = () => update($, band, (): Band => ({ phase: 'hidden', dismissedAt: b.percent }))
    // Only for other plugins' and built-in commands: a plugin's own command run
    // this way skips its own hooks, so Handoff and Skip call their functions.
    const run = (command: string, fallback: string) => () =>
      void $.command.run({ command }).catch(() => $.ui.toast(fallback))
    const since = b.at === undefined ? '' : ` · ${when(b.at)}`
    const pending = b.pending === undefined ? '' : ` · ${b.pending} pending`

    switch (b.phase) {
      case 'ready':
        return (
          <Box gap={1}>
            <Text color="warning">Context {b.percent}%</Text>
            <Button key="handoff" label="Handoff" variant="primary" onPress={() => void startHandoff($)} />
            <Button key="later" label="Later" role="dismiss" onPress={hide} />
          </Box>
        )
      case 'working':
        return <Text dimColor>{b.note ?? 'Writing handoff'}…</Text>
      case 'failed':
        return (
          <Box gap={1}>
            <Text color="error">Handoff: {b.note}</Text>
            <Button key="retry" label="Retry" onPress={() => void startHandoff($)} />
          </Box>
        )
      case 'done':
        return (
          <Box gap={1}>
            <Text color="success">Handoff saved{pending}</Text>
            <Button key="fresh" label="Start fresh" variant="primary" onPress={run('clear', 'Type /clear to start fresh; the handoff resumes by itself')} />
            <Button key="dismiss" label="Dismiss" role="dismiss" onPress={hide} />
          </Box>
        )
      case 'waiting':
        return (
          <Box gap={1}>
            <Text dimColor>Resuming from handoff{since}{pending}…</Text>
            <Button key="skip" label="Skip" role="dismiss" onPress={() => void skipHandoff($)} />
          </Box>
        )
      case 'stale':
        return (
          <Box gap={1}>
            <Text dimColor>Older handoff{since}{pending}</Text>
            <Button key="load" label="Load" onPress={() => void resume($)} />
            <Button key="skip" label="Skip" role="dismiss" onPress={() => void skipHandoff($)} />
          </Box>
        )
      case 'resumed':
        return (
          <Box gap={1}>
            <Text color="success">Resumed from handoff{since}{pending}</Text>
            <Button key="dismiss" label="Hide" role="dismiss" onPress={hide} />
          </Box>
        )
    }
  })
}
