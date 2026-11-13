import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__question-panel__ask_questions'

const PANE = {
  plugin: 'question-panel',
  component: 'Pane',
  requestId: 'question-panel',
  props: {
    title: 'Questions',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Ten questions: single-select, multi-select and open-ended.
const TEN = [
  { question: 'Which language should the backend use?', header: 'Language', options: [{ label: 'TypeScript' }, { label: 'Go' }, { label: 'Python' }] },
  { question: 'Which databases do you need?', header: 'DB', multiSelect: true, options: [{ label: 'Postgres' }, { label: 'Redis' }, { label: 'SQLite' }] },
  { question: 'What is the project called?' },
  { question: 'Host where?', options: [{ label: 'AWS' }, { label: 'Fly.io', description: 'simple deploys' }] },
  { question: 'Need auth?', options: [{ label: 'Yes' }, { label: 'No' }] },
  { question: 'Which test runner?', options: [{ label: 'Vitest' }, { label: 'Jest' }] },
  { question: 'Target launch date?' },
  { question: 'CI provider?', options: [{ label: 'GitHub Actions' }, { label: 'CircleCI' }] },
  { question: 'Which platforms?', multiSelect: true, options: [{ label: 'Web' }, { label: 'iOS' }, { label: 'Android' }] },
  { question: 'Anything else I should know?' },
]

/** Prompts that reached the engine (submitted), as opposed to filled into the box. */
const submitted: string[] = []
/** Pane ids the mod opened. */
const opened: string[] = []

function engine(on: any, sent: string[], intercept?: boolean) {
  submitted.length = 0
  opened.length = 0
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', (_: unknown, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('store.get', () => ({ value: intercept }))
  on('prompt.submit', (_: unknown, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', (_: unknown, e: any) => {
    sent.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`10 questions: answer some, keep state, send one formatted message (${surface})`, async ($, on) => {
    const sent: string[] = []
    engine(on, sent)
    await $.session.start({ cwd: '/', surface, isInteractive: true })

    const ran: any = await $.tool.call({ tool: TOOL, questions: TEN } as any)
    expect(String(ran.result)).toContain('10 question(s)')

    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /0\/10 answered/ }))?.text).toBeDefined()
    // Every question is listed.
    for (let i = 0; i < 10; i++) expect(await ui.find({ key: `q${i}` })).toBeDefined()

    // Q1 is open by default: pick Go, add notes.
    await ui.press({ key: 'q0-o1' })
    await ui.input({ key: 'q0-notes', text: 'team knows Go', kind: 'change' })

    // Q2 multi-select: open, pick two.
    await ui.press({ key: 'q1' })
    await ui.press({ key: 'q1-o0' })
    await ui.press({ key: 'q1-o1' })

    // Q3 open-ended answer.
    await ui.press({ key: 'q2' })
    await ui.input({ key: 'q2-other', text: 'Atlas', kind: 'change' })

    // Jump around: collapse Q1 and reopen it; its answer stays.
    await ui.press({ key: 'q0' })
    expect((await ui.find({ type: 'Text', text: /→ Go/ }))?.text).toBe('→ Go')
    expect((await ui.find({ type: 'Text', text: /notes: team knows Go/ }))?.text).toBeDefined()
    await ui.press({ key: 'q0' })

    // Q4: "Other" text instead of an option.
    await ui.press({ key: 'q3' })
    await ui.input({ key: 'q3-other', text: 'Hetzner', kind: 'change' })

    expect((await ui.find({ type: 'Text', text: /4\/10 answered/ }))?.text).toBeDefined()

    await ui.press({ key: 'send' })
    expect(sent).toHaveLength(1)
    const msg = sent[0]!
    expect(msg).toContain('(4/10 answered)')
    expect(msg).toContain('1. Q: Which language should the backend use?\n   -> Go\n   -> Notes: team knows Go')
    expect(msg).toContain('2. Q: Which databases do you need?\n   -> Postgres, Redis')
    expect(msg).toContain('3. Q: What is the project called?\n   -> Atlas')
    expect(msg).toContain('4. Q: Host where?\n   -> Other: Hetzner')
    expect(msg).toContain('5. Q: Need auth?\n   -> (skipped)')
    expect(msg).toContain('10. Q: Anything else I should know?\n   -> (skipped)')

    // Filled into the prompt box, not yet sent.
    expect(await ui.find({ key: 'send' })).toBeDefined()
    // The person presses Enter on it in the prompt box.
    // Filling alone does not clear anything; the received message does.
    expect(await ui.find({ key: 'q0' })).toBeDefined()
    await $.prompt.submit({ text: msg } as any)
    expect((await ui.find({ type: 'Text', text: /No questions yet/ }))?.text).toBeDefined()
    expect(await ui.find({ key: 'q0' })).toBeUndefined()
    // An ordinary prompt never clears a set.
    await $.tool.call({ tool: TOOL, questions: TEN.slice(0, 2) } as any)
    await $.prompt.submit({ text: 'hello' } as any)
    expect(await ui.find({ key: 'q1' })).toBeDefined()
    await ui.unmount()
  })
}

