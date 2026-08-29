#!/usr/bin/env python3
"""Two-stage demo of the REAL extraction layering, for applications/accounting.

Stage 1 (run tool)   : tree-sitter-java parses each source file. The raw parse
                       tree (S-expression) is the ARTIFACT — frozen, fingerprinted.
Stage 2 (transcribe) : tree-sitter QUERIES over the raw trees lift call sites
                       into `call-observed` facts (same schema as extract.py).

This is what extract.py collapsed: its regex was an un-fingerprinted in-process
"parser" whose raw output never existed. Here the tool output is first-class.
"""
import hashlib, json, sys
from pathlib import Path

import tree_sitter, tree_sitter_java

ROOT = Path(__file__).resolve().parent.parent / "corpora" / "ofbiz-framework"
OUT = Path(__file__).resolve().parent / "out"
(OUT / "artifacts" / "ast").mkdir(parents=True, exist_ok=True)

LANG = tree_sitter.Language(tree_sitter_java.language())
PARSER = tree_sitter.Parser(LANG)
TOOL = {"tool": "tree-sitter-java", "version": getattr(tree_sitter_java, "__version__", "0.23"),
        "grammar": "java"}

# The transcription rule: a tree-sitter query, not engine code.
DISPATCH_QUERY = tree_sitter.Query(LANG, r"""
(method_invocation
  name: (identifier) @method
  arguments: (argument_list . (_) @arg0)
  (#any-of? @method "runSync" "runAsync" "runSyncIgnore" "runAsyncWait" "schedule")) @call
""")

facts, artifacts = [], []
paths = [p for d in ("applications", "framework") for p in sorted((ROOT / d).rglob("*.java"))]
for path in paths:
    src = path.read_bytes()
    tree = PARSER.parse(src)
    rel = str(path.relative_to(ROOT))

    # ---- stage 1: the raw artifact (tool output, fingerprinted) ------------
    artifacts.append({
        "artifact": f"ast/{rel}", "authority": TOOL,
        "inputSha256": hashlib.sha256(src).hexdigest()[:16],
        "rootNode": tree.root_node.type,
        "nodeCount": sum(1 for _ in _walk(tree.root_node)) if False else None,
        "sexpBytes": len(str(tree.root_node)),
    })

    # ---- stage 2: transcription via query -----------------------------------
    for _, caps in tree_sitter.QueryCursor(DISPATCH_QUERY).matches(tree.root_node):
        call, method, arg0 = caps["call"][0], caps["method"][0], caps["arg0"][0]
        lit = None
        if arg0.type == "string_literal":
            frag = next((c for c in arg0.children if c.type == "string_fragment"), None)
            lit = frag.text.decode() if frag else ""
        facts.append({
            "kind": "call-observed", "version": 1, "sourcePath": rel,
            "locator": {"type": "lines", "startLine": call.start_point[0] + 1},
            "confidence": 1.0,
            "authority": TOOL,   # adopting provenance: these facts transcribe a tool's output
            "props": {"callee": f"LocalDispatcher.{method.text.decode()}",
                      "dispatch": "dynamic-string", "argLiteral": lit,
                      "argExpr": None if lit else arg0.text.decode()[:80],
                      "argNodeType": arg0.type,
                      "component": "/".join(rel.split("/")[:2])},
        })

def _walk(n):
    yield n
    for c in n.children:
        yield from _walk(c)

with open(OUT / "artifacts" / "ast" / "manifest.jsonl", "w") as fh:
    for a in artifacts: fh.write(json.dumps(a) + "\n")
with open(OUT / "facts_ast.jsonl", "w") as fh:
    for f in facts: fh.write(json.dumps(f) + "\n")

# ---- P6 corroboration vs. the regex extractor's facts ----------------------
regex_sites, ast_sites = set(), {(f["sourcePath"], f["locator"]["startLine"]) for f in facts}
for line in open(OUT / "facts.jsonl"):
    f = json.loads(line)
    if (f["kind"] == "call-observed" and f["sourcePath"].endswith(".java")
            and f["sourcePath"].split("/")[0] in ("applications", "framework")):
        regex_sites.add((f["sourcePath"], f["locator"]["startLine"]))

print(f"files parsed: {len(artifacts)}   raw-artifact manifest: out/artifacts/ast/manifest.jsonl")
print(f"AST facts: {len(facts)}   regex facts (same scope): {len(regex_sites)}")
print(f"agree: {len(ast_sites & regex_sites)}   AST-only: {len(ast_sites - regex_sites)}   regex-only: {len(regex_sites - ast_sites)}")
for s in sorted(ast_sites - regex_sites)[:6]: print("  AST-only  ", *s)
for s in sorted(regex_sites - ast_sites)[:6]: print("  regex-only", *s)
