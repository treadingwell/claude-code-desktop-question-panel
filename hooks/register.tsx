import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { OtherSession, OtherSessions, PanelAnswer, PanelDrafts, PanelOption, PanelQuestion, PanelSet, PanelView } from '../types'

const PANE = 'question-panel'
const TITLE = 'Questions'
const TOOL = 'ask_questions'
const TOOL_FULL = 'mcp__question-panel__ask_questions'
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
// Typed text waiting to be saved into the set (see PanelDrafts). Written on
// every key, read only when saving, so typing never redraws the panel.
const drafts = atom({ plugin: 'question-panel', key: 'drafts' } as const, {} as PanelDrafts, {
  shape: 'drafts-1',
})
/** How long typing must pause before the typed text is saved into the set. */
const DRAFT_SAVE_MS = 700

// ---------- all sessions (setting allSessions) ----------
// Each session writes its open questions to <dir>/<session id>.json and
// reads the others' files every SYNC_MS. Answers for another session go to
// <dir>/inbox/<its id>--<n>.json; that session submits them as the person's
// prompt and empties the file ($.fs has no delete, so an empty file is a gone one).
const others = atom({ plugin: 'question-panel', key: 'others' } as const, {} as OtherSessions, { shape: 'others-1' })
const view = atom({ plugin: 'question-panel', key: 'view' } as const, 'this' as PanelView, { shape: 'view-1' })
const SYNC_MS = 3000
/** A running session rewrites its file at least this often. */
const HEARTBEAT_MS = 15000
/** A file not rewritten for this long belongs to a session that is not running. */
const STALE_MS = 45000

/** The shape of a session's file in the shared folder. */
export type SessionFile = {
  v: 1
  id: string
  label: string
  cwd: string
  updatedAt: number
  endedAt?: number
  setId: string
  questions: PanelQuestion[]
}

/** The label a session goes by: the name Claude gave it, else folder · short id. */
export function sessionLabel(given: string | undefined, cwd: string, id: string): string {
  if (given?.trim()) return given.trim()
  const folder = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd
  return `${folder} · ${id.slice(0, 8)}`
}

/** This session's file content: its open questions, or '' when it has none. */
export function sessionFileText(set: PanelSet | null, id: string, cwd: string, now: number, endedAt?: number): string {
  if (!set || set.sentAt !== undefined || set.questions.length === 0) return ''
  const file: SessionFile = {
    v: 1,
    id,
    label: sessionLabel(set.sessionLabel, cwd, id),
    cwd,
    updatedAt: now,
    ...(endedAt !== undefined ? { endedAt } : {}),
    setId: set.id,
    questions: set.questions,
  }
  return JSON.stringify(file)
}

/** Reads a session file's text; undefined for an empty or unreadable one. */
export function parseSessionFile(text: string): SessionFile | undefined {
  if (!text.trim()) return undefined
  try {
    const f = JSON.parse(text) as SessionFile
    if (f?.v !== 1 || typeof f.id !== 'string' || !Array.isArray(f.questions) || typeof f.setId !== 'string') return undefined
    return f
  } catch {
    return undefined
  }
}

/**
 * Another session as this panel keeps it: its questions from the file, the
 * answers given here kept while the same set stands; a new set starts over.
 */
export function mergeOther(cur: OtherSession | undefined, f: SessionFile): OtherSession {
  const sameSet = cur?.set.id === f.setId
  const set: PanelSet = sameSet && cur
    ? {
        ...cur.set,
        questions: f.questions,
        answers: f.questions.map((_, i) => cur.set.answers[i] ?? emptyAnswer()),
      }
    : { id: f.setId, questions: f.questions, answers: f.questions.map(emptyAnswer), expanded: f.questions.length ? [0] : [] }
  return {
    id: f.id,
    label: f.label,
    cwd: f.cwd,
    updatedAt: f.updatedAt,
    ...(f.endedAt !== undefined ? { endedAt: f.endedAt } : {}),
    set,
  }
}

/** Whether another session is running, judged by its file's age. */
export const isRunning = (o: OtherSession, now: number) => o.endedAt === undefined && now - o.updatedAt < STALE_MS

/** Where the shared files live: <Claude config dir>/question-panel/sessions. */
async function sharedDir($: EngineInterface): Promise<string | undefined> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? undefined
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? undefined
  const base = config || (home ? `${home.replace(/[\\/]+$/, '')}/.claude` : undefined)
  return base ? `${base.replace(/\\/g, '/')}/question-panel/sessions` : undefined
}

/** What one session's sync loop remembers between ticks. */
type SyncState = {
  dir?: string
  /** This session's id as of the last tick (it changes on /clear). */
  id?: string
  cwd: string
  lastText: string
  lastWriteAt: number
  /** mtime of each other session's file as last read. */
  seen: Record<string, number>
  /** Inbox files taken but not yet submitted, so two ticks never send one twice. */
  taking: Set<string>
}

/**
 * One sync tick: writes this session's file when it changed (or for the
 * heartbeat), reads the other sessions' files that changed, and submits any
 * answers waiting in this session's inbox.
 */
