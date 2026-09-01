# Trestle graph repo

This repository is a Trestle knowledge-graph project: the engine (src/),
your vocabulary (profile.ts), extraction pipeline (extract/), resolvers
(resolvers/), and the code under analysis as pinned submodules under
corpora/. There is no install or init step beyond `.agents/setup` — the
repo is the application.

## The loop

1. `npx trestle profile build` — compile profile.ts to profile.lock.json
2. `npx trestle extract` — run the extraction pipeline (facts, incremental)
3. `npx trestle resolve` — run resolvers in phase order (graph)
4. `npx trestle survey` — what is unresolved, ranked; decides the next step

## Rules

- Vocabulary (node/edge/fact kinds) lives in profile.ts — inert data only.
- The pipeline transcribes; it never infers. Resolvers infer; they never
  read artifacts. Every edge carries evidence; every unmatched reference
  becomes a claim or an explicit ignore.
- Facts persist: iterate on resolvers without re-extracting.
- Visualization styling lives in trestle.config.ts. The Amp portal service
  (`trestle serve`) renders the graph explorer at / from the live SQLite
  store — no `trestle project build` needed. After changing presentation
  config, run `amp orb service restart trestle`; graph data itself updates
  on browser refresh.
- corpora/ is read-only source material. Never edit files there; a corpus
  changes only by moving its submodule pin. Add estates with
  `npx trestle corpus add <git-url>` (regular filesystem/search tools work
  inside submodules once initialized).
- Engine code lives in src/ with tests in tests/. Graph work (profile,
  pipeline, resolvers) should not require engine changes; if it does,
  consider sending the change upstream.

## Skills

Before editing each surface, load its skill from `.agents/skills/`:

- profile.ts → authoring-trestle-profiles
- extract/pipeline.ts → writing-trestle-extractors
- resolvers/*.ts → writing-trestle-resolvers
- deciding what to do next → running-the-trestle-loop

## Upgrading the engine

This repo is distributed by forking/cloning. Pull engine updates with git:

```sh
git remote add upstream https://ampcode.com/@jesse/trestle  # once
git fetch upstream && git merge upstream/main
```

Your profile, pipeline, resolvers, and corpora are ordinary committed files,
so upstream merges compose with your work like any other git history.

## Project notes

(add project-specific conventions here)
