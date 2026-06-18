# Toodly — Claude Code Instructions

## Documentation rule

After successfully implementing any new feature, meaningful update, or
architectural change, update `pn.md` to reflect it before considering
the task done. Specifically:

- What was added or changed, and **why** — the problem it solves, not
  just a restatement of what the code does
- The logic and approach taken, especially any non-obvious design
  decisions or tradeoffs (e.g. why one approach was chosen over an
  alternative that would also have worked)
- Which files and functions are involved, briefly
- Anything a future session would need to know to safely modify this
  area without re-deriving context from scratch

If something is removed, deprecated, or replaced, remove or rewrite its
entry in `pn.md` accordingly — `pn.md` describes the project as it
currently exists, not a historical changelog of things that no longer
exist.

If unsure whether a change is "meaningful" enough to document, lean
toward a brief entry rather than skipping it.

Before editing `pn.md`, skim its current contents so the update fits
the existing structure and voice rather than being bolted on at the end.