async function syncTick($: EngineInterface, st: SyncState, deliver: boolean) {
  st.dir ??= await sharedDir($)
  const dir = st.dir
  if (!dir) return
  const now = Date.now()
  const id = await $.session.id()
  if (st.id === undefined) {
    // First tick (a start or a resume): questions this session left open,
    // still in its file, come back into the panel.
    const f = parseSessionFile(await $.fs.read(`${dir}/${id}.json`).catch(() => ''))
    const local = await read($, panel)
    if (f && (!local || local.questions.length === 0 || local.sentAt !== undefined)) {
      await update($, panel, s => ({
        ...addQuestions(null, f.questions, f.setId),
        ...(s?.collapseAnswered === false ? { collapseAnswered: false } : {}),
        ...(f.label ? { sessionLabel: f.label } : {}),
      }))
    }
  } else if (st.id !== id) {
    // /clear: the conversation goes on under a new id; the old file goes.
    await $.fs.write(`${dir}/${st.id}.json`, '').catch(() => undefined)
    st.lastText = ''
  }
  st.id = id
  const own = sessionFileText(await read($, panel), id, st.cwd, now)
  // Compare without the timestamp, which changes every time.
  const sig = own.replace(/"updatedAt":\d+,/, '')
  if (sig !== st.lastText || (own && now - st.lastWriteAt >= HEARTBEAT_MS)) {
    if (own || st.lastText) await $.fs.write(`${dir}/${id}.json`, own)
    st.lastText = sig
    st.lastWriteAt = now
  }

  const entries = await $.fs.list(dir).catch(() => [])
  const present = new Set<string>()
  const changed: SessionFile[] = []
  for (const ent of entries) {
    if (ent.kind !== 'file' || !ent.name.endsWith('.json')) continue
    const otherId = ent.name.slice(0, -5)
    if (otherId === id || ent.size === 0) continue
    present.add(otherId)
    if (st.seen[otherId] === ent.mtimeMs) continue
    const f = parseSessionFile(await $.fs.read(`${dir}/${ent.name}`).catch(() => ''))
    st.seen[otherId] = ent.mtimeMs
    if (f) changed.push(f)
    else present.delete(otherId)
  }
  for (const k of Object.keys(st.seen)) if (!present.has(k)) delete st.seen[k]
  const cur = await read($, others)
  const gone = Object.keys(cur).filter(k => !present.has(k))
  if (changed.length || gone.length) {
    await update($, others, all => {
      const merged: OtherSessions = { ...all }
      for (const k of gone) delete merged[k]
      for (const f of changed) merged[f.id] = mergeOther(merged[f.id], f)
      return merged
    })
  }

  if (!deliver) return
  const inbox = await $.fs.list(`${dir}/inbox`).catch(() => [])
  for (const ent of inbox) {
    if (ent.kind !== 'file' || ent.size === 0 || !ent.name.startsWith(`${id}--`) || st.taking.has(ent.name)) continue
    const path = `${dir}/inbox/${ent.name}`
    st.taking.add(ent.name)
    try {
      const text = await $.fs.read(path).catch(() => '')
      let msg: { text?: unknown; setId?: unknown } | undefined
      try {
        msg = JSON.parse(text) as { text?: unknown; setId?: unknown }
      } catch {
        msg = undefined
      }
      if (typeof msg?.text !== 'string' || !msg.text.trim()) {
        await $.fs.write(path, '')
        continue
      }
      // Take it first (empty the file), so another copy of the mod never sends it too.
      await $.fs.write(path, '')
      const result = await $.prompt.submit({ text: msg.text, asUser: true })
      if ('drop' in result && result.drop) {
        await $.fs.write(path, text) // not taken: try again next tick
        continue
      }
      // A prompt the mod submits skips the mod's own prompt.submit hook, so the
      // answered questions are cleared here (the set they answer, or any open
      // set when the sender did not say which).
      const setId = typeof msg.setId === 'string' ? msg.setId : undefined
      await update($, panel, s =>
        s && s.sentAt === undefined && (setId === undefined || s.id === setId)
          ? { ...s, questions: [], answers: [], expanded: [], sentAt: Date.now() }
          : s,
      )
      $.ui.toast('Answers from another session were sent to Claude')
    } finally {
      st.taking.delete(ent.name)
    }
  }
}

/** Sends the answers given here for another session to that session's inbox. */
async function submitOther($: EngineInterface, otherId: string, dir: string | undefined) {
  await commitDrafts($)
  const all = await read($, others)
  const o = all[otherId]
  if (!dir || !o || o.set.sentAt !== undefined || o.set.questions.length === 0) return
  const text = formatAnswers(o.set)
  await $.fs.write(`${dir}/inbox/${otherId}--${Date.now()}.json`, JSON.stringify({ text, setId: o.set.id }))
  await update($, others, cur => (cur[otherId] ? { ...cur, [otherId]: { ...cur[otherId]!, set: { ...cur[otherId]!.set, sentAt: Date.now() } } } : cur))
  $.ui.toast(
    isRunning(o, Date.now())
      ? `Answers sent to "${o.label}"`
      : `Answers saved for "${o.label}": they are sent when that session is opened again`,
  )
}

