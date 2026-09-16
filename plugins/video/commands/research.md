---
description: Research an entire project/website/documentation set, or one specific module/file/feature/section of one, and write research.md
argument-hint: [entire project|<url>|<doc set>] | <specific module/file/feature/page/section to research>
allowed-tools: Agent, Bash, Read, Glob, Grep, AskUserQuestion
---

Research: `$ARGUMENTS`

This command delegates the actual investigation to the **`research`** subagent
(`${CLAUDE_PLUGIN_ROOT}/agents/research.md`) — it never researches inline itself,
so the heavy read/browse work stays out of this conversation's context.

## Step 1 — Resolve what to research

Read `$ARGUMENTS` to determine, before launching the agent:

- **Target type**: a local project/codebase (this repo, or another path the
  user names), a live website (a URL was given or implied), a documentation set
  (a `docs/` folder, a README tree, or an external docs site), or a combination.
- **Breadth**:
  - **Entire** — `$ARGUMENTS` says "entire project" / "whole website" / "all the
    docs" / "everything about X" / is empty with an obvious single target in
    context (e.g. run inside a project with no other target named) → research
    the whole thing, breadth-first.
  - **Specific** — `$ARGUMENTS` names a module, file, feature, page, section,
    point, phase, or step → research only that, in depth.
- If `$ARGUMENTS` is empty and there is no obvious target (e.g. run outside any
  project context with no URL/topic given), ask the user (AskUserQuestion) what
  to research rather than guessing.

## Step 2 — Pick the output path

- **Entire-project / entire-site / entire-docs research** → `research.md` at the
  current project root.
- **A specific module/file/feature/page/section** → `research/<topic-slug>.md`
  at the current project root (kebab-case slug of the topic), so researching
  several specific things doesn't overwrite earlier reports. Create the
  `research/` folder if it doesn't exist yet.
- If the user's instructions name an explicit output path, use that instead of
  the defaults above.

## Step 3 — Launch the research agent

Launch the `research` agent (Agent tool, `subagent_type: "research"`) with a
**self-contained** prompt — the agent starts with no memory of this
conversation, so include everything it needs:

- The exact target: what to research (repo path / URL / doc set) and the
  resolved breadth (entire vs. specific — name the specific module/file/
  feature/page/section if narrowed).
- Any facts already known and not to be re-derived or guessed: base URL(s),
  credentials env-var names (never values), relevant file paths already
  identified, the current project's root directory.
- The Playwright MCP server (`mcp__playwright__*`) is available for read-only
  live-website exploration if the target is or includes a live site.
- The exact output path resolved in Step 2, and an instruction to write the
  report there via the `Write` tool per the agent's own Output Format.

## Step 4 — Report back

Once the agent finishes, tell the user:
- The output path it wrote.
- A 2-3 sentence summary of what was covered (pulled from the report's own
  Summary section — don't re-derive it yourself by re-reading the whole target).
- Whether the report flagged any Open Questions/Gaps worth their attention.

Do not modify, fix, or act on anything the research found — this command only
produces the report.