test('questions are grouped under headings, in the panel and in the message', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const grouped = TEN.map((q, i) => ({ ...q, group: i < 4 ? 'Backend' : i < 7 ? 'Process' : 'Product' }))
  // Interleave one Backend question at the end: it still lands in Backend.
  grouped.push({ question: 'ORM or raw SQL?', group: 'Backend' } as any)
  await $.tool.call({ tool: TOOL, questions: grouped } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Group titles are Markdown headings (larger, bold).
  const tree = JSON.stringify(await ui.drawn())
  for (const name of ['Backend', 'Process', 'Product']) {
    expect(tree).toContain(`"text":"### ${name}"`)
  }
  expect((await ui.find({ type: 'Text', text: /^0\/5$/ }))?.text).toBe('0/5')

  // Expand a whole group with its heading.
  await ui.press({ key: 'g1' })
  expect(await ui.find({ key: 'q5-notes' })).toBeDefined()
  await ui.press({ key: 'q4-o0' })

  await ui.press({ key: 'send' })
  const msg = sent[0]!
  expect(msg).toContain('## Backend')
  expect(msg.indexOf('11. Q: ORM or raw SQL?')).toBeLessThan(msg.indexOf('## Process'))
  expect(msg).toContain('## Process\n\n5. Q: Need auth?\n   -> Yes')
  await ui.unmount()
})

