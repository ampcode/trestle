# Corpus survey: map the estate before picking tools

Goal: a table of artifact types → counts → the observations each carries.
That table drives both the profile vocabulary and tool selection. Do this
before writing any pipeline code for a new corpus.

Corpora are read-only pinned submodules under `corpora/` (see
`trestle.config.ts` `corpusRoots`). Survey with ordinary shell tools; the
`corpus` API only exists inside the pipeline.

## 1. File-type breakdown

```sh
git -C corpora/<name> ls-files \
  | sed -n 's/.*\.\([^./]*\)$/\1/p' | sort | uniq -c | sort -rn | head -30
```

Also count extensionless files (scripts, JCL members, copybooks often lack
extensions):

```sh
git -C corpora/<name> ls-files | grep -v '\.' | head -20
```

Use `git ls-files`, not `find` — it respects the pinned tree and skips
`.git`. For a rough size signal per language, `cloc corpora/<name>` if
available; otherwise `wc -l` over the dominant extensions.

## 2. Build-system and framework detection

Presence of these files tells you which compiler-grade tools apply
(see `tool-selection.md`):

| Marker | Ecosystem |
|---|---|
| `pom.xml`, `build.gradle*`, `settings.gradle*` | Java/JVM — javac, scip-java |
| `compile_commands.json`, `CMakeLists.txt`, `configure.ac`, `Makefile` | C/C++ — clang tooling |
| `package.json`, `tsconfig.json` | JS/TS — TS compiler API, scip-typescript |
| `go.mod` | Go — go/ast, go/packages |
| `Cargo.toml` | Rust — rust-analyzer |
| `*.sln`, `*.csproj` | C#/.NET — Roslyn |
| `pyproject.toml`, `setup.py`, `requirements.txt` | Python — ast/LibCST |
| `Gemfile` | Ruby — prism |
| `composer.json` | PHP — nikic/php-parser |
| JCL members, `*.cbl`, `*.cpy` | Mainframe — line-oriented + COBOL parsers |

Framework-specific config XML/YAML (Spring, servicedef, entitymodel,
web.xml, controller definitions) is often the highest-semantics artifact in
the corpus — inventory it explicitly; it usually deserves its own fact
kinds.

## 3. Exclusions

Identify and exclude before counting anything else:

- generated code (`target/`, `build/`, `gen/`, `*_pb2.py`, `*.g.cs`)
- vendored dependencies (`node_modules/`, `third_party/`, `vendor/`)
- test fixtures that are data, not code

Record exclusions as pipeline list-filters (regexes passed to
`corpus.list`), not by editing the corpus — corpora are read-only.
If tests matter to the migration (they usually do), keep them but plan a
`scope: production|test` prop on usage facts rather than dropping them.

## 4. Output: the artifact table

Write the result into the repo (AGENTS.md Project-notes or a doc), shaped
like:

| Artifact type | Count | Observations it carries | Candidate fact kinds |
|---|---|---|---|
| `servicedef/services*.xml` | 120 | service name, engine, invoke target | `service-defined` |
| `*.java` | 1,252 | class defs, imports, dispatcher calls | `java-class-defined`, `java-import-observed`, … |

Then take the table to `tool-selection.md` to pick a reader for each row.
