#!/usr/bin/env python3
"""Trestle resolve-stage prototype for OFBiz.

Consumes out/facts.jsonl, runs resolvers (P0 fact-mapping, P1 binding joins,
P5 component lift), emits out/directives.jsonl, applies them into
out/graph.json, prints the survey (P7).
Directives follow EXTRACT-RESOLVE.md §2.1: node/edge/claim, auto-vivified
stub endpoints, provenance on every directive, edge identity tuples.
"""
import json
from collections import Counter, defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent / "out"
facts = [json.loads(l) for l in open(OUT / "facts.jsonl")]
by_kind = defaultdict(list)
for f in facts: by_kind[f["kind"]].append(f)

DIRECTIVES = []
def emit(op, resolver, rule, **kw):
    DIRECTIVES.append({"op": op, "provenance": {"resolver": resolver, "rule": rule}, **kw})

def ev(f):  # evidence record from a fact
    return {"sourcePath": f["sourcePath"], "locator": f["locator"], "confidence": f["confidence"]}

# ---- P0: service-identity / entity-identity --------------------------------
services, entities = {}, {}
for f in by_kind["unit-defined"]:
    p = f["props"]; uk = p["unitKind"]
    if uk == "Service":
        services[p["name"]] = p
        emit("node", "service-identity", "svc-def", kind="Service", id=f"Service:{p['name']}",
             props={k: p[k] for k in ("component", "engine") if p.get(k)}, evidence=ev(f))
    elif uk in ("Entity", "ViewEntity"):
        entities[p["name"]] = p
        emit("node", "entity-identity", "ent-def", kind=uk, id=f"{uk}:{p['name']}",
             props={"component": p["component"]}, evidence=ev(f))
    elif uk == "Component":
        emit("node", "component-identity", "comp-def", kind="Component",
             id=f"Component:{p['name']}", props={}, evidence=ev(f))

# ---- P1: service-impl -------------------------------------------------------
for f in by_kind["unit-defined"]:
    p = f["props"]
    if p["unitKind"] != "Service": continue
    sid = f"Service:{p['name']}"
    for iface in p.get("implements") or []:
        emit("edge", "service-impl", "implements", kind="IMPLEMENTS_IFACE",
             frm=sid, to=f"Service:{iface}", evidence=ev(f))
    eng = p.get("engine")
    if eng == "java" and p.get("location") and p.get("invoke"):
        emit("edge", "service-impl", "java-impl", kind="IMPLEMENTED_BY",
             frm=sid, to=f"Method:{p['location']}#{p['invoke']}", evidence=ev(f))
    elif eng in ("groovy", "script", "simple") and p.get("location"):
        emit("edge", "service-impl", "script-impl", kind="IMPLEMENTED_BY",
             frm=sid, to=f"Script:{p['location']}#{p.get('invoke') or ''}", evidence=ev(f))
    elif eng == "entity-auto" and p.get("defaultEntityName"):
        op = {"create": "write", "update": "write", "delete": "write", "expire": "write"}.get(p.get("invoke"), "write")
        emit("edge", "service-impl", "entity-auto", kind="ENTITY_ACCESS", identity={"op": op},
             frm=sid, to=f"Entity:{p['defaultEntityName']}", evidence=ev(f))

# ---- P3-lite: bounded constant propagation for computed dispatch args ------
# (prototype shortcut: re-reads source here; real design emits assignment facts)
CORPUS = Path(__file__).resolve().parent.parent / "corpora" / "ofbiz-framework"
import re
def propagate(source_path, var):
    """Return the bounded may-set of literals assigned to var in this file (≤3), else None."""
    if not var or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", var): return None
    try: text = (CORPUS / source_path).read_text(errors="replace")
    except OSError: return None
    lits = set(re.findall(rf'\b{re.escape(var)}\s*=\s*"([^"]+)"', text))
    return lits if 1 <= len(lits) <= 3 else None

# ---- P1: dispatch-join (with claims for the honest unknowns) ---------------
stats = Counter()
for f in by_kind["call-observed"]:
    p = f["props"]; lit = p.get("argLiteral")
    caller = f"Component:{p['component']}"
    if not lit or "${" in lit:
        prop = propagate(f["sourcePath"], p.get("argExpr"))
        cands = [c for c in (prop or []) if c in services]
        if cands:
            stats["const-prop"] += 1
            conf = round(1.0 / len(cands), 2)
            for c in cands:
                emit("edge", "dispatch-join", "const-prop", kind="INVOKES_SERVICE",
                     identity={"site": f"{f['sourcePath']}:{f['locator'].get('startLine')}", "may": c},
                     frm=caller, to=f"Service:{c}",
                     evidence={**ev(f), "confidence": conf,
                               "note": f"may-set of {p.get('argExpr')}: {sorted(cands)}"})
            continue
        scope = "framework" if f["sourcePath"].startswith("framework/") else "application"
        stats[f"dynamic-{scope}"] += 1
        emit("claim", "dispatch-join", "dynamic-dispatch", kind=f"unresolved-dynamic-dispatch-{scope}",
             about=[f"Artifact:{f['sourcePath']}"], detail=f"line {f['locator'].get('startLine')}: "
             f"{p['callee']} arg is computed ({p.get('argExpr') or lit})", evidence=ev(f))
    elif lit in services:
        stats["resolved"] += 1
        emit("edge", "dispatch-join", "literal", kind="INVOKES_SERVICE",
             identity={"site": f"{f['sourcePath']}:{f['locator'].get('startLine')}"},
             frm=caller, to=f"Service:{lit}", evidence=ev(f))
    else:
        stats["unknown-name"] += 1
        emit("claim", "dispatch-join", "unknown-service", kind="unknown-service-name",
             about=[f"Artifact:{f['sourcePath']}"], detail=f"'{lit}' not defined in any registered servicedef",
             evidence=ev(f))

