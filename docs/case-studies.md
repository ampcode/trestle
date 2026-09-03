# Case Studies: Two Real Repos Through the Full Pipeline

Companion to [extract-resolve.md](./extract-resolve.md). The worked examples
there are composites; this document runs two **real, verified** codebases
through the whole lifecycle (acquire → index → resolve → project) to test
whether the kernel survives contact with genuine enterprise mess. Facts,
file paths, class names, and scale numbers below were verified against the
actual repositories.

Chosen adversarially:

- **Apache OFBiz** (Java): a ~20-year-old ERP monolith where almost *no*
  wiring is visible to a Java compiler — ~2,500 services defined in ~110
  `servicedef/services*.xml` files, dispatched by string name, plus a
  string-keyed entity engine, XML web controllers, and event rules that
  trigger services from other services. Static Java analysis alone sees a
  monolith of methods calling `runSync(String, Map)` and nothing else.
- **Wireshark** (C): ~2,000 dissector `.c` files whose inter-module calls
  flow through runtime registration tables keyed by ports and MIME strings,
  registration discovered by *regex scan at build time*, and ~130 dissectors
  generated from ASN.1 plus more from PIDL — generated outputs checked into
  the tree where they can silently drift from their inputs.

If the kernel needs an `if` for either, the design fails its own regression
test.

---

## Case A: Apache OFBiz — monolith → containerized modules

### A.1 What makes it hard

The librarian-verified dispatch chain is:

```text
caller string ("createQuote")
  → ModelService(name)            # parsed from servicedef/services*.xml
  → engine (java|groovy|simple|entity-auto|interface)
  → location + invoke             # class+method, script+function, minilang, or entity CRUD
```

Java callers do `dispatcher.runSync("createQuote", ctx)` — the callee is a
string. Entities are the same: `delegator.findOne("StatusItem", …)`.
Web routing is XML: `<event type="service" invoke="findOrders"/>` in
`controller.xml`. SECA rules add hidden service→service edges:
`<eca service="storeOrder" event="return"><action service="resetGrandTotal" …/></eca>`.
And one subtlety that justifies user-owned filtering: **only the
`services*.xml` files registered via each component's `ofbiz-component.xml`
are live** — globbing the filesystem overcounts.

### A.2 Profile vocabulary (user-enumerated)

```yaml
nodes:
  - { kind: Service,    identity: [name] }              # logical service
  - { kind: Entity,     identity: [entityName] }
  - { kind: Class,      identity: [fqn] }
  - { kind: Method,     identity: [fqn, signature] }
  - { kind: Script,     identity: [componentUri, function] }   # groovy/minilang
  - { kind: RequestMap, identity: [webapp, uri] }
  - { kind: EcaRule,    identity: [service, event, seq] }
  - { kind: Component,  identity: [name] }               # order, product, …
edges:
  - { kind: INVOKES_SERVICE, identity: [site] }          # call site → Service
  - { kind: IMPLEMENTED_BY }                             # Service → Method/Script/Entity
  - { kind: TRIGGERS,        identity: [event, mode] }   # SECA: sync/async matters
  - { kind: ENTITY_ACCESS,   identity: [op] }            # CRUD on Entity
  - { kind: ROUTES_TO }                                  # RequestMap → Service/Method
  - { kind: IMPLEMENTS_IFACE }                           # service interface inheritance
  - { kind: CALLS }                                      # plain Java, from SCIP
```

### A.3 Extraction pipeline (the filtering payoff)

