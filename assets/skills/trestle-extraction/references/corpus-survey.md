# Corpus survey: map the estate before picking tools

Goal: a table of artifact types → counts → the observations each carries.
That table drives both the profile vocabulary and tool selection. Do this
before writing any pipeline code for a new corpus.

The corpus defaults to the current repository. Read `corpusRoots` in
`trestle.config.mts` (or legacy `trestle.config.ts`) for additional estates.
Treat corpus files as read-only during graph construction. Survey with shell tools; the
`corpus` API only exists inside the pipeline.

## 1. File-type breakdown

```sh
git ls-files --cached --others --exclude-standard \
  | sed -n 's/.*\.\([^./]*\)$/\1/p' | sort | uniq -c | sort -rn | head -30
```

Also count extensionless files (scripts, JCL members, copybooks often lack
extensions):

```sh
git ls-files --cached --others --exclude-standard | grep -v '\.' | head -20
```

Use `git -C <root>` for another configured corpus root. Git skips ignored
untracked files; apply configured exclusions too. For a rough size signal, `cloc .` if
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

Record excluded files/directories in `corpusExclude` (config-relative paths),
or select input types with `corpus.list` filters. Do not edit the corpus to filter it.
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
