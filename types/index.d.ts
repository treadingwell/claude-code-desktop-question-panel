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
  /** Collapse a question once it is answered, and open the next unanswered one. Unset means on. */
  collapseAnswered?: boolean
  sentAt?: number
  /** The name Claude gave this session's work when asking (the tool's `session`). */
  sessionLabel?: string
}

/**
 * Text typed into Other/Answer and Notes boxes, not yet saved into the set:
 * keyed `<set id>|<question index>|other` or `|notes`. The panel never draws
 * from it, so typing does not redraw the panel and lose keys.
 */
export type PanelDrafts = Record<string, string>

/**
 * Another session's open questions, read from its file in the shared folder
 * (all-sessions setting). The questions are that session's; the answers are
 * the ones given here, sent to that session's inbox on Submit.
 */
export type OtherSession = {
  id: string
  label: string
  cwd: string
  /** When that session last wrote its file (it rewrites it every few seconds while running). */
  updatedAt: number
  /** Set when that session ended. */
  endedAt?: number
  set: PanelSet
}

/** Every other session with open questions, by session id. */
export type OtherSessions = Record<string, OtherSession>

/** Which tab the panel shows when the all-sessions setting is on. */
export type PanelView = 'this' | 'all'

declare module 'claude-code' {
  interface PluginState {
    'question-panel': {
      set: Shaped<PanelSet | null>
      drafts: Shaped<PanelDrafts>
      others: Shaped<OtherSessions>
      view: Shaped<PanelView>
    }
  }
}