```ts
// 1. Component manifests FIRST — they define what is live
const components = await memo("components", manifests, () =>
  manifests.map(m => parseComponentXml(corpus.read(m))));   // ofbiz-component.xml

// 2. Only *registered* resources get parsed
for (const c of components) {
  for (const f of c.serviceResources)  parseServiceDefs(f);  // unit-defined: Service
  for (const f of c.entityResources)   parseEntityDefs(f);   // unit-defined: Entity
  for (const f of c.webapps)           parseController(f);   // execution-observed
  for (const f of c.secaResources)     parseSecas(f);        // binding-observed
}

// 3. Adopt the SCIP index for the Java layer (acquire or regenerate)
const scip = await acquire("scip", () => fetchSourcegraphIndex(REPO))
          ?? await run("scip-java", ["index", "--build-tool", "gradle"], javaRoots);
emit(transcribeScip(scip));   // authority-stamped defs/refs/calls

// 4. First-hand Java facts SCIP can't see: string literals at dispatch sites
for (const f of javaFiles)
  await memo(`java:${f}`, [f], () => emit(dispatchSiteFacts(f)));
  // call-observed { callee: "LocalDispatcher.runSync", dispatch: "dynamic-string",
  //                 argLiteral: "createQuote" }  — or argLiteral absent if computed
```

Representative facts (all real names):

```jsonc
{ "kind": "unit-defined", "props": { "unitKind": "Service", "name": "sendOrderConfirmation",
    "engine": "java", "location": "org.apache.ofbiz.order.order.OrderServices",
    "invoke": "sendOrderConfirmNotification", "implements": ["orderNotificationInterface"] },
  "locator": { "type": "lines", "startLine": 28 } }          // applications/order/servicedef/services.xml

{ "kind": "call-observed", "props": { "callee": "LocalDispatcher.runSync",
    "dispatch": "dynamic-string", "argLiteral": "createQuote" } }

{ "kind": "data-access-observed", "props": { "target": "StatusItem", "op": "read",
    "via": "Delegator.findOne" } }

{ "kind": "execution-observed", "props": { "trigger": "request-map:searchorders",
    "invokes": "findOrders", "type": "service" } }           // ordermgr controller.xml

{ "kind": "binding-observed", "props": { "scope": "seca", "source": "storeOrder",
    "event": "return", "target": "resetGrandTotal", "mode": "sync" } }
```

### A.4 Resolve

| Resolver | Primitive | What it does |
|---|---|---|
| `scip-lift` | P0 + P2 | SCIP facts → Class/Method nodes, CALLS edges; symbols → aliases |
| `service-identity` | P0 | `unit-defined(Service)` → Service nodes; `implements` → IMPLEMENTS_IFACE |
| `service-impl` | P1 + P2 | Service → IMPLEMENTED_BY → Method (`location`+`invoke` name-join against SCIP-derived Method nodes); groovy/simple engines → Script nodes; `entity-auto` → ENTITY_ACCESS on the default entity |
| `dispatch-join` | P3 + P1 | `runSync` sites: literal arg joins directly; computed arg gets bounded constant propagation; still unknown → **claim** |
| `entity-join` | P1 | `Delegator`/`EntityQuery` string args → ENTITY_ACCESS edges |
| `controller-join` | P1 | RequestMap → ROUTES_TO → Service or Method |
| `seca-join` | P1 | EcaRule → TRIGGERS edges, identity `(event, mode)` — async vs sync stays distinct |
| `component-lift` | P5 | method/service edges lifted to Component level for clustering |
| `bytecode-corroborate` | P6 | bytecode CALLS vs SCIP CALLS vs source heuristics on shared edges |

The honesty valves do real work here. `dispatcher.runSync(serviceName, …)`
where `serviceName` came from a database column is **unresolvable** — the
correct output is a claim, not a guess:

```jsonc
{ "op": "claim", "kind": "unresolved-dynamic-dispatch",
  "about": ["Method:…OrderManagerEvents.runServiceFromRequest"],
  "detail": "runSync arg flows from request parameter; 14 call sites",
  "candidates": null }
```

And the survey (P7) that drives the bootstrap loop. These are **measured**
numbers from the prototype run against the real repo (`prototype/`,
corpus at `corpora/ofbiz-framework`), not estimates:

```text
trestle survey dispatch-sites
  runSync/runAsync/schedule sites ....... 2,073
  resolved via literal .................. 1,314 (63%)
  resolved via constant prop (may-sets) .     1 (0%)   ← in-file literals are rare
  claimed: dynamic, application code ....   654 (32%)
  claimed: dynamic, framework plumbing ..    97 (5%)
  claimed: literal but unknown service ...     7 (0%)
```

