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
- When Claude asks with Claude Code's built-in question prompt instead, those questions go to the panel as well (see [Standing in for AskUserQuestion](#standing-in-for-askuserquestion)). Questions that other plugins ask, such as permission checks, still use the normal dialog.

If you ever find Claude not using the panel, add a line like "Ask me questions with the Question Panel tool" to your `CLAUDE.md`.

## Standing in for AskUserQuestion

The mod stands in for one tool: Claude Code's built-in `AskUserQuestion`. It does so only when all of these hold:

- the session runs in the Claude desktop app (or the **Where the Question Panel runs** setting is `everywhere`);
- the **Send Claude's built-in questions to the panel** setting is on (the default);
- Claude itself made the call. Calls another plugin makes, such as a permission check, always get the normal dialog.

In that case the mod puts the questions in the panel and answers the call itself, so the built-in dialog doesn't open. Claude is told the questions are in the panel and to wait. The answers then arrive as your next message. In every other case the call goes on to the built-in dialog unchanged.

## What the mod sends to Claude

The mod never adds anything to prompts you type. It submits or fills a prompt in three cases, each started by you:

- **Submit answers** (in the band above the prompt, or under the last question once every question is answered) sends your answers as your message, in the compact form shown above: a first line `Answers (answered/total):`, then one line per question with its number, short label, your answer, and any note.
- **Put answers in prompt** (in the panel's top bar) puts that same text in your prompt box, replacing what's there, for you to review and send yourself.
- **`/ask-me [topic]`** sends this message as yours: "Before going further, list every question you have for me about: *topic* (or: about the current task). Ask them all in a single call to the mcp__question-panel__ask_questions tool (no limit on the number; give options where they help), then end your turn and wait for my answers."

When Claude's questions go to the panel, Claude's question call is answered with a short note that the questions are in the panel and that the answers will come as your next message. The panel's own tool description tells Claude how to ask and how to read the answers.

## Hooks

What each of the mod's hooks does:

| Hook | What it does |
| --- | --- |
| `session.start` | Decides whether the mod runs in this session (desktop app, or everywhere per the setting). If it does, registers the `ask_questions` tool and the `/questions` and `/ask-me` commands. |
| `tool.call` on `mcp__question-panel__ask_questions` | The mod's own tool: puts Claude's questions in the panel, opens it, and answers the call with the note above. |
| `tool.call` on `AskUserQuestion` | Stands in for the built-in tool as described above; otherwise passes the call on unchanged. If anything fails, the built-in dialog opens as usual. |
| `command.run` on `questions` | Opens the panel; `on` and `off` change the **Send Claude's built-in questions to the panel** setting; `clear` empties the panel. |
| `command.run` on `ask-me` | Opens the panel and sends the `/ask-me` message above. |
| `prompt.submit` | Watches for a submitted message that starts with `Answers (n/n):` and, once it has gone in, clears the panel. It never changes or blocks a prompt. |
| `ui.render` on `Pane` | Draws the Question Panel. |
| `ui.render` on `AbovePrompt` | Draws the band above the prompt (progress, **Submit answers**, **Show panel**) while questions are waiting; otherwise draws nothing. |
| `ui.render` on `ToolUse` | Adds an **Open Question Panel** button under the chat row of a question call the panel took; leaves every other row as it is. |

The mod keeps the open question set and your answers in the session's state, so they survive the mod reloading. It reads no files, runs no programs, and makes no network requests.

## Commands

| Command | What it does |
| --- | --- |
| `/ask-me [topic]` | Asks Claude to put all of its questions about a topic, or the current task, into the panel. |
| `/questions` | Opens the panel. |
| `/questions off` | Turns off **Send Claude's built-in questions to the panel**: the built-in question prompt uses its own dialog again (the panel's tool still works). |
| `/questions on` | Turns that setting back on. |
| `/questions clear` | Empties the panel. |

## Settings

By default the panel runs only in the Claude desktop app. In a terminal session it stays out of the way: no panel, band, tool or commands, and Claude's built-in question prompt works as usual.

To use it in terminal sessions too, set **Where the Question Panel runs** to `everywhere`. In a terminal session, run `/config` and change it there, or add this to `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "question-panel": { "options": { "surfaces": "everywhere" } }
  }
}
```

| Setting | Values | Default |
| --- | --- | --- |
| `surfaces`: Where the Question Panel runs | `desktop`, `everywhere` | `desktop` |
| `redirectBuiltin`: Send Claude's built-in questions to the panel | on, off (`/questions on`, `/questions off`) | on |

## Configuration the mod changes

The mod changes one setting, and only when you run a command that asks for it:

- `/questions off` sets the mod's own setting `question-panel.redirectBuiltin` to `false`, and `/questions on` sets it to `true`. This is the same setting you can change with `/config`, stored by Claude Code under `pluginConfigs.question-panel.options.redirectBuiltin` in your user settings.

It changes no other setting and sets no environment variables.

## What the mod reads

The mod reads only its own two settings (`surfaces` and `redirectBuiltin`, as Claude Code passes them to it) and the question set it keeps in the session's state. It asks for no keys, tokens, or other secrets, and reads nothing else from your machine: no files, environment variables, or other programs' output.

## Notes

- Built on Claude Code's plugin hooks API, which is in early access and may change between releases.
- The panel is designed for the Claude desktop app. With `everywhere` set it also works in the terminal, with simpler drawing there (no circle badges).

## Development

`claude plugin validate .` checks the mod, and `claude plugin test .` runs the tests in `hooks/panel.test.tsx`.
