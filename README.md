# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): TypeScript plugins that hook into Claude Code's engine.

## handoff

When a conversation's context passes 70% (or earlier, if auto-compact would run first), a band appears above the prompt with a **Handoff** button. Pressing it:

1. Saves the full transcript, tool output included, as markdown.
2. Has Claude write a structured brief: the task in progress, every question raised and its status, a pending checklist, decisions, files, gotchas, and the skills and memories to reuse.
3. Offers **Start fresh**, which runs `/clear`. The next conversation in that folder then resumes by itself: it reads the brief and reports where things stand before doing any work.

Files go to `~/.claude/handoffs/<project>/<timestamp>/`, outside your repos. `/handoff` does the same as the button. `/handoff-skip` starts clean instead. A handoff older than two days waits for you to press **Load**.

## Install

At the prompt of a terminal session:

```
/plugin install handoff --marketplace aashish-g03/claude-mods
```

From a shell:

```
claude plugin install handoff --marketplace aashish-g03/claude-mods
```

Answer `y` to add the marketplace, then choose the user scope so the mod runs in every project.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `aashish-g03/claude-mods`, then Add plugin.

To update later: `claude plugin update handoff`, then `/reload-plugins`.

## Develop

```
claude plugin validate handoff
claude plugin test handoff
```