**Where the raw layer actually is.** `extract.py` collapses two layers: its
regex is an un-fingerprinted in-process "parser" whose raw output never
exists. `prototype/parse_ast.py` demonstrates the real layering on the same
corpus: stage 1 runs tree-sitter-java over 1,252 Java files and freezes the
parse trees as fingerprinted artifacts (`out/artifacts/ast/manifest.jsonl`,
each record carrying `authority: {tool, version, grammar}` + input hash);
stage 2 transcribes with a tree-sitter *query* — the transcription rule is
data, not engine code:

```scheme
(method_invocation
  name: (identifier) @method
  arguments: (argument_list . (_) @arg0)
  (#any-of? @method "runSync" "runAsync" "runSyncIgnore" "runAsyncWait" "schedule")) @call
```

producing the *same* `call-observed` fact schema, now with adopting
provenance. Running both extractors over the same scope is a free P6
corroboration, and it found real defects in both: 917 sites agree; the
regex's 3 exclusive sites are all **javadoc/comment false positives**
(e.g. `MrpServices.java:817` matches `dispatcher.runAsync("executeMrp",…)`
inside a block comment); the AST's 40 exclusive sites are real
receiver-less overload delegations (`schedule(null, poolName, …)` in
`GenericAbstractDispatcher`) the regex's `\.method(` shape required a
receiver to see. Same fact vocabulary, two authorities, disagreement
surfaced as data — exactly the design's claim.

Reality is messier than the fictional 89/7/4 split this section originally
guessed. Three lessons from the measured residue:

1. **Most "dynamic" sites are framework plumbing whose targets are data.**
   `ServiceEcaAction.runAction` calls `runSync(this.serviceName, …)` where
   `this.serviceName = action.getAttribute("service")` — the SECA XML. The
   `seca-join` resolver already materializes those edges (331 TRIGGERS)
   from the declarative facts; the code-side claim is the same dispatch
   seen from the other end. Classifying claims by path
   (`framework/` vs `applications/`) separates plumbing from real unknowns.
2. **In-file constant propagation barely pays here** (1 site out of 86
   simple-variable candidates — `FinAccountServices` picking between
   `createFinAccount`/`createFinAccountForStore`, emitted as a 2-edge
   may-set at confidence 0.5). OFBiz just doesn't compute service names
   from local literals.
3. **The real residue is data-configured dispatch.** In
   `PaymentGatewayServices`, `serviceName` comes from the
   `ProductStorePaymentSetting` entity — the payment processor is chosen
   per store in database seed data
   (`<ProductStorePaymentSetting … paymentService="alwaysApproveCCProcessor"/>`).
   Recovering these needs one more fact kind (a seed-data indexer over
   `data/*.xml`) plus one more P1 join: seed row → Service. The survey is
   what tells you that indexer is worth writing — 654 claims concentrated
   in a handful of gateway/notification files.

### A.5 Project

Boundary extraction runs on the lifted Component/Service graph:
`INVOKES_SERVICE` (moderate weight, hub-discounted — `createOrderNote` is
called from everywhere), `ENTITY_ACCESS` on **shared entities** (heavy —
two components writing `OrderHeader` is the real coupling), `TRIGGERS`
async (light — already an event seam; sync SECA is heavy, it's a hidden
transaction). `ROUTES_TO` marks the web seams. Interface services
(`implements="orderNotificationInterface"`) are natural API candidates for
module boundaries. Output: candidate module cut + per-cut cost report
(which shared entities must split, which sync SECAs must become events),
each backed by evidence down to file:line.

Measured (prototype, component-level lift; graph: 6,150 nodes / 6,077
edges / 777 claims, 0 stub Services):

