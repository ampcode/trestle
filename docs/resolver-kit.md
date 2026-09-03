# The Resolver Kit: Primitives, Strategies, and the Bootstrap Path

Companion to [extract-resolve.md](./extract-resolve.md) §2. That document
defines the resolver *contract*; this one answers a different question: **what
is shared across all languages and use cases that lets us streamline building
semantic resolvers?**

The claim: nearly every semantic resolver in every profile we have specced —
Java, mainframe, Rails, ETL, PII — is built from **eight primitive
operations** over the standard fact kinds.

Resolvers stay **programs**. We deliberately do not build a declarative
strategy DSL: the primary resolver authors are coding agents, which write
programs fluently and hit a DSL's expressiveness walls exactly where legacy
estates get weird. What the kit ships instead:

1. a **resolver API** — the eight primitives as library functions, plus
   the scaffolding every resolver shares;
2. a **program template** — one standard shape every resolver follows;
3. an **authoring skill** — the instructions an agent (or human) follows to
   go from survey output to a reviewed, fixture-tested resolver.

No kernel change is involved; this is all profile-layer tooling.

---

## 1. Why universal primitives exist at all

The standard fact library is not just a convenience vocabulary — it encodes a
structural claim: **every code estate, in any language, reduces to the same
six relationships**:

| Invariant structure | Java | Mainframe | Rails | ETL |
|---|---|---|---|---|
| definition | class, method | program, paragraph | class, model | workflow, mapping |
| reference | import, type use | COPY, symbolic ref | require, constant | table ref |
| containment | package ⊃ class ⊃ method | job ⊃ step; program ⊃ paragraph | app ⊃ model | project ⊃ workflow ⊃ step |
| invocation | call, dispatch | CALL, LINK, XCTL, EXEC | send, callback | session run |
| data access | table/queue R/W | dataset/DB2 R/W | AR query | source/target R/W |
| binding-through-config | Spring XML, properties, JNDI | DD cards, CSD, scheduler | routes, YAML config | connection refs, parameters |

Because parsers already normalize everything into this shape, semantic
resolvers never operate on languages — they operate on **fact shapes**, which
are invariant. That is the entire reason a generic strategy library can
exist. (It is also the design pressure that keeps the standard fact library
honest: a proposed fact kind that doesn't fit one of these six rows is
usually a domain prop in disguise.)

The second invariant is the one nobody expects until they've written a few
resolvers: **almost all semantic resolution is a keyed join.** A reference
holds a key; something else maps that key to a target; the resolver's job is
to walk the mapping and emit an edge with evidence from both sides. The
variation between "Spring bean wiring" and "JCL DD resolution" — which look
utterly unrelated — is only *which facts carry the key, what scopes the
mapping, and what transforms the name*.

---

## 2. The eight primitives

Each primitive is listed with its instances across profiles — the evidence
that it is genuinely universal, not a Java-ism or COBOL-ism.

### P0. Fact mapping — transcribe facts into typed entities

```
fact(kind, props)  ⟹  node/edge template  [identity extracted from props,
                                            evidence + authority carried over]
```

The degenerate-but-dominant case: when the fact already *contains* the
conclusion (SCIP reference, compiler cross-reference, linker binding, typed
AST), turning it into a graph entity is a mechanical rewrite, not a join.
`mapFacts` takes a rule table — fact kind + predicate → entity template with
identity extraction — and the API does the rest: evidence attaches
automatically from the fact's locator and `authority`, endpoints
auto-vivify, each rule gets a name:

```ts
mapFacts({
  "call-observed": [{
    when: f => f.authority?.tool === "scip-java",
    edge: "CALLS",
    from: f => id.method(f.props.caller),   // SCIP symbol → profile identity
    to:   f => id.method(f.props.callee),
    rule: "scip-call",
  }],
  "unit-defined": [{
    node: f => ({ kind: kindFromScip(f.props.kind), qualifiedName: id.of(f.props.symbol) }),
    rule: "scip-def",
  }],
})
```

Most adopting-indexer outputs (SCIP, compile listings, bytecode, linker
maps) are consumed almost entirely by one P0 resolver plus a handful of
identity transforms (P2) for the symbol-scheme mapping. It is still a
program — the table lives in code, composes with predicates and helpers —
but the common case is ten lines, and a coding agent can write it from the
fact-kind schemas alone.

### P1. Binding join — resolve a reference through a mapping table

```
subject ─ref(key)─▶ ?    +    binding(key → value, in scope S)    +    target named value
                    ⟹    subject ─EDGE→ target   (evidence: both locators)
```