test('recommendations: shown, accepted per question or all at once, marked in the message', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    questions: [
      {
        question: 'Which language?',
        options: [{ label: 'TypeScript' }, { label: 'Go', recommended: true }],
        recommendation: 'Fast builds and the team knows it.',
      },
      // AskUserQuestion-style suffix is understood too.
      { question: 'Need auth?', options: [{ label: 'Yes (Recommended)' }, { label: 'No' }] },
      { question: 'Project name?', recommendation: 'Atlas' },
      { question: 'Platforms?', multiSelect: true, options: [{ label: 'Web', recommended: true }, { label: 'iOS', recommended: true }, { label: 'Android' }] },
      { question: 'No recommendation here?', options: [{ label: 'A' }, { label: 'B' }] },
    ],
  } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Collapsed rows show the recommendation.
  expect((await ui.find({ type: 'Text', text: /★ Recommended: Yes$/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /★ Recommended: Web, iOS/ }))?.text).toBeDefined()
  // Q1 is open: the recommended option sits in a bubble with the reason inside it.
  const bubble = JSON.stringify(await ui.find({ key: 'q0-rec' }))
  expect(bubble).toContain('round')
  // Inside the bubble: the ★ line first, then the option's button; TypeScript stays outside.
  expect(bubble).toMatch(/★ Recommended[\s\S]*: Fast builds[\s\S]*"key":"q0-o1"/)
  expect(bubble).not.toContain('"key":"q0-o0"')
  // The tag is not part of the option's button label, and there is no "use" button.
  expect((await ui.find({ key: 'q0-o1' }))?.text).toBe('○ Go')
  expect((await ui.findAll({ type: 'Button', text: /Use recommended/ })).length).toBe(0)
  await ui.press({ key: 'q0-o1' })

  // Open-ended: the suggestion is a pickable item in its own bubble.
  await ui.press({ key: 'q2' })
  await ui.press({ key: 'q2-suggest' })
  expect(JSON.stringify(await ui.find({ key: 'q2-suggest' }))).toContain('primary')

  // Multi-select: both recommended options share one bubble; Android stays outside.
  await ui.press({ key: 'q3' })
  const multi = JSON.stringify(await ui.find({ key: 'q3-rec' }))
  expect(multi).toContain('"key":"q3-o0"')
  expect(multi).toContain('"key":"q3-o1"')
  expect(multi).not.toContain('"key":"q3-o2"')
  expect(multi.match(/"children":\["★ Recommended"\]/g)).toHaveLength(1)
  // Plain options are indented like the bubble's contents, so buttons line up.
  const plain = JSON.stringify(await ui.find({ key: 'q3-pad2' }))
  expect(plain).not.toContain('borderStyle')
  expect(plain).toContain('"paddingLeft":1')
  await ui.press({ key: 'q3' })

  // Accept the rest in one go: 2 unanswered questions have one.
  expect((await ui.find({ key: 'accept-recs' }))?.text).toContain('(2)')
  await ui.press({ key: 'accept-recs' })
  expect(await ui.find({ key: 'accept-recs' })).toBeUndefined()

  await ui.press({ key: 'send' })
  const msg = sent[0]!
  expect(msg).toContain('(4/5 answered)')
  expect(msg).toContain('1. Q: Which language?\n   -> Go (recommended)')
  expect(msg).toContain('2. Q: Need auth?\n   -> Yes (recommended)')
  expect(msg).toContain('3. Q: Project name?\n   -> Atlas')
  expect(msg).toContain('4. Q: Platforms?\n   -> Web (recommended), iOS (recommended)')
  expect(msg).toContain('5. Q: No recommendation here?\n   -> (skipped)')
  await ui.unmount()
})

test('notes alone are not an answer (sent with the skipped question); please clarify is', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    questions: [
      { question: 'Which cache?', options: [{ label: 'Redis', recommended: true }, { label: 'None' }] },
      { question: 'Retention policy?', options: [{ label: '30 days' }, { label: '1 year' }] },
      { question: 'Anything else?' },
    ],
  } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Q1: please clarify, with what's unclear in notes (typed, never submitted).
  await ui.press({ key: 'q0-clarify' })
  expect(await ui.find({ key: 'q0-clarify' })).toBeDefined()
  await ui.input({ key: 'q0-notes', text: 'Cache for what, sessions?', kind: 'change' })
  // Q2: notes only, no option picked.
  await ui.press({ key: 'q1' })
  await ui.input({ key: 'q1-notes', text: 'Ask legal first', kind: 'change' })

  expect((await ui.find({ type: 'Text', text: /1\/3 answered/ }))?.text).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toContain('Question 2, not answered')
  // Q1 asked for clarification: Accept recommendations leaves it alone.
  expect(await ui.find({ key: 'accept-recs' })).toBeUndefined()

  await ui.press({ key: 'send' })
  const msg = sent[0]!
  expect(msg).toContain('1. Q: Which cache?\n   -> PLEASE CLARIFY: I need more context before answering\n   -> Notes: Cache for what, sessions?')
  expect(msg).toContain('2. Q: Retention policy?\n   -> (skipped)\n   -> Notes: Ask legal first')
  expect(msg).toContain('3. Q: Anything else?\n   -> (skipped)')
  expect(msg).toContain('I marked question 1 "please clarify"')
  await ui.unmount()
})