```text
top cross-component service invocation        shared-write entities (≥2 writers)
  order         → product        39             WorkRequirementFulfillment: order, workeffort
  manufacturing → workeffort     36             WorkEffortAssoc: manufacturing, workeffort
  product       → content        33             QuoteWorkEffort: order, workeffort
  manufacturing → product        32             RuntimeData: manufacturing, framework/service
  order         → accounting     28             (Testing*: framework test fixtures — noise)
  accounting    → order          16  ← cycle
```

The readout a decomposition team actually wants: `order ↔ accounting` is
**bidirectional** (28 + 16 call sites) — not a layering, a merge candidate
or a deliberate two-way contract. `manufacturing`/`workeffort` couple both
by calls *and* shared writes (`WorkEffortAssoc`) — the expensive kind; a
cut there means splitting table ownership, not just adding an API.
`order → product` (39 sites, no shared writes) is the cheap kind — an API
seam. Every number expands to file:line evidence via the edge's fact IDs.

### A.6 Kernel verdict

No engine change. The two OFBiz-specific behaviors — "only registered
resources are live" and "runSync strings are the real call graph" — landed
in pipeline code and two resolvers. Everything else was vocabulary.

---

## Case B: Wireshark — mapping dispatch that never appears as a call

### B.1 What makes it hard

Cross-dissector calls almost never appear as C calls. The real chain
(verified in `epan/dissectors/packet-echo.c`):

```text
proto_register_echo():  register_dissector("echo", dissect_echo, proto_echo)
proto_reg_handoff_echo(): dissector_add_uint_with_preference("tcp.port", 7, echo_handle)
dispatch:               dissector_try_uint("tcp.port", port, …)   # in packet-tcp.c
```

So `packet-tcp.c` "calls" `dissect_echo` only through a table keyed by an
integer at runtime. String tables too: `file-ogg.c` does
`dissector_add_string("media_type", "audio/ogg", ogg_handle)`, dispatched
from `packet-sip.c`/`packet-http2.c` via `dissector_try_string_with_data`.
Registration functions are discovered by **regex scan** (`tools/make-regs.py`)
over the CMake source manifest — file lists are semantics. And ~130
dissectors are *generated* (ASN.1 via `asn2wrs.py`: `asn1/cmp/CMP.asn` +
`cmp.cnf` + templates → checked-in `epan/dissectors/packet-cmp.c`; PIDL →
`packet-dcerpc-*.c`), so the corpus contains outputs that can drift from
their inputs.

### B.2 Profile vocabulary

```yaml
nodes:
  - { kind: Dissector,      identity: [name] }            # logical: "echo", "ogg"
  - { kind: DissectorTable, identity: [tableName] }       # "tcp.port", "media_type"
  - { kind: Function,       identity: [tu, name] }
  - { kind: Protocol,       identity: [abbrev] }
edges:
  - { kind: REGISTERS_HANDLE }                            # Function → Dissector
  - { kind: CONTRIBUTES,   identity: [key] }              # Dissector → Table, keyed
  - { kind: DISPATCHES_VIA }                              # Function → Table
  - { kind: LOOKS_UP }                                    # find_dissector by name
  - { kind: CALLS }                                       # direct C calls
  - { kind: GENERATED_FROM }                              # packet-cmp.c → CMP.asn, cmp.cnf
```

### B.3 Extraction pipeline

```ts
// 1. Build metadata first: CMake source manifests + compile_commands.json
const cc = await memo("compdb", [/* configure step */], () =>
  run("cmake", ["-DCMAKE_EXPORT_COMPILE_COMMANDS=ON", …], cmakeInputs));
const asn1 = await memo("asn1-manifest", [asn1CMake], () =>
  parseCMakeLists(corpus.read("epan/dissectors/asn1/CMakeLists.txt")));  // ~130 protocol dirs
emit(generatedFromFacts(asn1));   // packet-cmp.c ← {CMP.asn, cmp.cnf, packet-cmp-template.c}

// 2. Per-TU parsing with assembled closures (headers + flags from compdb)
for (const tu of cc.units)
  await memo(`c:${tu.file}`, [tu.file, ...tu.headers], async () =>
    emit(transcribeClangAst(await run("clang", ["-ast-dump=json", ...tu.flags], tu.closure))));
    // binding-observed: register_dissector("echo", dissect_echo, …)
    // binding-observed: dissector_add_uint("tcp.port", 7, echo_handle)
    // call-observed:    dissector_try_uint("tcp.port", <expr>)  dispatch: table
    // reference-observed: find_dissector("json")
```