Instances: JCL DD resolution (`ASSIGN TO INVDD` ⋈ DD cards, scoped by which
step executes the program), Spring wiring (injection point ⋈ bean space,
scoped by profile activation), CICS routing (tranId ⋈ CSD), web.xml servlet
mapping, JNDI, ETL connection refs, Rails routes. **The single most common
semantic resolver shape in existence.** The subtle part is the *scope clause*
(a binding only applies in some context); the strategy makes scope an
explicit join chain rather than implicit code.

### P2. Name transform — derive target names by convention

```
name ─f─▶ name'     where f is a deterministic string function
```

Instances: Rails pluralization/snake_case, JPA naming strategies, mainframe
prefix conventions (`ACCT9*` router families), GDG normalization, DD-name
patterns, module coordinates. Transforms compose with P1 (transform the key,
then join). Expressed as declarative rules: literal maps, case transforms,
affix patterns, regexes — each rule named so every edge says which one
matched.

### P3. Constant propagation — bound local value flow

```
variable ⇐ observed assignments ⇒ possible values at use site
```

Instances: dynamic COBOL `CALL WS-PROG` via MOVE chains, `Class.forName`
with locally-built strings, URL templates for internal HTTP calls, ETL
parameter substitution. Strictly *intra-parse-unit* (facts already carry
`assignmentsObserved`); anything requiring cross-unit flow escalates to a
claim rather than growing into a whole-program dataflow engine.

### P4. Propagation to fixpoint — label spreading over resolved edges

```
seed(nodes, label) + rule(label × edgeKind → label)  ⇒  closure
```

Instances: PII/taint flow, `@Transactional` span propagation, trigger
cascades, reachability from entry points, decommission candidacy (nothing
live reaches this). Runs *late* (phase 30+) over edges earlier passes
resolved. One engine implementation of worklist-until-fixpoint; profiles
supply seeds and rules.

### P5. Lifting — aggregate edges along containment

```
member₁ ─E→ member₂   ⟹   container(member₁) ─E'→ container(member₂)  [count, weight]
```

Instances: method-level CALLS lifted to class- and module-level for
clustering; paragraph-level PERFORMs lifted to programs; step-level dataset
access lifted to jobs. Universal because every ontology has containment.
This is also where clustering weight inputs come from, so the lift strategy
and the weight model share vocabulary.

### P6. Corroboration — merge multi-source evidence, detect conflict

```
same logical assertion, N evidence records ⇒ one edge, N citations; disagreement ⇒ claim
```

Instances: bytecode vs source vs SCIP on one CALLS edge, runtime traces
confirming static edges, compile listings vs fresh source parse, staleness
downgrades. Policies (which extractor outranks which, what counts as
contradiction) are configuration; the merge machinery is one implementation.

### P7. Survey — tabulate the unresolved population

```
population(filter) × rule set ⇒ coverage report + top unmatched patterns + claims
```

Instances: "4,112 dynamic call sites: 78% match MOVE-literal, 15% match
prefix rule, 294 unexplained — here are the 10 most common unexplained
shapes." Not an afterthought: **the survey is the first resolver you run,
not the last**, because it tells you which rules to write ranked by coverage
gain, and it is how convention knowledge is *mined* rather than guessed.

---

## 3. The resolver API and the template

Every resolver is the same five-part program; the API makes each part one or
two calls, and the type system enforces the parts you must not skip
(two-sided evidence, an unmatched policy). The canonical binding-join,
`dd-resolution`, as an actual resolver program:

```ts
import { resolver, bindingJoin, rules, claim } from "trestle";

export default resolver({
  name: "dd-resolution",
  phase: 20,
  consumes: { facts: ["binding-observed", "execution-observed"] },

  run(slice, emit) {
    // 1. INDEX — corpus-wide lookup tables from the materialized slice
    const fileControls = slice.facts("binding-observed")
      .where(f => f.props.bindingKind === "file-control");
    const ddCards = slice.index("binding-observed",
      f => f.props.bindingKind === "dd" ? [f.props.job, f.props.step, f.props.ddName] : null);
    const stepsExecuting = slice.index("execution-observed",
      f => [f.props.executes]);   // program name → steps that run it

    // 2. RULES — named, so every edge says which rule produced it
    const modeRules = rules("access-mode", [
      { name: "open-input",  when: fc => fc.props.mode === "input",  edge: "READS" },
      { name: "open-output", when: fc => fc.props.mode === "output", edge: "WRITES" },
      { name: "open-io",     when: () => true,                       edge: "UPDATES" },
    ]);

    // 3. JOIN — P1: reference(key) ⋈ binding(key→value), scoped
    for (const fc of fileControls) {
      const program = fc.sourceUnit.name;
      const matches = stepsExecuting.get(program)
        .flatMap(step => ddCards.get([step.job, step.step, fc.props.assignTarget]));

      // 4. EMIT — evidence cites BOTH sides of the join
      for (const dd of matches) {
        const rule = modeRules.apply(fc);
        emit.edge(rule.edge,
          { from: `Program:${program}`, to: `Dataset:${dd.props.dataset}`,
            identity: { executionContext: `${dd.props.job}.${dd.props.step}` } },
          { evidence: [fc, dd], rule: rule.name });
      }

      // 5. UNMATCHED — mandatory; silence is not an option
      if (matches.length === 0)
        emit.claim("dd-unbound", { about: fc, detail:
          `ASSIGN TO ${fc.props.assignTarget} never allocated by any step executing ${program}` });
    }
  },
});
```

