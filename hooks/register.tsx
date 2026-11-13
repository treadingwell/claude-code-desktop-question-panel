import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PanelAnswer, PanelOption, PanelQuestion, PanelSet } from '../types'

const PANE = 'question-panel'
const TITLE = 'Questions'
const TOOL = 'ask_questions'
const TOOL_FULL = 'mcp__question-panel__ask_questions'
const INTERCEPT_KEY = 'interceptAskUserQuestion'
/** How the answers message starts; the panel clears once a prompt starting this way goes in. */
const ANSWERS_MARKER = 'Answers'
const ANSWERS_HEAD = /^Answers \(\d+\/\d+\):/
const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i
/** The muted gray of open badges and the toggle's outline and arrow. */
const MUTED = '#8b8b8b'

// Change the tag when PanelSet's fields change: an older stored value is then
// read as null instead of being misread.
const panel = atom({ plugin: 'question-panel', key: 'set' } as const, null, {
  shape: 'set-1',
})

// ---------- pure helpers (exported for tests) ----------

const emptyAnswer = (): PanelAnswer => ({ selected: [], other: '', notes: '' })

export function normalizeQuestions(raw: unknown): PanelQuestion[] {
  if (!Array.isArray(raw)) return []
  const out: PanelQuestion[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ question: item.trim(), options: [], multiSelect: false })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const q = item as Record<string, unknown>
    const text = typeof q.question === 'string' ? q.question.trim() : ''
    if (!text) continue
    const options: PanelOption[] = Array.isArray(q.options)
      ? q.options
          .map((o): PanelOption | null => {
            const r: Record<string, unknown> =
              typeof o === 'string' ? { label: o } : o && typeof o === 'object' ? (o as Record<string, unknown>) : {}
            if (typeof r.label !== 'string' || !r.label.trim()) return null
            // AskUserQuestion's convention: "Label (Recommended)".
            const tagged = RECOMMENDED_SUFFIX.test(r.label)
            const label = r.label.replace(RECOMMENDED_SUFFIX, '').trim() || r.label.trim()
            const description = typeof r.description === 'string' && r.description.trim() ? r.description.trim() : undefined
            return {
              label,
              ...(description ? { description } : {}),
              ...(r.recommended === true || tagged ? { recommended: true } : {}),
            }
          })
          .filter((o): o is PanelOption => o !== null)
      : []
    out.push({
      question: text,
      ...(typeof q.header === 'string' && q.header.trim() ? { header: q.header.trim() } : {}),
      ...(typeof q.group === 'string' && q.group.trim() ? { group: q.group.trim() } : {}),
      ...(typeof q.recommendation === 'string' && q.recommendation.trim()
        ? { recommendation: q.recommendation.trim() }
        : {}),
      options,
      multiSelect: q.multiSelect === true,
    })
  }
  return out
}

export function isAnswered(a: PanelAnswer | undefined): boolean {
  // Notes never answer a question by themselves: they ride along with one.
  return !!a && (a.selected.length > 0 || a.other.trim() !== '' || a.clarify === true)
}

/** Whether the answer itself (options or text) is given, notes and clarify aside. */
function hasChoice(a: PanelAnswer): boolean {
  return a.selected.length > 0 || a.other.trim() !== ''
}

export function answerSummary(q: PanelQuestion, a: PanelAnswer | undefined): string {
  if (!a || !isAnswered(a)) return ''
  const recommended = new Set(q.options.filter(o => o.recommended).map(o => o.label))
  const parts = a.selected.map(l => (recommended.has(l) ? `${l} (recommended)` : l))
  if (a.other.trim()) parts.push(q.options.length ? `Other: ${a.other.trim()}` : a.other.trim())
  const choice = parts.join(', ')
  if (a.clarify) return `PLEASE CLARIFY: I need more context before answering${choice ? ` (leaning: ${choice})` : ''}`
  return choice
}

/** The recommended answer as a short label, or undefined when there is none. */
export function recommendedLabel(q: PanelQuestion): string | undefined {
  const picks = q.options.filter(o => o.recommended).map(o => o.label)
  if (picks.length) return (q.multiSelect ? picks : picks.slice(0, 1)).join(', ')
  return q.options.length === 0 ? q.recommendation : undefined
}

