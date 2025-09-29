# Dangerous Mode (Obsidian Plugin)

An Obsidian plugin that recreates the [Most Dangerous Writing App](https://www.squibler.io/dangerous-writing-prompt-app) inside a single note. Start a timed session; if you stop inserting text for 5 seconds, the plugin wipes the current note’s body (preserving YAML frontmatter). A red-edge warning appears a couple seconds into idleness and intensifies toward the cutoff. During a session, selection, copy/cut/paste, undo/redo, and drag‑drop are blocked. The session auto‑ends after the chosen duration without wiping if you keep typing.

- Command: `Dangerous Mode: Start` (choose 5/10/15 minutes or custom)
- Idle reset: only real insertions (typing, Enter) reset the 5‑second timer
- Scope: only the note active when you started can be wiped; others are unaffected
- Safety: intentionally destructive by design — use at your own risk