test('number badge: outlined while open, filled once answered (desktop svg, terminal text)', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, questions: [{ question: 'A?', header: 'Tag', options: [{ label: 'x' }, { label: 'y' }] }] } as any)

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(JSON.stringify(await desk.drawn())).toContain('Question 1, not answered')
  await desk.press({ key: 'q0-o0' })
  expect(JSON.stringify(await desk.drawn())).toContain('Question 1, answered')
  await desk.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const drawn = JSON.stringify(await term.drawn())
  expect(drawn).not.toContain('"Svg"')
  expect(drawn).toContain('" 1 "')
  expect(drawn).toContain('"backgroundColor":"success"')
  // The header is bold colored text, not a filled chip.
  expect(drawn).toContain('{"type":"Text","props":{"bold":true,"color":"suggestion","wrap":"wrap"},"children":["Tag"]}')
  await term.unmount()
})

test('collapse answered: a decided question closes and the next unanswered opens', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, questions: TEN } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Off by default: picking keeps Q1 open.
  await ui.press({ key: 'q0-o0' })
  expect(await ui.find({ key: 'q0-notes' })).toBeDefined()

  // Turning it on closes the answered Q1 at once.
  await ui.press({ key: 'collapse-answered' })
  expect(await ui.find({ key: 'q0-notes' })).toBeUndefined()
  // Collapsed: the summary shows under the question; ▸ reopens it.
  expect((await ui.find({ type: 'Text', text: /→ TypeScript/ }))?.text).toBe('→ TypeScript')
  const toggle = await ui.find({ key: 'q0' })
  expect(toggle?.text).toBe('▶')
  expect(JSON.stringify(await ui.drawn())).toMatch(/"borderStyle":"round","borderColor":"#8b8b8b","paddingX":1\},"children":\[\{"type":"Button","props":\{"key":"q0"/)
  await ui.press({ key: 'q0' })
  expect(await ui.find({ key: 'q0-notes' })).toBeDefined()
  await ui.press({ key: 'q0' })

  // Open Q4 (single-select): a pick closes it and opens Q2, the next unanswered after it... wraps past answered ones.
  await ui.press({ key: 'q3' })
  await ui.press({ key: 'q3-o1' })
  expect(await ui.find({ key: 'q3-notes' })).toBeUndefined()
  expect(await ui.find({ key: 'q4-notes' })).toBeDefined()

  // Multi-select picks never collapse; typing notes never collapses.
  await ui.press({ key: 'q1' })
  await ui.press({ key: 'q1-o0' })
  await ui.input({ key: 'q1-notes', text: 'x', kind: 'change' })
  expect(await ui.find({ key: 'q1-notes' })).toBeDefined()

  // Open-ended: Enter in the answer box settles it.
  await ui.press({ key: 'q2' })
  // A free-text question has its Answer box and no Notes box.
  expect(await ui.find({ key: 'q2-other' })).toBeDefined()
  expect(await ui.find({ key: 'q2-notes' })).toBeUndefined()
  await ui.input({ key: 'q2-other', text: 'Atlas', kind: 'submit' })
  expect(await ui.find({ key: 'q2-clarify' })).toBeUndefined()

  // Typing in Other never collapses; its ✓ (Enter) completes it.
  await ui.press({ key: 'q5' })
  await ui.input({ key: 'q5-other', text: 'Bun test', kind: 'change' })
  expect(await ui.find({ key: 'q5-notes' })).toBeDefined()
  expect(await ui.find({ key: 'q5-other-ok' })).toBeUndefined()
  await ui.input({ key: 'q5-other', text: 'Bun test', kind: 'submit' })
  expect(await ui.find({ key: 'q5-notes' })).toBeUndefined()
  expect(await ui.find({ key: 'q4-notes' })).toBeDefined() // still open from before

  // Clarify settles it too.
  await ui.press({ key: 'q4-clarify' })
  expect(await ui.find({ key: 'q4-notes' })).toBeUndefined()
  // Q7 (free text) is next: open, Answer box with its ✓, no Notes.
  expect(await ui.find({ key: 'q6-clarify' })).toBeDefined()
  expect((await ui.find({ key: 'q6-other' }))?.props).toMatchObject({ submitLabel: '✓' })
  expect(await ui.find({ key: 'q6-notes' })).toBeUndefined()
  // Notes (on a question with options) sets no label of its own.
  await ui.press({ key: 'q7' })
  expect((await ui.find({ key: 'q7-notes' }))?.props).not.toHaveProperty('submitLabel')
  expect(JSON.stringify(await ui.drawn())).not.toContain('auto-saved')
  await ui.unmount()
})