export function sameAnswer(x: PanelAnswer, y: PanelAnswer): boolean {
  return (
    x.other === y.other &&
    x.selected.length === y.selected.length &&
    x.selected.every(l => y.selected.includes(l))
  )
}

/** Fills an answer with the recommendation, keeping the notes. */
export function applyRecommendation(q: PanelQuestion, a: PanelAnswer): PanelAnswer {
  const picks = q.options.filter(o => o.recommended).map(o => o.label)
  if (picks.length) return { ...a, selected: q.multiSelect ? picks : picks.slice(0, 1) }
  if (q.options.length === 0 && q.recommendation) return { ...a, other: q.recommendation }
  return a
}

/**
 * Questions grouped for display: each named group gathers all its questions
 * (first-seen order); consecutive ungrouped questions form unnamed runs.
 */
export function groupQuestions(qs: PanelQuestion[]): { name?: string; indices: number[] }[] {
  const out: { name?: string; indices: number[] }[] = []
  qs.forEach((q, i) => {
    const named = q.group === undefined ? undefined : out.find(g => g.name === q.group)
    const last = out[out.length - 1]
    if (named) named.indices.push(i)
    else if (q.group === undefined && last && last.name === undefined) last.indices.push(i)
    else out.push(q.group === undefined ? { indices: [i] } : { name: q.group, indices: [i] })
  })
  return out
}

/**
 * A question's number as shown: counted within its group, so "Plan 1: 1, 2, 3"
 * and "Plan 2: 1, 2, 3" keep Claude's own numbering. Ungrouped questions are
 * counted among the ungrouped ones.
 */
export function questionNumber(qs: PanelQuestion[], i: number): number {
  const g = qs[i]?.group
  let n = 0
  for (let k = 0; k <= i; k++) if (qs[k]?.group === g) n++
  return n
}

/** A short label for the answers message: the header, or the question's first words. */
export function shortLabel(q: PanelQuestion): string {
  if (q.header) return q.header
  const words = q.question.replace(/\s+/g, ' ').trim().split(' ')
  return words.length > 6 ? `${words.slice(0, 6).join(' ')}…` : q.question.trim()
}

/**
 * One answer, compact: the picked options, Other, or CLARIFY. Recommendations
 * are not marked: Claude made them and can compare for itself.
 */
function compactAnswer(q: PanelQuestion, a: PanelAnswer): string {
  const parts = [...a.selected]
  if (a.other.trim()) parts.push(q.options.length ? `other: ${a.other.trim()}` : a.other.trim())
  const choice = parts.join(', ')
  if (a.clarify) return choice ? `CLARIFY (leaning: ${choice})` : 'CLARIFY'
  return choice || 'skipped'
}

/**
 * The answers message, compact: Claude has its own questions in context, so
 * each answer carries its number and a short label (in case older turns were
 * summarized), not the question's text.
 */
export function formatAnswers(set: PanelSet): string {
  const total = set.questions.length
  const done = set.questions.filter((_, i) => isAnswered(set.answers[i])).length
  const lines = [`${ANSWERS_MARKER} (${done}/${total}):`]
  for (const g of groupQuestions(set.questions)) {
    if (g.name !== undefined) lines.push(`## ${g.name}`)
    for (const i of g.indices) {
      const q = set.questions[i]!
      const a = set.answers[i] ?? emptyAnswer()
      const n = questionNumber(set.questions, i)
      const notes = a.notes.trim().replace(/\s*\n\s*/g, ' / ')
      lines.push(`${n} ${shortLabel(q)}: ${compactAnswer(q, a)}${notes ? `. note: ${notes}` : ''}`)
    }
  }
  return lines.join('\n')
}

/**
 * With "collapse answered" on: closes question i once it is answered and
 * opens the next unanswered one (after i, else from the top).
 */
export function settle(s: PanelSet, i: number): PanelSet {
  if (!s.collapseAnswered || !isAnswered(s.answers[i])) return s
  const n = s.questions.length
  let next: number | undefined
  for (let k = 1; k < n; k++) {
    const j = (i + k) % n
    if (!isAnswered(s.answers[j])) {
      next = j
      break
    }
  }
  const expanded = s.expanded.filter(x => x !== i)
  if (next !== undefined && !expanded.includes(next)) expanded.push(next)
  return { ...s, expanded }
}

