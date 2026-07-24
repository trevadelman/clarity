# Projects — Multi-Source Workspaces with Generated Reports

> **Status: design agreed, not started.** Target: post-v2.0.0.

## Origin

Ask (paraphrased): use a Loom video as input to create a "report" on the
GitHub repo items in the library — e.g. Brian lands a change in haxall,
records a Loom about it, and Clarity cross-references the video against
the actual commits. Generalizing: a video may reference code in *multiple*
repos, which motivates a **Projects** view — a workspace that scopes the
AI chat to a chosen subset of library sources.

## Concept

**A Project = a named workspace over a subset of library sources + its
own chat + a running list of generated reports.**

```
Project
├─ members: libraryId[]         (repos, videos, looms — any source type)
├─ chat thread                  (persistent, project-scoped; one to start)
└─ reports: Report[]
     ├─ id, title, createdAt
     ├─ markdown body (+ extracted screenshot images)
     └─ provenance: { sourceIds, commit shas, video refs used }
```

## Design decisions (locked in)

- **Full media attachment.** Video/loom members are attached as actual
  media (not just summaries) in project chat and report generation, so
  answers and reports are timestamp-grounded. Worth the extra cents per
  question; the spend tracker captures it.
- **Timestamp citations:** `[TS:videoId:mm:ss]` chips — clickable in
  chat (same as per-video chat), rendered as `/video/[id]?t=…` links in
  reports.
- **Screenshots in reports.** The generation prompt has the model mark
  illustration-worthy moments as `[SHOT:videoId:mm:ss caption]`.
  Post-generation, those run through the existing frame extractor
  (`$lib/frames.ts`, same pipeline as Highlights); stills are saved to
  `<appDataDir>/reports/<reportId>/` and referenced as images in the
  stored markdown.
- **Library stays the source of truth.** Projects hold references only;
  a deleted library item renders as "removed source" in the project.
- **Projects subsume the "per-repo report tab" idea** — a single-repo
  project covers the simple case; no separate tab next to digests.

## Navigation / UI

- Sidebar (library mode) gains a **Projects** link → `/projects` (list)
  and `/projects/[id]` (detail).
- Project detail: header (name, member chips), **Chat** and **Reports**
  tabs, and an "Add from library" picker (checkbox list of library
  items, filterable by type).

## Chat — merged multi-repo toolset

Today `runAgenticChat` runs with one repo's toolset. Project chat gets a
merged toolset with a repo dimension: every repo tool (`read_file`,
`list_commits`, `get_commit_diff`, `search_code`, `list_directory`…)
gains a `repo` parameter constrained to the project's member repos.
Videos/looms are attached as media. So the motivating scenario works in
one conversation: the model watches the Loom, then calls
`search_code(repo: "haxall", …)` and `read_file(repo: "xeto", …)`.

## Reports — two entry points, one mechanism

1. **Chat tool** `generate_report`: mid-conversation, produces a titled
   markdown report saved to the project with provenance; the chat shows
   a `[REPORT:id]` chip.
2. **"New report" button** on the Reports tab with a purpose prompt —
   runs the same agentic loop headlessly and saves the result.

Canned templates:
- **Video ↔ Code cross-reference** — what the video claims vs. what the
  commits actually show, with `[COMMIT:sha]` / `[FILE:path]` citations,
  timestamps, and screenshots. (The original ask is this template with a
  default prompt.)
- **Change summary** — freeform digest over selected sources.

Reports are point-in-time artifacts with a "regenerate" button (no
scheduling/auto-update). Export: .md + images (or self-contained HTML —
decide at build time).

## Storage

`projects.json` (plugin-store, same pattern as everything else):
project records with member ids, serialized chat thread, and report
metadata. Report markdown inline while small; spill to
`<appDataDir>/reports/<id>.md` if they get big. Screenshot images always
on disk under `<appDataDir>/reports/<reportId>/`.

## Build order

1. **Data layer + routes** — `$lib/projects.ts` CRUD, `/projects` list,
   `/projects/[id]` detail with member picker.
2. **Project chat** — parameterize the repo toolset with `repo`, attach
   member videos as media, timestamp chips. (Biggest chunk; mostly
   refactoring `gemini.ts` tool wiring.)
3. **Reports** — `generate_report` tool + Reports tab (list, view,
   export, delete, regenerate), `[SHOT:…]` → frame-extraction pipeline,
   provenance.
4. **Polish** — templates, provenance chips, citations linking into the
   research view.

## Deferred / out of scope (for now)

- Multiple chat threads per project.
- Scheduled or auto-updating reports.
- Per-repo report tab next to digests (subsumed).
