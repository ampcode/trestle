# Trestle CLI and SDK

- This is the engine's contributor repository, not a user's graph workspace.
  `trestle init` bootstraps the repository being analyzed by default.
- Engine code lives in `src/`; the public authoring SDK is `src/index.ts`.
  `assets/project/` contains the scaffold. Do not initialize over the engine checkout.
- Build with `npm run build`; `bin/trestle.js` executes built JavaScript from `dist/`.
  `npm run test:package` installs a tarball into an unrelated directory and tests
  the CLI, SDK, Amp integration, graph loop, and bundled server assets.
- User code is TypeScript outside `node_modules`; package runtime is compiled JS.
  Keep packaged resources relative to the package, and user paths relative to config.
- New projects isolate npm dependencies and TypeScript in `trestle/`; bootstrap
  must not create or change application package manifests, lockfiles, or compilers.

## Rules

- Vocabulary (node/edge/fact kinds) is inert data only.
- The pipeline transcribes; it never infers. Resolvers infer; they never
  read artifacts. Every edge carries evidence; every unmatched reference
  becomes a claim or an explicit ignore.
- Facts persist: iterate on resolvers without re-extracting.
- Visualization styling lives in the project's Trestle config. The Amp portal service
  (`trestle serve`) renders the graph explorer at / from the live SQLite
  store — no `trestle project build` needed. After changing presentation
  config, run `amp orb service restart trestle`; graph data itself updates
  on browser refresh.
- Bootstrap and Amp installers preserve user-owned code and shared configuration.
  Refresh/remove only verified owned assets; test collisions and modified files.
- Existing `trestle.config.ts` projects retain their configured paths and stores.

## Skills

The domain skills under `.agents/skills/` guide graph authoring. The installable,
project-path-aware versions live under `assets/skills/`:

- profile.ts → profiles
- extract/pipeline.ts, choosing parsers/indexers → extraction
- resolvers/*.ts → resolvers
- deciding what to do next → loop
- configuring the explorer → `assets/skills/trestle-visualizing/SKILL.md`
- installing/updating anti-slop lint rules → installing-anti-slop

User projects upgrade their package dependency, not by merging this engine repo.

## Linting

- Run `npm run lint` for Oxlint with all generic anti-slop rules enabled.
  Configuration lives in `oxlint.config.ts`; vendored rule provenance and
  upgrade notes are in `tools/oxlint/anti-slop/README.md`.
  Its `prelint` hook regenerates gitignored rule modules from the versioned
  installer skill assets; do not edit the generated copy.
- Keep lint clean without disabling rules or adding blanket suppressions.
  Run `npm run typecheck` and `npm test` alongside lint; both check the JSX
  app, and tests rebuild its bundled assets.
- JSON properties use `Properties`/`JsonValue` from `src/profile/value.ts`
  (also exported by `trestle`). Narrow external inputs at the boundary;
  use owner-specific contracts for SQLite query results. A necessary cast
  must state its actual invariant in a nearby `SAFETY:` comment.