/** Adds questions to the open (unsent) set, or starts a new one. */
export function addQuestions(set: PanelSet | null, qs: PanelQuestion[], id: string): PanelSet {
  if (set && set.sentAt === undefined) {
    const start = set.questions.length
    return {
      ...set,
      questions: [...set.questions, ...qs],
      // keep the toggle as the person left it
      answers: [...set.answers, ...qs.map(emptyAnswer)],
      expanded: set.expanded.length === 0 ? [start] : set.expanded,
    }
  }
  return {
    id,
    questions: qs,
    answers: qs.map(emptyAnswer),
    expanded: qs.length ? [0] : [],
    // a new set keeps the previous set's toggle
    ...(set?.collapseAnswered ? { collapseAnswered: true } : {}),
  }
}

// ---------- the mod ----------

const TOOL_DESCRIPTION = [
  "Shows a set of questions to the user in the Question Panel, a panel docked beside the chat where they answer at their own pace.",
  'Use this INSTEAD of AskUserQuestion whenever you have questions for the user, and always when you have more than 4.',
  'Put ALL your questions in ONE call: there is no limit on how many.',
  'Each question may have options (single-select by default, multiSelect: true for several); the panel always adds a free-text "Other" box and a notes box, so never add an "Other" option yourself.',
  'Questions with no options get a free-text answer box (no notes box).',
  'Give every question a short `header` (1-3 words): it labels the answer in the reply.',
  'Whenever you have a view, give a recommendation: set recommended: true on the option(s) you recommend and put a one-line reason in `recommendation` (for an open-ended question, put your suggested answer there). The user can accept recommendations with one click.',
  'Use `group` for sections: for more than about 6 questions, and whenever your questions come in sets such as "Plan 1" and "Plan 2". Numbering restarts at 1 in each group, so Plan 1 questions 1-3 and Plan 2 questions 1-3 keep their numbers.',
  "After calling this, end your turn immediately without further work. The user's answers arrive as their next message in this compact form: a first line `Answers (answered/total):`, a `## Group` line before each group's answers, then one line per question: `<number> <header>: <answer>`, where the answer is the picked option(s), `other: <text>`, the free-text answer, `skipped`, or `CLARIFY`; `. note: <text>` follows when the user added a note. Match answers to your questions by group and number.",
  'An answer of `CLARIFY` means the user wants that question explained: explain it (what you are asking, why it matters, your recommendation) and ask it again with this tool.',
].join(' ')

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      description: 'Every question to ask, in order. No upper limit.',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The full question.' },
          header: { type: 'string', description: 'Short tag (1-3 words): shown above the question and used to label its answer in the reply.' },
          group: {
            type: 'string',
            description: 'Optional section name, such as "Plan 1". Questions with the same group are shown together under that heading, with their own progress count, numbered from 1 within the group.',
          },
          options: {
            type: 'array',
            description: 'Optional answer choices. Omit for an open-ended question.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
                recommended: { type: 'boolean', description: 'Mark the option you recommend (one, or several for multiSelect).' },
              },
              required: ['label'],
            },
          },
          multiSelect: { type: 'boolean', description: 'Allow several options to be picked.' },
          recommendation: {
            type: 'string',
            description:
              'Your recommendation. With options: one short line on WHY the option(s) marked recommended are best. Without options: the answer you suggest, which the user can accept with one click.',
          },
        },
        required: ['question'],
      },
    },
  },
  required: ['questions'],
}
// `replace` is optional: true starts a fresh set, dropping any unsent questions.
;(TOOL_SCHEMA.properties as Record<string, unknown>).replace = {
  type: 'boolean',
  description: 'Start a fresh set, discarding unsent questions already in the panel. Only when the user asked for that.',
}

const handoffText = (added: number, total: number) =>
  `${added} question(s) are now in the user's Question Panel (${total} in the open set). ` +
  'The user will answer them there at their own pace. If you have more questions, ask them now; ' +
  "otherwise end your turn immediately without further work or commentary beyond a one-line note that the questions are in the panel. Their answers will arrive as the user's next message."

/**
 * A numbered circle: outlined and muted while open, filled green once
 * answered, filled amber when clarification was asked for. Mid-tone colors
 * so it reads on light and dark themes alike.
 */
