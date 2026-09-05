# G6VP build

The files one directory above are a production build of a small Trestle app
using [AntV G6VP](https://github.com/antvis/G6VP), licensed under Apache-2.0
and pinned to upstream commit `81b99139a7b72b5045705758b7021e6cf5970532`.
The app uses `@antv/gi-sdk` and `@antv/gi-assets-basic` 2.4.23 with a native
same-origin `/api/graph` data service. It does not require G6VP's site or HTTP
service.

The complete app source and dependency lock are in `source/`. From the
repository root, rebuild with:

```sh
npm run build:viz
```

This installs the locked frontend dependencies with `npm ci`, typechecks
the JSX with TypeScript's `checkJs`, and builds with Vite. Only after those
steps succeed does it replace `src/viz/assets/` and `src/viz/index.html`.
Temporary build output is removed; source and license files are preserved.
Commit the regenerated assets alongside source changes.

Vite resolves G6VP's historical `~antd/` Less imports with an alias; no
dependency files are patched and no source files need to be moved.

Root `npm test` rebuilds the app before exercising the server's asset and
API tests. Root `npm run typecheck` checks both the engine and the JSX app
(without replacing served assets). Both commands install the locked
frontend dependencies automatically, so a fresh clone needs no separate
frontend setup. They require registry access or a populated npm cache.

`package.json` `overrides` prune dependencies that G6VP's packages list but
the bundle never uses (`dumi`, a docs generator, and `fmin`'s ancient
`rollup`) and pin `nanoid`/`postcss` to patched versions. They exist to keep
`npm audit` clean; if a rebuild fails, check them first.

Retain `LICENSE` when redistributing the build.
