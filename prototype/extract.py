#!/usr/bin/env python3
"""Trestle extraction pipeline prototype for OFBiz.

Follows EXTRACT-RESOLVE.md contracts: emits facts (never graph entities),
component manifests parsed first (filtering is pipeline code), every fact
carries the envelope {kind, sourcePath, locator, confidence, props}.
"""
import json, re, sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "corpora" / "ofbiz-framework"
OUT = Path(__file__).resolve().parent / "out"
OUT.mkdir(exist_ok=True)

FACTS = []

def emit(kind, source, props, line=None, confidence=1.0):
    FACTS.append({
        "kind": kind, "version": 1,
        "sourcePath": str(source.relative_to(ROOT)),
        "locator": {"type": "lines", "startLine": line} if line else {"type": "file"},
        "confidence": confidence, "props": props,
    })

def component_of(path: Path) -> str:
    rel = path.relative_to(ROOT).parts
    if rel[0] in ("applications", "framework", "themes", "plugins") and len(rel) > 1:
        return f"{rel[0]}/{rel[1]}"
    return rel[0]

# ---------------------------------------------------------------- round 1:
# component manifests define what is LIVE (the filtering rule)
manifests = sorted(ROOT.glob("*/*/ofbiz-component.xml"))
registered = {"service_model": [], "service_eca": [], "entity_model": [], "webapps": []}
for m in manifests:
    try:
        tree = ET.parse(m)
    except ET.ParseError as e:
        print(f"diag: unparseable manifest {m}: {e}", file=sys.stderr); continue
    comp_dir = m.parent
    comp = component_of(m)
    emit("unit-defined", m, {"unitKind": "Component", "name": comp})
    for sr in tree.findall(".//service-resource"):
        loc = comp_dir / sr.get("location", "")
        if not loc.exists():
            emit("diagnostic-observed", m, {"missing": sr.get("location"), "type": sr.get("type")})
            continue
        if sr.get("type") == "model": registered["service_model"].append((loc, comp))
        elif sr.get("type") == "eca": registered["service_eca"].append((loc, comp))
    for er in tree.findall(".//entity-resource"):
        loc = comp_dir / er.get("location", "")
        if er.get("type") == "model" and loc.exists():
            registered["entity_model"].append((loc, comp))
    for wa in tree.findall(".//webapp"):
        ctl = comp_dir / wa.get("location", "") / "WEB-INF" / "controller.xml"
        if ctl.exists(): registered["webapps"].append((ctl, comp, wa.get("name")))

# ---------------------------------------------------------------- round 2:
# registered XML resources → definition facts
for f, comp in registered["service_model"]:
    try: tree = ET.parse(f)
    except ET.ParseError: continue
    for s in tree.getroot().iter("service"):
        emit("unit-defined", f, {
            "unitKind": "Service", "name": s.get("name"), "component": comp,
            "engine": s.get("engine"), "location": s.get("location"),
            "invoke": s.get("invoke"), "defaultEntityName": s.get("default-entity-name"),
            "implements": [i.get("service") for i in s.findall("implements")],
        })

for f, comp in registered["entity_model"]:
    try: tree = ET.parse(f)
    except ET.ParseError: continue
    for tag, kind in (("entity", "Entity"), ("view-entity", "ViewEntity")):
        for e in tree.getroot().iter(tag):
            props = {"unitKind": kind, "name": e.get("entity-name"), "component": comp,
                     "package": e.get("package-name")}
            if kind == "ViewEntity":
                props["memberEntities"] = sorted({me.get("entity-name") for me in e.iter("member-entity")})
            emit("unit-defined", f, props)

for f, comp in registered["service_eca"]:
    try: tree = ET.parse(f)
    except ET.ParseError: continue
    for eca in tree.getroot().iter("eca"):
        for a in eca.iter("action"):
            emit("binding-observed", f, {
                "scope": "seca", "source": eca.get("service"), "event": eca.get("event"),
                "target": a.get("service"), "mode": a.get("mode", "sync"), "component": comp})