The API surface, mapped to the primitives: `bindingJoin` / `slice.index`
(P1), `nameRules` (P2 — ordered transform rules, each named + confident),
`propagateConstants` (P3), `fixpoint` (P4), `liftEdges` (P5),
`corroborate` (P6), and `survey` (P7). Plus the shared skin every resolver
gets for free: slice readers, the named-rule runner, a directive emitter
whose types require evidence on every edge and a claim or explicit `ignore`
for every unmatched reference, and a **golden-test harness** (fixture JSONL
in → expected directives out; determinism checked by double-run).

Why a program and not config: the scope clause in the join above (`DD binding
applies only in steps executing this program`) is three lines of code here
and was the hairiest part of the declarative design — and real estates only
get weirder from there (conditional allocations, overridden PROC symbolics,
per-environment CSDs). Agents handle "weirder" in a general-purpose language;
a DSL handles it with feature requests. The review artifacts — fixtures,
per-rule coverage, impact diffs — carry the safety burden the DSL was
supposed to carry, and they work equally well for any program shape.

---

## 4. The bootstrap path

The streamlined experience the kit exists to serve — from empty project to
working semantic graph:

```
# fork/clone the trestle repo; edit profile.ts from the nearest example
# (java, mainframe, …) — the repo ships running seed code to imitate
trestle parse && trestle resolve
trestle survey                  # THE step: coverage report over the six
                                #   invariant relationships — % references
                                #   resolved, unbound binding keys, dynamic
                                #   sites, top unmatched name patterns,
                                #   ranked by coverage gain
trestle resolver new dd-fix --from-survey 3
                                # scaffold: a resolver PROGRAM from the
                                #   template — consumes/phase pre-wired,
                                #   golden fixtures generated from the real
                                #   corpus samples behind survey finding #3
trestle resolve --diff          # impact diff: edges added/removed per rule,
                                #   claims opened/closed, coverage delta
```

Iterate the last two steps until the survey's unresolved population is
claims-only; route claims to SMEs or agent workers; decision files close the
loop.

Two properties make this loop fast and safe:

- facts persist (no re-parsing while iterating on resolvers — seconds, not
  hours);
- resolve is deterministic and additive, so `--diff` between resolver
  versions is a reviewable artifact, like a code diff for inference.

The **`building-resolvers` skill is the centerpiece** of the streamlined
experience, because the primary resolver author is a coding agent. The skill
carries: the five-part template with the worked example above, the eight
primitives and when each applies, the author's invariants (§5) as hard
requirements, and the exact workflow — read the survey, inspect the real
corpus samples behind a finding, write the resolver against the API, make the
golden fixtures pass, run `trestle resolve --diff`, and present the impact
diff plus a sample of newly emitted edges for human review. "Bootstrap my
project" then becomes an agent task where humans review evidence and diffs,
not code style: named rules and two-sided evidence are what make a
resolver written in thirty seconds by an agent *auditable* in two minutes by
a person.

---

## 5. Author's invariants (the checklist)

Restated compactly — every semantic resolver, strategy or custom, obeys:

1. **Backward from the projection.** No resolver without a named downstream
   question; the chase from question → edge kind → facts → parsers also
   locates gaps in the right layer.
2. **Global joins over local facts.** Parsers stay local; resolvers own all
   cross-file inference. Never work around a parser gap inside a resolver.
3. **Read resolved structure, not raw text.** Consume earlier phases' edges;
   a resolver growing its own symbol resolution is duplicating phase 20 and
   will disagree with it.
4. **Additive and deterministic.** Emit, never delete; same slice in, same
   directives out. Composability of phases depends on both.
5. **Named rules.** Audit happens at rule granularity: every edge names the
   rule that produced it.
6. **Two-sided evidence.** A join emits evidence citing both joined locators,
   or it isn't a join worth trusting.
7. **Uncertainty is output.** A rule that cannot justify an edge emits a
   claim, never a weaker edge; there is no confidence score to hide
   behind. Silence is never an option — the API's
   emitter requires a claim or an explicit `ignore` for every unmatched
   reference.
8. **Survey before rules.** Mine conventions from the corpus population;
   write rules ranked by measured coverage gain.
