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
npm ci
# G6VP's published Less imports use webpack's historical `~` prefix.
rg -l '~antd/' node_modules --glob '*.less' | xargs sed -i 's/~antd\//antd\//g'
npm run build
rsync -a --delete --exclude upstream/ dist/ "$OLDPWD/src/viz/"
```

Retain `LICENSE` when redistributing the build.
