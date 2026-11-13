# Question Panel for Claude Code

A Claude Code mod that collects every question Claude asks you into a panel docked beside the chat, so you can work through a long set of questions at your own pace instead of a few at a time.

- **Every question in one list.** Nothing scrolls away or gets hidden while you answer. Questions can be grouped into sections, each with its own progress count.
- **Click a question to open it.** Pick from Claude's options (single- or multi-select), type your own answer under **Other** (✓ to confirm), and add **Notes** that are sent along with your answer.
- **Claude's recommendations, inline.** Recommended options sit together in a highlighted bubble with Claude's reason. Pick them one at a time, or use **★ Accept recommendations** to fill in every unanswered question.
- **❓ Please clarify.** One click asks Claude to explain a question and ask it again.
- **Progress you can see.** Numbered badges turn green when a question is answered (amber when you asked for clarification), and the panel shows "7/12 answered".
- **Collapse answered.** An optional toggle closes each question as you answer it and opens the next one, so you scroll less.
- **Easy to get back to.** Each time Claude asks, the chat shows an **Open Question Panel** button under the question call, so you can reopen the panel if you closed it.
- **Submit from anywhere.** A band above the prompt box shows your progress with a **Submit answers** button. When every question is answered, a second **Submit answers** button appears under the last question. **Put answers in prompt** in the panel's top bar fills the prompt box instead, so you can review before sending.

Answers are sent as one compact message. Claude already has its questions in context, so each answer carries only its number and a short label, not the question's text:

```
Answers (3/6):
## Plan 1
1 Language: Go. note: the team already knows it
2 Auth: skipped
3 Hosting: other: Hetzner
## Plan 2
1 Language: TypeScript
2 Auth: CLARIFY
3 Hosting: skipped
```

Numbering restarts in each group, so questions Claude sends as "Plan 1: 1, 2, 3" and "Plan 2: 1, 2, 3" keep their numbers. `CLARIFY` asks Claude to explain that question and ask it again.

The panel empties once the message has been received.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install question-panel --marketplace treadingwell/claude-code-desktop-question-panel
```

Answer `y` to add the marketplace, then pick a scope (the user scope makes it available in every session).

From a shell:

```bash
claude plugin install question-panel --marketplace treadingwell/claude-code-desktop-question-panel
```

In the Claude desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `treadingwell/claude-code-desktop-question-panel`, then **Add plugin**.

## How Claude uses it

You don't need to set anything up:

- The mod adds a question tool that Claude always sees. Its description tells Claude to use it whenever it has questions for you, with no limit on how many, and to add groups and recommendations.
- When Claude asks with Claude Code's built-in question prompt instead, those questions go to the panel as well. Questions that other plugins ask, such as permission checks, still use the normal dialog.

If you ever find Claude not using the panel, add a line like "Ask me questions with the Question Panel tool" to your `CLAUDE.md`.

## Commands

| Command | What it does |
| --- | --- |
| `/ask-me [topic]` | Asks Claude to put all of its questions about a topic, or the current task, into the panel. |
| `/questions` | Opens the panel. |
| `/questions off` | Lets Claude's built-in question prompt use its own dialog again (the panel's tool still works). |
| `/questions on` | Sends the built-in question prompt to the panel again. |
| `/questions clear` | Empties the panel. |

## Notes

- Built on Claude Code's plugin hooks API, which is in early access and may change between releases.
- The panel is designed for the Claude Code desktop app and also works in the terminal, with simpler drawing there (no circle badges).

## Development

`claude plugin validate .` checks the mod, and `claude plugin test .` runs the tests in `hooks/panel.test.tsx`.