for f, comp, webapp in registered["webapps"]:
    try: tree = ET.parse(f)
    except ET.ParseError: continue
    for rm in tree.getroot().iter("request-map"):
        ev = rm.find("event")
        if ev is None: continue
        emit("execution-observed", f, {
            "trigger": f"request-map:{webapp}:{rm.get('uri')}", "component": comp,
            "type": ev.get("type"), "invokes": ev.get("invoke"), "path": ev.get("path")})

# ---------------------------------------------------------------- round 3:
# dispatch + entity-access sites in Java/Groovy (first-hand source facts)
RUN = re.compile(r'\.(runSync|runAsync|runSyncIgnore|runAsyncWait|schedule)\s*\(\s*(")?([^",)]*)')
DELEGATOR = re.compile(
    r'delegator\.(create|findOne|findByAnd|findList|find|findAll|findCountByCondition|'
    r'removeByAnd|removeValue|removeByCondition|store|storeAll)\s*\(\s*"([A-Za-z0-9]+)"')
EQ_FROM = re.compile(r'EntityQuery\.use\([^)]*\)\s*\.from\(\s*"([A-Za-z0-9]+)"')
WRITE_OPS = {"create", "removeByAnd", "removeValue", "removeByCondition", "store", "storeAll"}

for src in list(ROOT.rglob("*.java")) + list(ROOT.rglob("*.groovy")):
    comp = component_of(src)
    try: text = src.read_text(errors="replace")
    except OSError: continue
    for i, line in enumerate(text.splitlines(), 1):
        for m in RUN.finditer(line):
            lit = m.group(3) if m.group(2) else None
            emit("call-observed", src, {
                "callee": f"LocalDispatcher.{m.group(1)}", "dispatch": "dynamic-string",
                "argLiteral": lit, "argExpr": None if lit else m.group(3), "component": comp}, i)
        for m in DELEGATOR.finditer(line):
            emit("data-access-observed", src, {
                "target": m.group(2), "via": f"Delegator.{m.group(1)}",
                "op": "write" if m.group(1) in WRITE_OPS else "read", "component": comp}, i)
        for m in EQ_FROM.finditer(line):
            emit("data-access-observed", src, {
                "target": m.group(1), "via": "EntityQuery.from", "op": "read", "component": comp}, i)

# MiniLang XML: <call-service service-name=…>, entity ops
for f, comp in registered["service_model"]:  # minilang lives next to components; scan whole comp dirs once
    pass
seen_ml = set()
for src in ROOT.rglob("minilang/**/*.xml"):
    if src in seen_ml: continue
    seen_ml.add(src); comp = component_of(src)
    text = src.read_text(errors="replace")
    for i, line in enumerate(text.splitlines(), 1):
        for m in re.finditer(r'<call-service\s+[^>]*service-name="([^"$]+)"', line):
            emit("call-observed", src, {"callee": "minilang.call-service", "dispatch": "declarative",
                                        "argLiteral": m.group(1), "component": comp}, i)
        for m in re.finditer(r'<(entity-one|entity-and|entity-condition|find-by-primary-key|make-value)\s+[^>]*entity-name="([^"$]+)"', line):
            emit("data-access-observed", src, {"target": m.group(2), "via": f"minilang.{m.group(1)}",
                                               "op": "read", "component": comp}, i)
        for m in re.finditer(r'<(create-value|store-value|remove-value|remove-by-and)\b', line):
            emit("data-access-observed", src, {"target": None, "via": f"minilang.{m.group(1)}",
                                               "op": "write", "component": comp}, i)

with open(OUT / "facts.jsonl", "w") as fh:
    for f in FACTS: fh.write(json.dumps(f) + "\n")

from collections import Counter
print(f"components scanned: {len(manifests)}")
print(f"registered: {len(registered['service_model'])} servicedef, "
      f"{len(registered['entity_model'])} entitydef, {len(registered['service_eca'])} seca, "
      f"{len(registered['webapps'])} controllers")
for k, n in sorted(Counter(f["kind"] for f in FACTS).items()): print(f"{k:26s} {n:7d}")
print(f"TOTAL facts: {len(FACTS)}")