test('band above the prompt: progress and send while questions wait, gone after', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  // Stands for the engine's own (empty) band when the mod passes.
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const BAND = {
    plugin: 'question-panel',
    component: 'AbovePrompt',
    requestId: 'band',
    surface: 'desktop',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 } },
  } as const

  await $.tool.call({ tool: TOOL, questions: TEN } as any)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'q0-o0' })
  expect(await pane.find({ key: 'send-bottom' })).toBeUndefined()

  const band = await $.ui.mount(BAND as any)
  expect((await band.find({ type: 'Text', text: /1\/10 answered/ }))?.text).toBe('1/10 answered')
  expect((await band.find({ key: 'band-send' }))?.text).toBe('Submit answers')
  // Two quick clicks send one message, not two.
  await Promise.allSettled([band.press({ key: 'band-send' }), band.press({ key: 'band-send' })])
  expect(submitted).toHaveLength(1)
  // Sent directly as a prompt, not filled into the box; band and panel clear.
  expect(sent).toHaveLength(0)
  expect(submitted[0]).toContain('(1/10 answered)')
  expect(await band.find({ key: 'band-send' })).toBeUndefined()
  expect((await pane.find({ type: 'Text', text: /No questions yet/ }))?.text).toBeDefined()
  await band.unmount()
  await pane.unmount()
})

test('Submit answers appears under the last question only once all are answered', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, questions: [{ question: 'A?', options: [{ label: 'x' }, { label: 'y' }] }, { question: 'B?' }] } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'q0-o0' })
  expect(await ui.find({ key: 'submit-bottom' })).toBeUndefined()
  await ui.press({ key: 'q1' })
  await ui.input({ key: 'q1-other', text: 'b', kind: 'change' })
  expect((await ui.find({ key: 'submit-bottom' }))?.text).toBe('Submit answers')
  await ui.press({ key: 'submit-bottom' })
  expect(submitted).toHaveLength(1)
  expect((await ui.find({ type: 'Text', text: /No questions yet/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('a question call row in the chat has an Open Question Panel button', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  // Stands for the engine's own row.
  on('ui.render', { component: 'ToolUse' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`row ${e.props.tool}`}</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ROW = (tool: string, result: unknown = 'ok') =>
    ({
      plugin: 'question-panel',
      component: 'ToolUse',
      requestId: 't1',
      surface: 'desktop',
      props: { tool_use_id: 't1', tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: result },
    }) as any

  const ours = await $.ui.mount(ROW(TOOL))
  expect((await ours.find({ type: 'Text', text: /row/ }))?.text).toBe(`row ${TOOL}`)
  await ours.press({ key: 'open-panel' })
  expect(opened).toContain('question-panel')
  await ours.unmount()

  const other = await $.ui.mount(ROW('Bash'))
  expect(await other.find({ key: 'open-panel' })).toBeUndefined()
  await other.unmount()

  // A built-in dialog the panel did not take gets no button.
  const dialog = await $.ui.mount(ROW('AskUserQuestion', { answers: { a: 'b' } }))
  expect(await dialog.find({ key: 'open-panel' })).toBeUndefined()
  await dialog.unmount()
})

test('AskUserQuestion is answered by the panel and calls accumulate', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const batch = (from: number) => ({
    tool: 'AskUserQuestion',
    questions: TEN.slice(from, from + 4).map(q => ({
      question: q.question,
      header: 'H',
      multiSelect: !!q.multiSelect,
      options: (q.options ?? [{ label: 'A' }, { label: 'B' }]).map(o => ({ label: o.label, description: '' })),
    })),
  })
  const first: any = await $.tool.call(batch(0) as any)
  expect(first.isError).toBeUndefined()
  expect(first.context?.[0]).toContain('Question Panel')
  await $.tool.call(batch(4) as any)
  await $.tool.call(batch(8) as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /0\/10 answered/ }))?.text).toBeDefined()
  await ui.unmount()
})
