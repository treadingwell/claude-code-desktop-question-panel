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

declare module 'claude-code' {
  interface PluginState {
    'question-panel': { set: Shaped<PanelSet | null> }
  }
}