export const draftKey = (setId: string, i: number, field: 'other' | 'notes') => `${setId}|${i}|${field}`

/** The set with the drafts typed into it applied to its answers. */
export function applyDrafts(set: PanelSet, d: PanelDrafts): PanelSet {
  const prefix = `${set.id}|`
  let answers: PanelAnswer[] | undefined
  for (const [key, text] of Object.entries(d)) {
    if (!key.startsWith(prefix)) continue
    const [, idx, field] = key.split('|')
    const i = Number(idx)
    if (!Number.isInteger(i) || !set.questions[i] || (field !== 'other' && field !== 'notes')) continue
    answers ??= [...set.answers]
    answers[i] = { ...(answers[i] ?? { selected: [], other: '', notes: '' }), [field]: text }
  }
  return answers ? { ...set, answers } : set
}

/** Saves typed drafts into the set (one redraw), then forgets the saved ones. */
async function commitDrafts($: EngineInterface) {
  const d = await read($, drafts)
  if (Object.keys(d).length === 0) return
  await update($, panel, s => (s ? applyDrafts(s, d) : s))
  // Drafts typed into another session's questions (all-sessions view).
  const ids = new Set(Object.keys(d).map(k => k.split('|')[0]))
  const all = await read($, others)
  if (Object.values(all).some(o => ids.has(o.set.id))) {
    await update($, others, cur => {
      const merged: OtherSessions = {}
      for (const [k, o] of Object.entries(cur)) merged[k] = ids.has(o.set.id) ? { ...o, set: applyDrafts(o.set, d) } : o
      return merged
    })
  }
  await update($, drafts, cur => {
    const rest = { ...cur }
    for (const key of Object.keys(d)) if (rest[key] === d[key]) delete rest[key]
    return rest
  })
}

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

/** "Collapse answered" is on unless the person turned it off (unset = on). */
export function collapsing(s: PanelSet): boolean {
  return s.collapseAnswered !== false
}

/**
 * With "collapse answered" on (or `force`, for a multi-select's Done button):
 * closes question i once it is answered and opens the next unanswered one
 * (after i, else from the top).
 */
export function settle(s: PanelSet, i: number, force = false): PanelSet {
  if ((!collapsing(s) && !force) || !isAnswered(s.answers[i])) return s
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
    // a new set keeps the previous set's toggle (on unless turned off)
    ...(set?.collapseAnswered === false ? { collapseAnswered: false } : {}),
  }
}

// ---------- the mod ----------