The `make-regs.py` convention costs nothing extra: `proto_register_*` /
`proto_reg_handoff_*` are just function definitions the AST already shows;
one pipeline predicate tags them, mirroring what the build's regex does.

### B.4 Resolve

| Resolver | Primitive | What it does |
|---|---|---|
| `handle-identity` | P0 | `register_dissector` facts → Dissector nodes + REGISTERS_HANDLE |
| `table-join` | P1 | `dissector_add_*` ↔ `register_dissector_table` → CONTRIBUTES edges, identity `(key)` — hundreds of contributors to `tcp.port` stay distinct edges |
| `lookup-join` | P1 | `find_dissector("json")` → LOOKS_UP edge to Dissector `json` |
| `dispatch-fan` | P1 | `dissector_try_uint("tcp.port", …)` → DISPATCHES_VIA edge to the table (the fan-out to contributors is a *query*, not materialized edges) |
| `handle-flow` | P3 | handles cached in handoff functions and passed around: bounded constant propagation before claiming |
| `codegen-lineage` | P0 | manifest facts → GENERATED_FROM edges |
| `gen-staleness` | builtin | hash `packet-cmp.c` inputs vs output; **drifted generated files become claims** |

Two design decisions earn their keep here:

- **Edge identity tuples**: `CONTRIBUTES(table=tcp.port, key=7)` and
  `CONTRIBUTES(table=tcp.port, key=119)` are different edges. Without
  identity props they'd silently merge and the port map would be garbage.
- **Fan-out as query, not edges**: `packet-tcp.c → tcp.port` table has one
  DISPATCHES_VIA edge; "who can TCP hand off to?" traverses
  table→CONTRIBUTES at query time. Materializing dissector×port cross
  products would bloat the graph for zero information.

Claims surface exactly the true unknowns: table names built with macros,
preference-overridden ports (`dissector_add_uint_with_preference` means the
user can rebind port 7 at runtime — the edge carries that as a prop), keys
computed from packet content.

### B.5 Project

For a "carve dissectors into plugins" or decommission study: the
Dissector/Table graph *is* the module graph — tables are the natural seams
(they already decouple contributors from dispatchers), LOOKS_UP edges are
the hard dependencies, and GENERATED_FROM lineage says which "sources" are
actually artifacts of ASN.1 inputs (port the `.asn` + `.cnf`, not the 40k
generated lines). The staleness survey ("generated outputs whose inputs
changed since generation") is an audit Wireshark itself would value.

### B.6 Kernel verdict

No engine change. The exotic parts — regex-discovered registration,
build-manifest-driven codegen, table dispatch — became: one pipeline
predicate, one manifest parser, three P1 resolvers, and vocabulary.

---

## What the exercise proved (and one thing it sharpened)

1. **The string-dispatch story holds.** Both repos route their real call
   graphs through strings (service names, table keys). P1 binding joins +
   P3 constant propagation + claims covered both without new mechanics.
2. **User-owned filtering was load-bearing, not aesthetic.** "Only
   resources registered in ofbiz-component.xml are live" and "only files in
   the CMake manifest register dissectors" are exactly the filtering
   policies that must not live in an engine.
3. **Edge identity tuples and claims did the anti-garbage work.** Keyed
   table contributions and dynamic dispatch sites are where naive graphs
   silently lie; ours either keys the edge or files a claim.
4. **Sharpened, not changed**: dispatch *fan-out* should stay a query over
   table topology rather than materialized edges — worth stating as
   guidance in resolver-kit.md (a P1 anti-pattern note), but it required no
   kernel or SDK change.
