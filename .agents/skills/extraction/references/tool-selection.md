# Tool selection: parser/AST/compiler/indexer routing

## How to choose

1. **Start from the question, not the language.** List the edge kinds in
   `profile.ts` and what each needs from source. The minimum tier that
   answers each:

   | You need | Minimum tier |
   |---|---|
   | imports / include / declared dependencies | 5 (line scan) |
   | data layouts, config wiring, entry points in XML/JCL/BMS | 4–5 (structured or line parse) |
   | which class inherits / implements what | 3 (AST) |
   | call sites with literal targets, dynamic-dispatch sites | 3 (AST) |
   | *which* `Foo` a name refers to across files | 2 (compiler) or 1 (index) |
   | cross-package call graph, type of every expression | 1–2 |

   Most migration graphs (dependencies, data access, entry points, seams)
   are answerable at tiers 3–5. Do not pay for a compiler you do not need.

2. **Find the ecosystem row below** for each artifact type the corpus
   survey found. Not listed → web-search protocol at the bottom.

3. **Probe what actually runs here**, top of the ladder down: is the
   toolchain on PATH (`which javac clang dotnet`)? Does the corpus build
   (`compile_commands.json`, `mvn -q compile`, `dotnet build`)? Are
   compiled binaries shipped (`.jar`, `.class`, `.dll` — bytecode readers
   give resolved names with no build)? Legacy estates usually fail the
   build step; expect it, and drop one tier, not to regex.

4. **Pick the highest tier that runs and answers the question.** Mixing
   tiers on the same artifact is normal — line scan for imports, AST for
   calls — in separate cells with separate `authority`.

5. **Record it**: `authority: { tool, version }` on every fact. There is
   no confidence knob — a reader either observes something or it does not.
   Unresolvable names are claims for the resolver, never guessed edges.

## Tiers

1. **Existing index** — someone already did the analysis (SCIP/LSIF index,
   compiler build reports, `jdeps`, `gradle dependencies`). Transcribe it;
   never re-derive it.
2. **Compiler API / plugin** — resolved names, real semantics
   (javac `JavacTask.analyze`, Roslyn semantic model, clang, TS compiler
   API). Bytecode/IL readers (ASM, `System.Reflection.Metadata`) sit here
   too: resolved names from shipped binaries, no build required.
3. **Dedicated AST library** — full syntax, no resolution
   (javac `JavacTask.parse`, Python `ast`, prism, nikic/php-parser, Spoon
   in noclasspath mode).
4. **tree-sitter / hand-written column readers** — syntax-only,
   error-tolerant, works on anything with a grammar or a fixed layout; good
   when the compiler can't run (broken/partial corpus, COBOL).
5. **Regex / line scan** — line-oriented formats and quick literal scans
   (imports, JCL, properties). Fine when the format is genuinely flat;
   never for bodies of a block-structured language.

Higher tiers give resolution (which `Foo` is this?); lower tiers give reach
(runs on anything).

## Curated index

Route by what the corpus survey found.