export function badgeSvg(n: number, state: 'open' | 'answered' | 'clarify'): string {
  const fill = state === 'answered' ? '#2f9e5a' : state === 'clarify' ? '#d08a1a' : 'none'
  const stroke = state === 'open' ? MUTED : fill
  const ink = state === 'open' ? MUTED : '#ffffff'
  const size = n > 99 ? 10 : n > 9 ? 12 : 14
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">` +
    `<circle cx="14" cy="14" r="12.5" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
    `<text x="14" y="14" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="${size}" font-weight="700" fill="${ink}">${n}</text>` +
    `</svg>`
  )
}

/** Escapes text for use inside a Markdown line (a heading). */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_{}[\]()<>#+\-.!|~]/g, c => `\\${c}`).replace(/[\r\n\t]+/g, ' ')
}

/**
 * Puts the formatted answers in the normal prompt box; the person presses
 * Enter to send them, and the panel clears once they are received.
 */
async function fillAnswers($: EngineInterface) {
  const s = await read($, panel)
  if (!s || s.sentAt !== undefined || s.questions.length === 0) return
  await $.prompt.fill({ text: formatAnswers(s), mode: 'replace' })
  $.ui.toast('Answers are in the prompt box: review, then press Enter to send')
}

/**
 * Sends the formatted answers straight to Claude as the person's message,
 * then clears the panel once the message has gone in.
 */
async function submitAnswers($: EngineInterface) {
  const s = await read($, panel)
  if (!s || s.sentAt !== undefined || s.questions.length === 0) return
  // Claim the set before submitting, so a second click while the first is in
  // flight finds it sent and does nothing (it used to send a copy each time).
  let claimed = false
  await update($, panel, cur => {
    claimed = !!cur && cur.id === s.id && cur.sentAt === undefined
    return claimed && cur ? { ...cur, sentAt: Date.now() } : cur
  })
  if (!claimed) return
  const result = await $.prompt.submit({ text: formatAnswers(s), asUser: true })
  if ('drop' in result && result.drop) {
    // Not sent: give the set back.
    await update($, panel, cur => (cur && cur.id === s.id ? { ...cur, sentAt: undefined } : cur))
    return
  }
  await update($, panel, cur =>
    cur && cur.id === s.id ? { ...cur, questions: [], answers: [], expanded: [] } : cur,
  )
  $.ui.toast('Answers sent to Claude')
}

/** Puts questions in the panel and opens it; returns the open set's size. */
async function receive($: EngineInterface, qs: PanelQuestion[], id: string) {
  const after = await update($, panel, set => addQuestions(set, qs, id))
  void $.ui.open({ id: PANE, title: TITLE })
  $.ui.toast(`${qs.length} question(s) added to the Question Panel`)
  return after?.questions.length ?? qs.length
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'questions',
      description: 'Open the Question Panel. "/questions off" lets AskUserQuestion use its own dialog again; "/questions on" routes it to the panel.',
      argumentHint: '[on|off|clear]',
    })
    await $.command.register({
      name: 'ask-me',
      description: 'Ask Claude to put all of its questions about a topic (or the current task) into the Question Panel.',
      argumentHint: '[topic]',
    })
    await $.tool.register({
      name: TOOL,
      description: TOOL_DESCRIPTION,
      inputSchema: TOOL_SCHEMA,
      isDeferred: false,
    })
    return next(e)
  })

  // The mod's own tool: any number of questions.
  on('tool.call', { tool: TOOL_FULL }, async ($, e) => {
    const input = e as { questions?: unknown; replace?: unknown }
    const qs = normalizeQuestions(input.questions)
    if (qs.length === 0) return { deny: 'No questions given: pass questions: [{ question, options?, multiSelect? }, ...].' }
    if (input.replace === true) {
      await update($, panel, s => (s ? { ...s, sentAt: s.sentAt ?? Date.now() } : s))
    }
    const total = await receive($, qs, e.tool_use_id)
    return { result: handoffText(qs.length, total) }
  })

  // The built-in tool: answered here so its dialog never opens.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    // Only Claude's own questions come here. A plugin asking through the dialog
    // ($.ui.ask: a permission check, a confirmation) waits on the person's
    // answer there, so it keeps the dialog.
    if (next.origin.plugin !== 'engine') return next(e)
    if ((await $.store.get(INTERCEPT_KEY)) === false) return next(e)
    const qs = normalizeQuestions(e.questions)
    if (qs.length === 0) return next(e)
    const total = await receive($, qs, e.tool_use_id)
    return {
      result: {
        questions: e.questions,
        answers: {},
        response: '(Moved to the Question Panel: the user has not answered yet.)',
      },
      context: [handoffText(qs.length, total)],
    }
  }).catch(($, e, next) => next(e)) // anything goes wrong: the built-in dialog shows

  on('command.run', { command: 'questions' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await $.store.set(INTERCEPT_KEY, false)
      return { text: 'Question Panel: AskUserQuestion now uses its own dialog. The panel tool still works.' }
    }
    if (arg === 'on') {
      await $.store.set(INTERCEPT_KEY, true)
    }
    if (arg === 'clear') {
      await update($, panel, () => null)
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: arg === 'on' ? 'Question Panel opened; AskUserQuestion goes to the panel.' : 'Question Panel opened.' }
  })

  on('command.run', { command: 'ask-me' }, async ($, e) => {
    const topic = e.args.trim()
    await $.ui.open({ id: PANE, title: TITLE })
    await $.prompt.submit({
      asUser: true,
      text:
        `Before going further, list every question you have for me${topic ? ` about: ${topic}` : ' about the current task'}. ` +
        `Ask them all in a single call to the ${TOOL_FULL} tool (no limit on the number; give options where they help), then end your turn and wait for my answers.`,
    })
    return { text: 'Asked Claude to send its questions to the Question Panel.' }
  })

  // Once the answers message has gone in, clear the panel. Waits for next(e)
  // so a dropped or refused prompt leaves the answers where they were.
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    const wasAnswers = ANSWERS_HEAD.test(e.text.trimStart()) && !('drop' in entered && entered.drop)
    if (wasAnswers) {
      // Keep the Collapse answered toggle for the next set.
      await update($, panel, s => (s ? { ...s, questions: [], answers: [], expanded: [], sentAt: Date.now() } : s))
    }
    return entered
  }).catch(($, e, next) => next(e))

  // Under each question call's row in the chat: a way back to the panel, in
  // case it was closed. Only for calls the panel took.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const p = e.props
    const isOurs =
      p.tool === TOOL_FULL ||
      (p.tool === 'AskUserQuestion' && JSON.stringify(p.output ?? '').includes('Moved to the Question Panel'))
    if (!isOurs || p.isRunning || p.isErrored || p.isInterrupted) return next(e)
    const row = await next(e)
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {row}
        <Box paddingLeft={2}>
          <Button key="open-panel" onPress={() => void $.ui.open({ id: PANE, title: TITLE, focus: true })}>
            Open Question Panel
          </Button>
        </Box>
      </Box>
    )
  })

  // Always-visible band above the prompt while questions wait: progress and
  // the send action, wherever the panel is scrolled.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const set = await read($, panel)
    if (!set || set.sentAt !== undefined || set.questions.length === 0) return next(e)
    const total = set.questions.length
    const done = set.questions.filter((_, i) => isAnswered(set.answers[i])).length
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Text bold>Questions</Text>
        <Text bold color={done === total ? 'success' : 'subtle'}>{`${done}/${total} answered`}</Text>
        <Button key="band-send" variant="primary" onPress={() => void submitAnswers($)}>
          Submit answers
        </Button>
        <Button key="band-open" dimColor onPress={() => void $.ui.open({ id: PANE, title: TITLE })}>
          Show panel
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input, Markdown } = els
    // Desktop draws the number as a circle badge; the terminal has no Svg.
    const Svg = e.surface !== 'terminal' && 'Svg' in els && els.Svg ? els.Svg : undefined
    const set = await read($, panel)

    if (!set || set.questions.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>No questions yet</Text>
          <Text dimColor>
            When Claude asks questions they collect here. Type /ask-me to have Claude send all its questions about the current task.
          </Text>
        </Box>
      )
    }

    const total = set.questions.length
    const done = set.questions.filter((_, i) => isAnswered(set.answers[i])).length
    const isSent = set.sentAt !== undefined
    const allOpen = set.expanded.length === total
    const pendingRecs = set.questions.filter((q, i) => {
      const a = set.answers[i] ?? emptyAnswer()
      return !hasChoice(a) && !a.clarify && recommendedLabel(q) !== undefined
    }).length

    // `decided`: the press settles the question (a single pick, a recommendation,
    // clarify, Enter in the answer box); typing and multi-picks never collapse.
    const edit = (i: number, fn: (a: PanelAnswer, q: PanelQuestion) => PanelAnswer, decided = false) =>
      update($, panel, s => {
        if (!s || s.id !== set.id || !s.questions[i]) return s
        const answers = [...s.answers]
        answers[i] = fn(answers[i] ?? emptyAnswer(), s.questions[i])
        const next = { ...s, answers }
        return decided ? settle(next, i) : next
      })

    const toggleOpen = (i: number) =>
      update($, panel, s =>
        s ? { ...s, expanded: s.expanded.includes(i) ? s.expanded.filter(x => x !== i) : [...s.expanded, i] } : s,
      )

    const pick = (i: number, label: string) =>
      edit(i, (a, q) => {
        if (q.multiSelect) {
          return { ...a, selected: a.selected.includes(label) ? a.selected.filter(l => l !== label) : [...a.selected, label] }
        }
        return { ...a, selected: a.selected[0] === label ? [] : [label] }
      }, !set.questions[i]?.multiSelect)

    // Puts the answers in the normal prompt box; the person presses Enter to
    // send them as their own message. The set is marked sent on that submit.
    const send = () => fillAnswers($)

    const toggleGroup = (indices: number[], isOpen: boolean) =>
      update($, panel, s =>
        s
          ? {
              ...s,
              expanded: isOpen
                ? s.expanded.filter(x => !indices.includes(x))
                : [...new Set([...s.expanded, ...indices])],
            }
          : s,
      )

    const card = (i: number) => {
      const q = set.questions[i]!
      const a = set.answers[i] ?? emptyAnswer()
      const open = set.expanded.includes(i)
      const answered = isAnswered(a)
      const summary = answerSummary(q, a)
      const rec = recommendedLabel(q)
      const num = questionNumber(set.questions, i)
      const followsRec = rec !== undefined && sameAnswer(applyRecommendation(q, a), a)
      return (
        <Box key={`card-${i}`} flexDirection="column" borderStyle="round" paddingX={1}>
          <Box flexDirection="row" gap={1} alignItems="flex-start">
            {Svg ? (
              <Svg
                source={badgeSvg(num, a.clarify ? 'clarify' : answered ? 'answered' : 'open')}
                alt={`Question ${q.group ? `${q.group} ` : ''}${num}, ${a.clarify ? 'clarification requested' : answered ? 'answered' : 'not answered'}`}
                width={28}
                height={28}
              />
            ) : (
              <Text
                bold
                color={a.clarify || answered ? 'inverseText' : 'subtle'}
                backgroundColor={a.clarify ? 'warning' : answered ? 'success' : undefined}
              >
                {` ${num} `}
              </Text>
            )}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              {q.header ? (
                <Text bold color="suggestion" wrap="wrap">{q.header}</Text>
              ) : null}
              <Text bold={open} wrap="wrap">{q.question}</Text>
            </Box>
            {/* An outlined, unfilled toggle: a plain button in a gray-stroked box,
                the arrow in the same gray as the stroke and the open badges. */}
            <Box borderStyle="round" borderColor={MUTED} paddingX={1}>
              <Button key={`q${i}`} plain onPress={() => toggleOpen(i)}>
                <Text bold color={MUTED}>{open ? '▼' : '▶'}</Text>
              </Button>
            </Box>
          </Box>
          {!open && (summary || a.notes.trim() || rec) && (
            <Box flexDirection="column" paddingLeft={2}>
              {a.clarify ? (
                <Text color="warning" wrap="wrap">❓ Asked Claude to clarify</Text>
              ) : hasChoice(a) ? (
                <Text color="success" wrap="wrap">{`→ ${summary}`}</Text>
              ) : rec ? (
                <Text color="claude" wrap="wrap">{`★ Recommended: ${rec}`}</Text>
              ) : null}
              {a.notes.trim() ? <Text dimColor italic wrap="wrap">{`notes: ${a.notes.trim()}`}</Text> : null}
            </Box>
          )}
          {open && (
            <Box flexDirection="column" gap={1} paddingLeft={2}>
              {q.options.length > 0 && (
                <Box flexDirection="column" gap={1}>
                  <Text dimColor italic>{q.multiSelect ? 'Pick any' : 'Pick one'}</Text>
                  {!rec && q.recommendation ? (
                    <Text color="claude" italic wrap="wrap">{`★ ${q.recommendation}`}</Text>
                  ) : null}
                  {(() => {
                    const optionRow = (o: PanelOption, j: number) => {
                      const picked = a.selected.includes(o.label)
                      const glyph = q.multiSelect ? (picked ? '☑' : '☐') : picked ? '◉' : '○'
                      return (
                        <Box key={`q${i}-ob${j}`} flexDirection="column">
                          <Button key={`q${i}-o${j}`} variant={picked ? 'primary' : 'secondary'} onPress={() => pick(i, o.label)}>
                            <Text bold={picked} color={picked ? 'success' : undefined}>{`${glyph} ${o.label}`}</Text>
                          </Button>
                          {o.description ? (
                            <Box paddingLeft={2}>
                              <Text dimColor wrap="wrap">{o.description}</Text>
                            </Box>
                          ) : null}
                        </Box>
                      )
                    }
                    // All recommended options share one bubble, placed where the
                    // first of them stands; the rest keep their order around it.
                    const recIdx = q.options.flatMap((o, j) => (o.recommended ? [j] : []))
                    const rows = []
                    for (let j = 0; j < q.options.length; j++) {
                      const o = q.options[j]!
                      if (o.recommended && j !== recIdx[0]) continue
                      if (!o.recommended) {
                        // Same indent as the bubble's border + padding, so every
                        // option's button starts in the same column.
                        // Terminal: the border is a whole column, so 1 + 1. Desktop:
                        // the border is a hairline, so the padding alone (1).
                        rows.push(
                          <Box key={`q${i}-pad${j}`} paddingLeft={e.surface === 'terminal' ? 2 : 1}>
                            {optionRow(o, j)}
                          </Box>,
                        )
                        continue
                      }
                      rows.push(
                        <Box key={`q${i}-rec`} flexDirection="column" gap={1} borderStyle="round" borderColor="claude" paddingX={1}>
                          <Text color="claude" wrap="wrap">
                            <Text bold color="claude">★ Recommended</Text>
                            {q.recommendation ? `: ${q.recommendation}` : ''}
                          </Text>
                          {recIdx.map(k => optionRow(q.options[k]!, k))}
                        </Box>,
                      )
                    }
                    return rows
                  })()}
                </Box>
              )}
              {q.options.length === 0 && q.recommendation ? (
                <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
                  <Box marginBottom={1}>
                    <Text bold color="claude">★ Suggested</Text>
                  </Box>
                  <Button
                    key={`q${i}-suggest`}
                    variant={followsRec ? 'primary' : 'secondary'}
                    onPress={() => void edit(i, (x, qq) => applyRecommendation(qq, x), true)}
                  >
                    <Text bold={followsRec} color={followsRec ? 'success' : undefined}>{`${followsRec ? '◉' : '○'} ${q.recommendation}`}</Text>
                  </Button>
                </Box>
              ) : null}
              <Box flexDirection="row" gap={1} flexWrap="wrap" paddingLeft={e.surface === 'terminal' ? 2 : 1}>
                <Button
                  key={`q${i}-clarify`}
                  variant={a.clarify ? 'primary' : 'secondary'}
                  onPress={() => void edit(i, x => ({ ...x, clarify: !x.clarify }), !a.clarify)}
                >
                  <Text bold={a.clarify === true} color={a.clarify ? 'warning' : undefined}>
                    {a.clarify ? '❓ Clarification requested (undo)' : '❓ Please clarify'}
                  </Text>
                </Button>
              </Box>
              <Input
                key={`q${i}-other`}
                label={q.options.length ? 'Other' : 'Answer'}
                placeholder={q.options.length ? 'Your own answer (optional)' : 'Type your answer'}
                value={a.other}
                rows={q.options.length ? 2 : 3}
                submitLabel="✓"
                onInput={v => void edit(i, x => ({ ...x, other: v }))}
                onSubmit={v => void edit(i, x => ({ ...x, other: v }), v.trim() !== '')}
              />
              {/* Free-text questions have the Answer box already: no Notes there. */}
              {q.options.length > 0 && <Input
                key={`q${i}-notes`}
                label="Notes"
                placeholder={a.clarify ? 'What is unclear? (optional)' : 'Extra context, sent with your answer (optional)'}
                value={a.notes}
                rows={2}
                onInput={v => void edit(i, x => ({ ...x, notes: v }))}
                onSubmit={v => void edit(i, x => ({ ...x, notes: v }))}
              />}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={done === total ? 'success' : undefined}>
            {`${done}/${total} answered${isSent ? ' · sent' : ''}`}
          </Text>
          <Text dimColor wrap="wrap">
            {isSent
              ? 'Sent. New questions from Claude will start a fresh set.'
              : 'Click ▶ to open a question. "Put answers in prompt" fills the prompt box; press Enter there to send.'}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {!isSent && (
            <Button key="send" variant="primary" onPress={send}>
              {`Put answers in prompt (${done}/${total})`}
            </Button>
          )}
          {!isSent && pendingRecs > 0 && (
            <Button
              key="accept-recs"
              onPress={() =>
                update($, panel, s => {
                  if (!s) return s
                  const filled: PanelSet = {
                    ...s,
                    answers: s.questions.map((qq, k) => {
                      const cur = s.answers[k] ?? emptyAnswer()
                      return hasChoice(cur) || cur.clarify ? cur : applyRecommendation(qq, cur)
                    }),
                  }
                  return filled.collapseAnswered
                    ? { ...filled, expanded: filled.expanded.filter(k => !isAnswered(filled.answers[k])) }
                    : filled
                })
              }
            >
              {`★ Accept recommendations (${pendingRecs})`}
            </Button>
          )}
          <Button
            key="collapse-answered"
            onPress={() =>
              update($, panel, s => {
                if (!s) return s
                const turningOn = !s.collapseAnswered
                return turningOn
                  ? { ...s, collapseAnswered: true, expanded: s.expanded.filter(k => !isAnswered(s.answers[k])) }
                  : { ...s, collapseAnswered: false }
              })
            }
          >
            <Text color={set.collapseAnswered ? 'success' : 'subtle'} bold={set.collapseAnswered === true}>
              {set.collapseAnswered ? '☑' : '☐'}
            </Text>
            {' Collapse answered'}
          </Button>
          <Button
            key="toggle-all"
            onPress={() =>
              update($, panel, s => (s ? { ...s, expanded: allOpen ? [] : s.questions.map((_, i) => i) } : s))
            }
          >
            {allOpen ? 'Collapse all' : 'Expand all'}
          </Button>
          <Button key="clear" dimColor onPress={() => void update($, panel, () => null)}>
            Clear
          </Button>
        </Box>

        {groupQuestions(set.questions).map((g, gi) => {
          if (g.name === undefined) return g.indices.map(card)
          const gDone = g.indices.filter(i => isAnswered(set.answers[i])).length
          const gOpen = g.indices.every(i => set.expanded.includes(i))
          return (
            <Box key={`group-${gi}`} flexDirection="column" gap={1}>
              <Box flexDirection="row" gap={1} alignItems="center">
                <Box flexShrink={1}>
                  {/* A heading: drawn larger and bold, as in a reply. */}
                  <Markdown text={`### ${escapeMarkdown(g.name)}`} />
                </Box>
                <Text bold color={gDone === g.indices.length ? 'success' : 'subtle'}>{`${gDone}/${g.indices.length}`}</Text>
                <Button key={`g${gi}`} plain dimColor onPress={() => toggleGroup(g.indices, gOpen)}>
                  {gOpen ? '▾' : '▸'}
                </Button>
              </Box>
              <Box flexDirection="column" gap={1} paddingLeft={1}>
                {g.indices.map(card)}
              </Box>
            </Box>
          )
        })}

        {/* Only once every question is answered: send from where you finished. */}
        {!isSent && done === total && (
          <Button key="submit-bottom" variant="primary" onPress={() => void submitAnswers($)}>
            Submit answers
          </Button>
        )}
      </Box>
    )
  })
}