# ---- P1: entity-join --------------------------------------------------------
estats = Counter()
for f in by_kind["data-access-observed"]:
    p = f["props"]; t = p.get("target")
    if not t or "${" in str(t):
        estats["dynamic"] += 1; continue
    kind = "Entity" if t in entities and entities[t]["unitKind"] == "Entity" else \
           "ViewEntity" if t in entities else None
    if kind:
        estats["resolved"] += 1
        emit("edge", "entity-join", "literal", kind="ENTITY_ACCESS", identity={"op": p["op"]},
             frm=f"Component:{p['component']}", to=f"{kind}:{t}", evidence=ev(f))
    else:
        estats["unknown"] += 1
        emit("claim", "entity-join", "unknown-entity", kind="unknown-entity-name",
             about=[f"Artifact:{f['sourcePath']}"], detail=f"'{t}' not in registered entity models", evidence=ev(f))

# ---- P1: controller-join / seca-join ---------------------------------------
for f in by_kind["execution-observed"]:
    p = f["props"]
    if p["type"] == "service" and p.get("invokes"):
        to = f"Service:{p['invokes']}" if p["invokes"] in services else None
        if to: emit("edge", "controller-join", "route-svc", kind="ROUTES_TO",
                    frm=f"RequestMap:{p['trigger']}", to=to, evidence=ev(f))
        else:  emit("claim", "controller-join", "unknown-route", kind="unknown-service-name",
                    about=[f"RequestMap:{p['trigger']}"], detail=f"'{p['invokes']}'", evidence=ev(f))
    elif p["type"] == "java" and p.get("path"):
        emit("edge", "controller-join", "route-java", kind="ROUTES_TO",
             frm=f"RequestMap:{p['trigger']}", to=f"Method:{p['path']}#{p['invokes']}", evidence=ev(f))

for f in by_kind["binding-observed"]:
    p = f["props"]
    if p.get("scope") != "seca": continue
    emit("edge", "seca-join", "eca-action", kind="TRIGGERS",
         identity={"event": p["event"], "mode": p["mode"]},
         frm=f"Service:{p['source']}", to=f"Service:{p['target']}", evidence=ev(f))

# ---- apply directives (bulk, auto-vivify stubs) ------------------------------
nodes, edges, claims = {}, {}, []
for d in DIRECTIVES:
    if d["op"] == "node":
        n = nodes.setdefault(d["id"], {"kind": d["kind"], "props": {}, "provenance": "declared", "evidence": 0})
        n["props"].update(d.get("props", {})); n["provenance"] = "declared"; n["evidence"] += 1
    elif d["op"] == "edge":
        for end in (d["frm"], d["to"]):
            if end not in nodes:
                nodes[end] = {"kind": end.split(":", 1)[0], "props": {}, "provenance": "stub", "evidence": 0}
        key = (d["kind"], d["frm"], d["to"], json.dumps(d.get("identity", {}), sort_keys=True))
        e = edges.setdefault(key, {"evidence": 0, "provenance": d["provenance"]})
        e["evidence"] += 1
    elif d["op"] == "claim":
        claims.append(d)

# ---- P5: component lift ------------------------------------------------------
inv = Counter(); ent_writes = defaultdict(set)
svc_comp = {f"Service:{n}": p["component"] for n, p in services.items()}
for (kind, frm, to, ident), e in edges.items():
    if kind == "INVOKES_SERVICE" and to in nodes and nodes[to]["props"].get("component"):
        cfrom = frm.split(":", 1)[1]; cto = nodes[to]["props"]["component"]
        if cfrom != cto: inv[(cfrom, cto)] += 1
    if kind == "ENTITY_ACCESS" and json.loads(ident).get("op") == "write":
        # attribute writes to a component: direct, or via the owning service (entity-auto)
        comp = frm.split(":", 1)[1] if frm.startswith("Component:") else svc_comp.get(frm)
        if comp: ent_writes[to].add(comp)

with open(OUT / "directives.jsonl", "w") as fh:
    for d in DIRECTIVES: fh.write(json.dumps(d) + "\n")
json.dump({"nodes": len(nodes), "edges": len(edges), "claims": len(claims)}, open(OUT / "graph.json", "w"))

# ---- survey (P7) -------------------------------------------------------------
print("=== graph ===")
print(f"nodes: {len(nodes)} ({Counter(n['kind'] for n in nodes.values()).most_common(8)})")
stubs = [i for i, n in nodes.items() if n["provenance"] == "stub" and n["kind"] == "Service"]
print(f"edges: {len(edges)} ({Counter(k[0] for k in edges).most_common()})")
print(f"claims: {len(claims)} ({Counter(c['kind'] for c in claims).most_common()})")
print(f"stub Service nodes (referenced, never defined): {len(stubs)}")
print("\n=== dispatch survey ===")
tot = sum(stats.values())
for k, v in stats.items(): print(f"  {k:14s} {v:5d}  ({100*v/tot:.0f}%)")
print("=== entity-access survey ===")
tot = sum(estats.values())
for k, v in estats.items(): print(f"  {k:14s} {v:5d}  ({100*v/tot:.0f}%)")
print("\n=== top cross-component service invocation (lifted) ===")
for (a, b), n in inv.most_common(12): print(f"  {a:32s} → {b:32s} {n:4d} call sites")
print("\n=== entities written by ≥2 components (the expensive coupling) ===")
hot = sorted(((len(cs), e, cs) for e, cs in ent_writes.items() if len(cs) >= 2), reverse=True)
for n, e, cs in hot[:15]: print(f"  {e:40s} written by {n}: {sorted(cs)}")