const TOOL_DESCRIPTION = [
  "Shows a set of questions to the user in the Question Panel, a panel docked beside the chat where they answer at their own pace.",
  'Use this INSTEAD of AskUserQuestion whenever you have questions for the user, and always when you have more than 4.',
  'Put ALL your questions in ONE call: there is no limit on how many.',
  'Each question may have options (single-select by default, multiSelect: true for several); the panel always adds a free-text "Other" box and a notes box, so never add an "Other" option yourself.',
  'Questions with no options get a free-text answer box (no notes box).',
  'Question text and option descriptions are drawn as Markdown: write context or inline choices such as "A) … B) …" on separate lines (the panel also splits them), and name files by path (absolute, or relative to the project folder) or as Markdown links: the panel makes them clickable.',
  'Give every question a short `header` (1-3 words): it labels the answer in the reply.',
  'Always set `session`: a short name (3-6 words) for what this session is working on, such as "Question Panel: all-sessions view". The user may have several sessions asking questions, and this name tells them which one is asking.',
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
;(TOOL_SCHEMA.properties as Record<string, unknown>).session = {
  type: 'string',
  description: 'A short name (3-6 words) for what this session is working on, so the user can tell which session is asking.',
}

const handoffText = (added: number, total: number) =>
  `${added} question(s) are now in the user's Question Panel (${total} in the open set). ` +
  'The user will answer them there at their own pace. If you have more questions, ask them now; ' +
  "otherwise end your turn immediately without further work or commentary beyond a one-line note that the questions are in the panel. Their answers will arrive as the user's next message."

/**
 * A numbered circle, drawn locally as an SVG image. Its `xmlns` value is the
 * standard SVG namespace name, which every SVG document carries; nothing is
 * fetched from that address.
 *
 * Outlined and muted while open, filled green once
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

// ---------- question text: lists on their own lines, file paths as links ----------

/** A `file:` URL for an absolute path (`C:\a b\c.ts` or `/a/b.ts`). */
export function fileUrl(abs: string): string {
  const p = abs.replace(/\\/g, '/')
  const enc = encodeURI(p).replace(/[#?()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return /^[A-Za-z]:\//.test(p) ? `file:///${enc}` : `file://${enc}`
}

/** Joins a relative path onto a folder, resolving `.` and `..`. */
export function joinPath(dir: string, rel: string): string {
  const parts = dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 1) parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/')
}

const LINE_SUFFIX = /(:\d+(?::\d+)?)$/
const WIN_ABS = /^[A-Za-z]:[\\/]/
const SEG = String.raw`[\w.@+-]+`
/** A path written bare in prose: absolute (Windows or Unix, two parts or more) or relative with an extension. */
const BARE_PATH = new RegExp(
  String.raw`(^|[\s(“"'])(` +
    String.raw`[A-Za-z]:[\\/](?:${SEG}[\\/])*${SEG}` +
    String.raw`|/(?:${SEG}/)+${SEG}` +
    String.raw`|(?:\.{1,2}[\\/])?(?:${SEG}[\\/])+${SEG}\.[A-Za-z0-9]{1,8}` +
    String.raw`)(:\d+(?::\d+)?)?(?=$|[\s)”"',;:!?]|\.(?:\s|$))`,
  'g',
)

/**
 * The absolute path a written path names, or undefined when it is not a
 * path: absolute as written, or relative to the session's folder.
 */
export function resolvePath(raw: string, cwd: string): string | undefined {
  const p = raw.trim()
  if (!p || /\s{2}|[<>|*?"\n]/.test(p) || /^[a-z]+:\/\//i.test(p)) return undefined
  if (WIN_ABS.test(p)) return p
  if (p.startsWith('/')) return p.split('/').filter(Boolean).length >= 2 ? p : undefined
  if (!cwd || !/[\\/]/.test(p) || /\s/.test(p)) return undefined
  if (!/\.[A-Za-z0-9]{1,8}$/.test(p) && !/[\\/]$/.test(p)) return undefined
  return joinPath(cwd, p)
}

const escLabel = (s: string) => s.replace(/[[\]\\]/g, c => `\\${c}`)

/** Turns file paths in one stretch of prose (no code or links in it) into links. */
function linkBare(s: string, cwd: string): string {
  return s.replace(BARE_PATH, (all, lead: string, path: string, line: string | undefined) => {
    const abs = resolvePath(path, cwd)
    return abs ? `${lead}[${escLabel(path + (line ?? ''))}](${fileUrl(abs)})` : all
  })
}

/** Turns file paths into `file:` links, leaving code blocks, links and URLs alone. */
export function linkPaths(text: string, cwd: string): string {
  // Code spans, existing links and URLs are kept as written; a code span that
  // is a whole path becomes a link with a code label.
  const TOKEN = /(```[\s\S]*?```|`[^`\n]+`|!?\[[^\]\n]*\]\([^)\n]*\)|<[a-z]+:[^>\s]+>|\b[a-z]+:\/\/[^\s)]+)/gi
  let out = ''
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    out += linkBare(text.slice(last, m.index), cwd)
    const tok = m[0]
    if (/^`[^`]/.test(tok)) {
      const inner = tok.slice(1, -1)
      const line = inner.match(LINE_SUFFIX)?.[1] ?? ''
      const abs = resolvePath(line ? inner.slice(0, -line.length) : inner, cwd)
      out += abs ? `[${tok}](${fileUrl(abs)})` : tok
    } else out += tok
    last = (m.index ?? 0) + tok.length
  }
  return out + linkBare(text.slice(last), cwd)
}

/**
 * Puts inline choices written in one run, such as "A) … B) … C) …" or
 * "1. … 2. …", each on its own line. Only a run that starts at A, a or 1 and
 * goes on to B, b or 2 counts, so "plan B) " or "version 2. " alone stay put.
 */
export function splitInlineLists(text: string): string {
  const styles: { re: RegExp; first: string; second: string }[] = [
    { re: /(^|\s)(\(?)([A-H])\)\s/g, first: 'A', second: 'B' },
    { re: /(^|\s)(\(?)([a-h])\)\s/g, first: 'a', second: 'b' },
    { re: /(^|\s)(\(?)([1-9]\d?)\)\s/g, first: '1', second: '2' },
    { re: /(^|\s)()([1-9]\d?)\.\s/g, first: '1', second: '2' },
  ]
  return text
    .split('\n')
    .map(line => {
      for (const st of styles) {
        const labels = [...line.matchAll(st.re)].map(m => m[3])
        const i = labels.indexOf(st.first)
        if (i < 0 || labels[i + 1] !== st.second) continue
        return line.replace(st.re, (all: string, lead: string, paren: string, label: string, off: number) =>
          off === 0 && lead === '' ? all : `\n${paren}${label}${all.slice(lead.length + paren.length + label.length)}`,
        )
      }
      return line
    })
    .join('\n')
}

/**
 * A question's text as Markdown: inline choices on their own lines, a blank
 * line between lines so each stands apart, file paths as clickable links, and
 * the opening paragraph bold while the question is open.
 */
export function questionMarkdown(text: string, cwd: string, bold = false): string {
  const src = text.replace(/\r\n?/g, '\n').trim()
  const fenced = src.includes('```')
  const paras = fenced
    ? [src]
    : splitInlineLists(src)
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
  const linked = paras.map(p => linkPaths(p, cwd))
  const head = linked[0]
  if (bold && !fenced && head !== undefined && !/[*_]{2}/.test(head) && !/^(#|>|[-*+] |\d+[.)] )/.test(head)) {
    linked[0] = `**${head}**`
  }
  return linked.join('\n\n')
}

/**
 * Puts the formatted answers in the normal prompt box; the person presses
 * Enter to send them, and the panel clears once they are received.
 */
async function fillAnswers($: EngineInterface) {
  await commitDrafts($)
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
  await commitDrafts($)
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
async function receive($: EngineInterface, qs: PanelQuestion[], id: string, label?: string) {
  const after = await update($, panel, set => {
    const added = addQuestions(set, qs, id)
    const name = label?.trim() || set?.sessionLabel
    return name ? { ...added, sessionLabel: name } : added
  })
  void $.ui.open({ id: PANE, title: TITLE })
  $.ui.toast(`${qs.length} question(s) added to the Question Panel`)
  return after?.questions.length ?? qs.length
}

export const register: Register = (on, options) => {
  // Desktop-only by default: a terminal session keeps the built-in question
  // prompt and gets no panel, band, tool or commands. Setting "surfaces" to
  // "everywhere" turns the panel on in terminals too. session.start runs again
  // on every reload, so this is always set before the other hooks matter.
  const everywhere = (options as { surfaces?: unknown }).surfaces === 'everywhere'
  // Settings, not anything read from the machine: whether Claude's built-in
  // question prompt (AskUserQuestion) goes to the panel. A change reloads the mod.
  const redirectBuiltin = (options as { redirectBuiltin?: unknown }).redirectBuiltin !== false
  // Setting: show every session's questions, in an "All sessions" tab.
  const allSessions = (options as { allSessions?: unknown }).allSessions === true
  let active = true
  // The pending "save typed text" timer, restarted on each key.
  let draftTimer: Timer | undefined
  let syncTimer: Timer | undefined
  const sync: SyncState = { cwd: '', lastText: '', lastWriteAt: 0, seen: {}, taking: new Set() }
  let syncing = false

  on('session.start', async ($, e, next) => {
    active = everywhere || e.surface !== 'terminal'
    if (!active) return next(e)
    // The session's folder: relative file paths in questions link from here.
    sync.cwd = e.cwd
    if (allSessions) {
      syncTimer?.cancel()
      // A tick never overlaps the one before it.
      const tick = async () => {
        if (syncing) return
        syncing = true
        try {
          await syncTick($, sync, true)
        } catch {
          // a missed tick is retried by the next one
        } finally {
          syncing = false
        }
      }
      syncTimer = $.clock.every(SYNC_MS, () => tick())
      void tick()
    }
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
    const input = e as { questions?: unknown; replace?: unknown; session?: unknown }
    const qs = normalizeQuestions(input.questions)
    if (qs.length === 0) return { deny: 'No questions given: pass questions: [{ question, options?, multiSelect? }, ...].' }
    if (input.replace === true) {
      await update($, panel, s => (s ? { ...s, sentAt: s.sentAt ?? Date.now() } : s))
    }
    const total = await receive($, qs, e.tool_use_id, typeof input.session === 'string' ? input.session : undefined)
    return { result: handoffText(qs.length, total) }
  })

  // The built-in tool: answered here so its dialog never opens.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    // Only Claude's own questions come here. Another plugin asking through the
    // dialog (a permission check, a confirmation) waits on the person's answer
    // there, so it keeps the dialog.
    if (!active || next.origin.plugin !== 'engine') return next(e)
    if (!redirectBuiltin) return next(e)
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
    // on/off change the plugin's own setting (redirectBuiltin), as /config does.
    if (arg === 'off') {
      await $.config.set({ key: 'question-panel.redirectBuiltin', value: false })
      return { text: 'Question Panel: AskUserQuestion now uses its own dialog. The panel tool still works.' }
    }
    if (arg === 'on') {
      await $.config.set({ key: 'question-panel.redirectBuiltin', value: true })
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

  // Mark this session's file ended, so other panels show it as not running
  // (its questions stay, and answers sent to it wait in its inbox).
  on('session.end', async ($, e, next) => {
    if (allSessions && active && sync.dir) {
      syncTimer?.cancel()
      const text = sessionFileText(await read($, panel), e.sessionId, sync.cwd, Date.now(), Date.now())
      await $.fs.write(`${sync.dir}/${e.sessionId}.json`, text).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

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
    if (!active) return next(e)
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
    if (!active || e.props.hasSurvey) return next(e)
    const set = await read($, panel)
    const elsewhere = allSessions
      ? Object.values(await read($, others)).filter(o => o.set.questions.length > 0 && o.set.sentAt === undefined).length
      : 0
    const mine = !!set && set.sentAt === undefined && set.questions.length > 0
    if (!mine && elsewhere === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const showAll = async () => {
      await update($, view, () => 'all')
      await $.ui.open({ id: PANE, title: TITLE })
    }
    if (!mine || !set) {
      return (
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Text bold>Questions</Text>
          <Text color="subtle">{`waiting in ${elsewhere} other session${elsewhere === 1 ? '' : 's'}`}</Text>
          <Button key="band-all" dimColor onPress={() => void showAll()}>
            Show
          </Button>
        </Box>
      )
    }
    const total = set.questions.length
    const done = set.questions.filter((_, i) => isAnswered(set.answers[i])).length
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
        {elsewhere > 0 && (
          <Button key="band-all" plain dimColor onPress={() => void showAll()}>
            {`+${elsewhere} other session${elsewhere === 1 ? '' : 's'}`}
          </Button>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!active) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input, Markdown } = els
    // Desktop draws the number as a circle badge; the terminal has no Svg.
    const Svg = e.surface !== 'terminal' && 'Svg' in els && els.Svg ? els.Svg : undefined
    const local = await read($, panel)
    const tab: PanelView = allSessions ? await read($, view) : 'this'
    const otherList = allSessions
      ? Object.values(await read($, others))
          .filter(o => o.set.questions.length > 0)
          .sort((a, b) => b.updatedAt - a.updatedAt)
      : []
    const now = Date.now()
    const localOpen = !!local && local.questions.length > 0 && local.sentAt === undefined
    const waitingElsewhere = otherList.filter(o => o.set.sentAt === undefined).length

    // The two tabs, only with the all-sessions setting on.
    const tabs = allSessions ? (
      <Box key="tabs" flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="tab-this" variant={tab === 'this' ? 'primary' : 'secondary'} onPress={() => void update($, view, () => 'this')}>
          This session
        </Button>
        <Button key="tab-all" variant={tab === 'all' ? 'primary' : 'secondary'} onPress={() => void update($, view, () => 'all')}>
          {`All sessions${waitingElsewhere + (localOpen ? 1 : 0) > 0 ? ` (${waitingElsewhere + (localOpen ? 1 : 0)})` : ''}`}
        </Button>
      </Box>
    ) : null

    const empty = (
      <Box flexDirection="column" gap={1}>
        <Text bold>No questions yet</Text>
        <Text dimColor>
          When Claude asks questions they collect here. Type /ask-me to have Claude send all its questions about the current task.
        </Text>
      </Box>
    )

    /** One set of questions and how to change it: this session's, or another's. */
    type Target = {
      /** Prefix for every key, so two sets never share one ('' for this session). */
      k: string
      set: PanelSet
      update: (fn: (s: PanelSet) => PanelSet | null) => Promise<unknown>
      submit: () => Promise<void>
      /** Only this session's answers can go into this session's prompt box. */
      fill?: () => Promise<void>
      /** Absent while another session is running (its questions are its own). */
      clear?: () => Promise<void>
      other?: OtherSession
      /** The asking session's folder, for file paths written relative to it. */
      cwd: string
    }

    const setView = (t: Target) => {
    const set = t.set
    const k = t.k
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
    // Typing goes to the drafts, which the panel does not draw from, so a key
    // never redraws the panel (that redraw put back older text and lost keys).
    // The text is saved into the set once typing pauses, or before any other
    // action redraws the panel.
    const typed = (i: number, field: 'other' | 'notes', v: string) => {
      void update($, drafts, d => ({ ...d, [draftKey(set.id, i, field)]: v }))
      draftTimer?.cancel()
      draftTimer = $.clock.after(DRAFT_SAVE_MS, () => void commitDrafts($))
    }

    const edit = async (i: number, fn: (a: PanelAnswer, q: PanelQuestion) => PanelAnswer, decided = false) => {
      await commitDrafts($)
      return t.update(s => {
        if (s.id !== set.id || !s.questions[i]) return s
        const answers = [...s.answers]
        answers[i] = fn(answers[i] ?? emptyAnswer(), s.questions[i])
        const changed = { ...s, answers }
        return decided ? settle(changed, i) : changed
      })
    }

    // Any other action that redraws the panel saves the typed text first.
    const saveThen = (fn: (s: PanelSet) => PanelSet | null) => async () => {
      await commitDrafts($)
      await t.update(fn)
    }

    const toggleOpen = (i: number) =>
      saveThen(s => ({ ...s, expanded: s.expanded.includes(i) ? s.expanded.filter(x => x !== i) : [...s.expanded, i] }))()

    const pick = (i: number, label: string) =>
      edit(i, (a, q) => {
        if (q.multiSelect) {
          return { ...a, selected: a.selected.includes(label) ? a.selected.filter(l => l !== label) : [...a.selected, label] }
        }
        return { ...a, selected: a.selected[0] === label ? [] : [label] }
      }, !set.questions[i]?.multiSelect)

    // Puts the answers in the normal prompt box; the person presses Enter to
    // send them as their own message. The set is marked sent on that submit.
    const send = () => void t.fill?.()

    const toggleGroup = (indices: number[], isOpen: boolean) =>
      saveThen(s => ({
        ...s,
        expanded: isOpen ? s.expanded.filter(x => !indices.includes(x)) : [...new Set([...s.expanded, ...indices])],
      }))()

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
        <Box key={`${k}card-${i}`} flexDirection="column" borderStyle="round" paddingX={1}>
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
              <Markdown key={`${k}q${i}-text`} text={questionMarkdown(q.question, t.cwd, open)} />
            </Box>
            {/* An outlined, unfilled toggle: a plain button in a gray-stroked box,
                the arrow in the same gray as the stroke and the open badges. */}
            <Box borderStyle="round" borderColor={MUTED} paddingX={1}>
              <Button key={`${k}q${i}`} plain onPress={() => toggleOpen(i)}>
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
                        <Box key={`${k}q${i}-ob${j}`} flexDirection="column">
                          <Button key={`${k}q${i}-o${j}`} variant={picked ? 'primary' : 'secondary'} onPress={() => pick(i, o.label)}>
                            <Text bold={picked} color={picked ? 'success' : undefined}>{`${glyph} ${o.label}`}</Text>
                          </Button>
                          {o.description ? (
                            <Box paddingLeft={2}>
                              <Markdown key={`${k}q${i}-od${j}`} dimColor text={questionMarkdown(o.description, t.cwd)} />
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
                          <Box key={`${k}q${i}-pad${j}`} paddingLeft={e.surface === 'terminal' ? 2 : 1}>
                            {optionRow(o, j)}
                          </Box>,
                        )
                        continue
                      }
                      rows.push(
                        <Box key={`${k}q${i}-rec`} flexDirection="column" gap={1} borderStyle="round" borderColor="claude" paddingX={1}>
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
                  {/* Picking in a multi-select never closes the question, so it
                      gets its own Done: close it and open the next unanswered. */}
                  {q.multiSelect && a.selected.length > 0 ? (
                    <Box paddingLeft={e.surface === 'terminal' ? 2 : 1}>
                      <Button key={`${k}q${i}-done`} variant="primary" onPress={() => void saveThen(s => settle(s, i, true))()}>
                        <Text bold color="success">{`✓ Done (${a.selected.length} picked)`}</Text>
                      </Button>
                    </Box>
                  ) : null}
                </Box>
              )}
              {q.options.length === 0 && q.recommendation ? (
                <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
                  <Box marginBottom={1}>
                    <Text bold color="claude">★ Suggested</Text>
                  </Box>
                  <Button
                    key={`${k}q${i}-suggest`}
                    variant={followsRec ? 'primary' : 'secondary'}
                    onPress={() => void edit(i, (x, qq) => applyRecommendation(qq, x), true)}
                  >
                    <Text bold={followsRec} color={followsRec ? 'success' : undefined}>{`${followsRec ? '◉' : '○'} ${q.recommendation}`}</Text>
                  </Button>
                </Box>
              ) : null}
              <Box flexDirection="row" gap={1} flexWrap="wrap" paddingLeft={e.surface === 'terminal' ? 2 : 1}>
                <Button
                  key={`${k}q${i}-clarify`}
                  variant={a.clarify ? 'primary' : 'secondary'}
                  onPress={() => void edit(i, x => ({ ...x, clarify: !x.clarify }), !a.clarify)}
                >
                  <Text bold={a.clarify === true} color={a.clarify ? 'warning' : undefined}>
                    {a.clarify ? '❓ Clarification requested (undo)' : '❓ Please clarify'}
                  </Text>
                </Button>
              </Box>
              <Input
                key={`${k}q${i}-other`}
                label={q.options.length ? 'Other' : 'Answer'}
                placeholder={q.options.length ? 'Your own answer (optional)' : 'Type your answer'}
                value={a.other}
                rows={q.options.length ? 2 : 3}
                submitLabel="✓"
                onInput={v => typed(i, 'other', v)}
                onSubmit={v => void edit(i, x => ({ ...x, other: v }), v.trim() !== '')}
              />
              {/* Free-text questions have the Answer box already: no Notes there. */}
              {q.options.length > 0 && <Input
                key={`${k}q${i}-notes`}
                label="Notes"
                placeholder={a.clarify ? 'What is unclear? (optional)' : 'Extra context, sent with your answer (optional)'}
                value={a.notes}
                rows={2}
                onInput={v => typed(i, 'notes', v)}
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
            {t.other
              ? isSent
                ? isRunning(t.other, now)
                  ? 'Sent. It goes away once that session has received the answers.'
                  : 'Saved. The answers are sent when that session is opened again.'
                : 'Your answers go to that session as your message when you submit.'
              : isSent
                ? 'Sent. New questions from Claude will start a fresh set.'
                : 'Click ▶ to open a question. "Put answers in prompt" fills the prompt box; press Enter there to send.'}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {!isSent && t.fill && (
            <Button key={`${k}send`} variant="primary" onPress={send}>
              {`Put answers in prompt (${done}/${total})`}
            </Button>
          )}
          {!isSent && t.other && (
            <Button key={`${k}submit`} variant="primary" onPress={() => void t.submit()}>
              {`Submit to this session (${done}/${total})`}
            </Button>
          )}
          {!isSent && pendingRecs > 0 && (
            <Button
              key={`${k}accept-recs`}
              onPress={saveThen(s => {
                  const filled: PanelSet = {
                    ...s,
                    answers: s.questions.map((qq, k) => {
                      const cur = s.answers[k] ?? emptyAnswer()
                      return hasChoice(cur) || cur.clarify ? cur : applyRecommendation(qq, cur)
                    }),
                  }
                  return collapsing(filled)
                    ? { ...filled, expanded: filled.expanded.filter(k => !isAnswered(filled.answers[k])) }
                    : filled
                })}
            >
              {`★ Accept recommendations (${pendingRecs})`}
            </Button>
          )}
          <Button
            key={`${k}collapse-answered`}
            onPress={saveThen(s =>
              collapsing(s)
                ? { ...s, collapseAnswered: false }
                : { ...s, collapseAnswered: true, expanded: s.expanded.filter(k => !isAnswered(s.answers[k])) },
            )}
          >
            <Text color={collapsing(set) ? 'success' : 'subtle'} bold={collapsing(set)}>
              {collapsing(set) ? '☑' : '☐'}
            </Text>
            {' Collapse answered'}
          </Button>
          <Button
            key={`${k}toggle-all`}
            onPress={saveThen(s => ({ ...s, expanded: allOpen ? [] : s.questions.map((_, i) => i) }))}
          >
            {allOpen ? 'Collapse all' : 'Expand all'}
          </Button>
          {t.clear && (
            <Button key={`${k}clear`} dimColor onPress={() => void t.clear?.()}>
              Clear
            </Button>
          )}
        </Box>

        {groupQuestions(set.questions).map((g, gi) => {
          if (g.name === undefined) return g.indices.map(card)
          const gDone = g.indices.filter(i => isAnswered(set.answers[i])).length
          const gOpen = g.indices.every(i => set.expanded.includes(i))
          return (
            <Box key={`${k}group-${gi}`} flexDirection="column" gap={1}>
              <Box flexDirection="row" gap={1} alignItems="center">
                <Box flexShrink={1}>
                  {/* A heading: drawn larger and bold, as in a reply. */}
                  <Markdown text={`### ${escapeMarkdown(g.name)}`} />
                </Box>
                <Text bold color={gDone === g.indices.length ? 'success' : 'subtle'}>{`${gDone}/${g.indices.length}`}</Text>
                <Button key={`${k}g${gi}`} plain dimColor onPress={() => toggleGroup(g.indices, gOpen)}>
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
          <Button key={`${k}submit-bottom`} variant="primary" onPress={() => void t.submit()}>
            {t.other ? 'Submit to this session' : 'Submit answers'}
          </Button>
        )}
      </Box>
    )
    }

    // ----- the targets -----
    const localTarget = (s: PanelSet): Target => ({
      k: '',
      cwd: sync.cwd,
      set: s,
      update: fn => update($, panel, cur => (cur ? fn(cur) : cur)),
      submit: () => submitAnswers($),
      fill: () => fillAnswers($),
      clear: async () => {
        draftTimer?.cancel()
        await update($, drafts, () => ({}))
        await update($, panel, () => null)
      },
    })
    const otherTarget = (o: OtherSession, n: number): Target => ({
      k: `s${n}-`,
      cwd: o.cwd,
      set: o.set,
      other: o,
      update: fn =>
        update($, others, all => {
          const cur = all[o.id]
          if (!cur) return all
          const changed = fn(cur.set)
          return changed ? { ...all, [o.id]: { ...cur, set: changed } } : all
        }),
      submit: () => submitOther($, o.id, sync.dir),
      // Only a session that is not running can be cleared from here: a running
      // one would write its questions back on its next tick.
      clear: isRunning(o, now)
        ? undefined
        : async () => {
            if (sync.dir) await $.fs.write(`${sync.dir}/${o.id}.json`, '').catch(() => undefined)
            await update($, others, all => {
              const merged = { ...all }
              delete merged[o.id]
              return merged
            })
          },
    })

    if (tab === 'this') {
      if (!local || local.questions.length === 0) {
        return tabs ? (
          <Box flexDirection="column" gap={1}>
            {tabs}
            {empty}
          </Box>
        ) : empty
      }
      const body = setView(localTarget(local))
      return tabs ? (
        <Box flexDirection="column" gap={1}>
          {tabs}
          {body}
        </Box>
      ) : body
    }

    // All sessions: this session's set first, then the others, newest first.
    const sessionHead = (key: string, title: string, sub: string, color?: string) => (
      <Box key={key} flexDirection="column">
        <Markdown text={`## ${escapeMarkdown(title)}`} />
        <Text dimColor={!color} color={color} wrap="wrap">{sub}</Text>
      </Box>
    )
    const sections = []
    if (local && local.questions.length > 0) {
      sections.push(
        <Box key="sess-this" flexDirection="column" gap={1}>
          {sessionHead('sess-this-head', local.sessionLabel ?? 'This session', 'This session', 'success')}
          {setView(localTarget(local))}
        </Box>,
      )
    }
    otherList.forEach((o, n) => {
      const running = isRunning(o, now)
      const folder = o.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || o.cwd
      sections.push(
        <Box key={`sess-${n}`} flexDirection="column" gap={1}>
          {sessionHead(`sess-${n}-head`, o.label, `${folder} · ${running ? 'running' : 'not running: answers wait until it is opened'}`)}
          {setView(otherTarget(o, n))}
        </Box>,
      )
    })
    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {sections.length ? sections : (
          <Text dimColor wrap="wrap">No session has questions waiting.</Text>
        )}
      </Box>
    )
  })
}
