# pawpawko-site

Static multi-page site for the NYC One Piece TCG / Pokémon trading community. Supabase + Cloudflare R2 + Netlify.

## Where context lives

Project context is maintained in auto-memory at `C:\Users\jessi\.claude\projects\C--Program-Files-Git\memory\`. Always start there:

1. `MEMORY.md` — index
2. `reference_pawpawko_overview.md` — what this project is
3. `project_pawpawko_current_focus.md` — what we're working on right now
4. `project_pawpawko_worklog.md` + `project_pawpawko_roadmap.md` — recent + queued work

A UserPromptSubmit hook auto-injects current focus + worklog + roadmap into the conversation when a prompt mentions "pawpawko", so the basics are loaded as soon as the topic comes up.

## Local dev

`http://localhost:8000` boots automatically when any prompt contains "pawpawko" (UserPromptSubmit hook in `~/.claude/settings.json`). Killed on `/clear` or window close (SessionEnd hook).

Manual: `python -m http.server 8000` from this directory.

## Making changes

- Add only what was asked. When implementing something, don't tack on unrequested comments, helper/explanatory copy, docs, config, or extra options — match the surrounding file's style and stop. (UI/marketing copy has its own rule: name a function, don't narrate it — see `feedback_pawpawko_concise_ui_copy.md`.)

## Don't

- Don't commit `scripts/.env` (already in `.gitignore`).
- Don't write to legacy `profiles.binder_*` columns — see `project_pawpawko_gotchas.md`.
- Don't hotlink card images from en.onepiece-cardgame.com — mirror to R2.