| Ecosystem | Signals | Tools, in preference order | Integration notes |
|---|---|---|---|
| Java/JVM | `pom.xml`, `build.gradle*`, `*.jar`/`*.class` | scip-java (needs a working Maven/Gradle build, JDK 17+); javac `JavacTask.analyze` with whatever classpath resolves (partial is fine — unresolved names become claims); `jdeps -verbose:class` / ASM over shipped jars (resolved names, no build); javac `JavacTask.parse` syntax-only (calls, literal args, inheritance as written); Spoon noclasspath or JavaParser+SymbolSolver when the build is dead but types matter; tree-sitter-java only if no JDK is possible; import regex for imports only | JDK on Debian stable is `openjdk-17-jdk-headless`. `scip print --json` is hundreds of MB on a monolith — stream it. javac: one JVM per source root, not per file; fold same-file string constants so literal dispatch targets survive. Never regex Java bodies for calls or types. `gradle dependencies` / `mvn dependency:tree` are index-tier for declared deps. |
| Groovy | `*.groovy`, Gradle scripts | Groovy compiler AST at CONVERSION phase | Runs pre-resolution: names are syntactic; dynamic receivers become claims, not edges. |
| C/C++ | `compile_commands.json`, `CMakeLists.txt` | clang `-ast-dump=json` per TU; scip-clang; tree-sitter-cpp | Without `compile_commands.json`, generate via `cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON` or `bear`. AST-dump JSON is large; extract per-TU cells. Historical estates (90s/2000s C++) rarely compile under a modern clang — missing generated headers, pre-standard C++; fall back to deterministic include/structure scans and `corpus.read(path, "latin1")` for pre-UTF-8 sources. |
| JS/TS | `package.json`, `tsconfig.json` | TS compiler API (`ts.createProgram`); scip-typescript; @babel/parser | TS API runs in-process in the pipeline — no `run` needed; still record `authority` with the ts version. |
| Python | `pyproject.toml`, `*.py` | stdlib `ast` (small dump-to-JSON script via `run`); LibCST (preserves trivia); scip-python | stdlib `ast` needs a matching Python 3 on PATH; pin the version in `authority`. |
| Go | `go.mod` | `go/ast` + `go/packages` (small Go program invoked via `run`); scip-go | `go/packages` needs a buildable module; fall back to `go/parser` per file when the build is broken. |
| C#/.NET | `*.sln`, `*.csproj`, `bin/*.dll` | Roslyn (`CSharpSyntaxTree` dump tool); scip-dotnet; `System.Reflection.Metadata` over shipped DLLs (resolved names, no build) | Needs dotnet SDK; one cell per project, not per file, if using MSBuildWorkspace. Legacy .NET Framework/WebForms estates usually will not build on Linux (VS WebApplication targets, .NET Framework reference assemblies): parse syntax-only with Roslyn, or fall back to comment-aware lexical scans with saxes for `.csproj`/config XML. |
| Rust | `Cargo.toml` | `rust-analyzer scip`; `syn`-based dump tool | rust-analyzer scip works without a full build. |
| Ruby | `Gemfile`, `*.rb` | prism (official parser, JSON dump) | `ruby -r prism -e ...` or the prism CLI. |
| PHP | `composer.json` | nikic/php-parser (`php-parse --json`) | |
| COBOL/mainframe | `*.cbl`, `*.cpy`, JCL (`*.jcl`, `*.prc`/`*.proc` procedures), BMS, CSD | custom column-aware fixed-format reader (columns 1–6 sequence, 7 indicator, 8–72 source; strip inline comments before matching); GnuCOBOL `cobc -fsyntax-only` for validation only; ProLeap (ANTLR, needs JVM) | Write the column-aware reader — naive regex over raw source misreads sequence numbers and continuations. `cobc` cannot be the extraction authority on IBM estates: EXEC CICS/SQL and system copybooks fail preprocessing. tree-sitter-cobol on npm is 0.0.1 — skip. Literal CALL/LINK/XCTL transcribe as facts; dynamic (variable) targets become claims, never guessed edges. |
| SQL | `*.sql`, embedded strings | sqlglot (dialect-aware, JSON AST); libpg_query for Postgres | Embedded SQL in host code: extract the string literal as its own fact first, parse in a second cell. |
| XML config | framework XML (Spring, servicedef, entitymodel) | saxes (streaming, in-process); regex only for flat single-tag scans | Highest semantic density per byte in most enterprise corpora — prefer structured parse over regex. |
| Cross-language | anything | universal-ctags `--output-format=json` (rough symbol map); tree-sitter CLI; cloc (sizing only) | ctags is tier-5 semantics with tier-2 reach: fine for a first symbol inventory, keep it in its own fact kind. It scales (5.3M lines in ~6s) but is ownership-blind — it cannot answer which module owns an include or registration; pair with deterministic structural scans for those. tree-sitter native npm bindings fail to build on Node ≥26 (addons compiled without C++20); verify the install before planning around it. |

## Not in the index: web-search protocol

For an ecosystem not covered above, search — do not guess from memory.
Useful query shapes:

- `<language> AST parser CLI JSON output`
- `scip indexer <language>` / `lsif indexer <language>`
- `<language> compiler API dump syntax tree`
- `<build tool> dependency report machine readable`

Evaluate candidates against these criteria before wiring one in:

- **Machine-readable, deterministic output** (JSON/S-expr; same input →
  same bytes, or normalize before emitting facts)
- **Per-file granularity possible** — one cell per file keeps
  incrementality; whole-program-only tools get one cell per invocation
- **Pinnable version**, install weight, license compatible with the corpus
- **Runs offline after `acquire`** — network only in `acquire`, never in a
  cell body
- **Exit codes distinguish parse failure from empty result** — a cell must
  be able to tell "nothing there" from "tool broke"

## Keep the index alive

After a new tool works in a real pipeline: record `tool` + exact `version`
in `authority` on its facts, and **append a row to the table above** with
the integration notes you wish you'd had. The index is committed and
version-matched to this repo; it only stays useful if real pipelines feed
back into it.
