export type PanelOption = { label: string; description?: string; recommended?: boolean }

export type PanelQuestion = {
  question: string
  header?: string
  group?: string
  /** Why the recommended option is best; for an open-ended question, the suggested answer. */
  recommendation?: string
  options: PanelOption[]
  multiSelect: boolean
}

export type PanelAnswer = {
  selected: string[]
  other: string
  notes: string
  /** The person asked Claude to explain this question before they answer. */
  clarify?: boolean
}

export type PanelSet = {
  id: string
  questions: PanelQuestion[]
  answers: PanelAnswer[]
  expanded: number[]
  /** Collapse a question once it is answered, and open the next unanswered one. */
  collapseAnswered?: boolean
  sentAt?: number
}

/**
 * Text typed into Other/Answer and Notes boxes, not yet saved into the set:
 * keyed `<set id>|<question index>|other` or `|notes`. The panel never draws
 * from it, so typing does not redraw the panel and lose keys.
 */
export type PanelDrafts = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'question-panel': { set: Shaped<PanelSet | null>; drafts: Shaped<PanelDrafts> }
  }
}
