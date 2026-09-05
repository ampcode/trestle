# Generated anti-slop plugin

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop),
revision [e8c4880](https://github.com/dmmulroy/anti-slop/commit/e8c4880471b23ab7f216fba7b27d173a6ef07d4c).
The TypeScript plugin files are unchanged from upstream's skill assets.
The MIT notice is retained in `LICENSE`.

The complete upstream installer skill is in
`.agents/skills/installing-anti-slop/`; only its frontmatter name and
description were adapted to this repository's skill conventions.
Its assets are the versioned source of truth. The rule modules in this
directory are gitignored; only this README and the license are versioned.
`npm run lint` runs the installer with `--force` through `prelint`,
recreating the modules offline even on a fresh checkout. Edit or upgrade
the skill assets, not this generated copy. Direct `npx oxlint` requires
the copy to have been generated first.

`oxlint.config.ts` enables all 15 generic rules at error severity. The
Effect plugin is included but not enabled: Trestle does not directly depend
on Effect. Keep `oxlint` and `@oxlint/plugins` pinned to the same version.
`no-runtime-typeof` uses upstream's `allowInTypeGuards: true`: runtime
checks belong in explicit predicates at input boundaries, not scattered
through business logic. The remaining rules use their default options.

Run `npm run lint` from the repository root. Application TypeScript and
JavaScript, tests, and the JSX source are checked; corpora, generated
assets, dependencies, agent tooling, and this vendored plugin are excluded.
Run `npm run typecheck` and `npm test` as well: lint is not a substitute
for the root and JSX typechecks or behavior tests.

## Small Linux orbs

Oxlint's JS-plugin allocator reserves multi-GiB virtual-memory arenas.
On small, swapless Linux VMs, heuristic overcommit can reject the reservation
before linting starts ([upstream issue](https://github.com/oxc-project/oxc/issues/20331)).
`.agents/setup` sets `vm.overcommit_memory=1` only when running in an Amp orb
and persists it in `/etc/sysctl.d/90-trestle-oxlint.conf`. This allows the
virtual reservation; it does not add physical memory. Local-machine memory
policy is left untouched.
