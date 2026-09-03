# G6VP build

The files one directory above are a production build of a small Trestle app
using [AntV G6VP](https://github.com/antvis/G6VP), licensed under Apache-2.0
and pinned to upstream commit `81b99139a7b72b5045705758b7021e6cf5970532`.
The app uses `@antv/gi-sdk` and `@antv/gi-assets-basic` 2.4.23 with a native
same-origin `/api/graph` data service. It does not require G6VP's site or HTTP
service.

The complete app source and dependency lock are in `source/`. To rebuild:

```sh
cp -R src/viz/upstream/source /tmp/trestle-g6vp
cd /tmp/trestle-g6vp
mkdir src && mv main.jsx styles.css src/   # index.html loads /src/main.jsx
npm ci
# G6VP's published Less imports use webpack's historical `~` prefix.
rg -l '~antd/' node_modules --glob '*.less' | xargs sed -i 's/~antd\//antd\//g'
npm run build
rm -rf "$OLDPWD/src/viz/assets" && cp -R dist/assets dist/index.html "$OLDPWD/src/viz/"
```

`package.json` `overrides` prune dependencies that G6VP's packages list but
the bundle never uses (`dumi`, a docs generator, and `fmin`'s ancient
`rollup`) and pin `nanoid`/`postcss` to patched versions. They exist to keep
`npm audit` clean; if a rebuild fails, check them first.

Retain `LICENSE` when redistributing the build.
