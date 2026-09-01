/* global Cosmos */

const palette = ["#9b87f5", "#42b7ff", "#45d3a1", "#ffb454", "#f06fa9", "#7bdff2", "#c6e970", "#ff7b72"];
const edgePalette = ["#7d70ba", "#3f7fa7", "#3b8d74", "#a8783c", "#9d5074", "#548c97"];

const el = (id) => document.getElementById(id);
const dom = {
  graph: el("graph"), title: el("title"), revision: el("revision"), search: el("search"),
  refresh: el("refresh"), fit: el("fit"), empty: el("empty"), emptyTitle: el("empty-title"),
  emptyCopy: el("empty-copy"), emptyCommand: el("empty-command"), nodeKinds: el("node-kinds"),
  edgeKinds: el("edge-kinds"), nodesAll: el("nodes-all"), edgesAll: el("edges-all"),
  nodeCount: el("node-count"), edgeCount: el("edge-count"), factCount: el("fact-count"),
  inspector: el("inspector"), detailKind: el("detail-kind"), detailTitle: el("detail-title"),
  detailBody: el("detail-body"), closeInspector: el("close-inspector"), tooltip: el("tooltip"),
};

let payload;
let graph;
let renderedNodes = [];
let renderedEdges = [];
let firstLoad = true;
let fallbackMode = false;
const hiddenNodes = new Set();
const hiddenEdges = new Set();

function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}

function styleFor(kind, type) {
  const configured = payload?.config?.[type]?.[kind] || {};
  const colors = type === "nodes" ? palette : edgePalette;
  return { color: configured.color || colors[hash(kind) % colors.length], ...configured };
}

function rgba(hex, alpha = 1) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || "");
  if (!match) return [0.6, 0.53, 0.96, alpha];
  const value = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255).concat(alpha);
}

function formatNumber(value) { return new Intl.NumberFormat().format(value || 0); }

function entriesByKind(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderFilterList(container, entries, type, hidden) {
  container.replaceChildren();
  for (const [kind, count] of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `filter-row ${type === "edges" ? "edge" : ""}${hidden.has(kind) ? " off" : ""}`;
    button.setAttribute("aria-pressed", String(!hidden.has(kind)));
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.setProperty("--swatch", styleFor(kind, type).color);
    const name = document.createElement("span");
    name.className = "filter-name";
    name.textContent = kind;
    const total = document.createElement("span");
    total.className = "filter-count";
    total.textContent = formatNumber(count);
    button.append(swatch, name, total);
    button.addEventListener("click", () => {
      hidden.has(kind) ? hidden.delete(kind) : hidden.add(kind);
      renderControls();
      draw();
    });
    container.append(button);
  }
}

function renderControls() {
  if (!payload) return;
  renderFilterList(dom.nodeKinds, entriesByKind(payload.nodes), "nodes", hiddenNodes);
  renderFilterList(dom.edgeKinds, entriesByKind(payload.edges), "edges", hiddenEdges);
  dom.nodeCount.textContent = formatNumber(payload.stats.nodes);
  dom.edgeCount.textContent = formatNumber(payload.stats.edges);
  dom.factCount.textContent = formatNumber(payload.stats.facts);
  dom.revision.textContent = `revision ${payload.revision}`;
}

function seededPosition(node, index, kindIndex, kindCount) {
  const seed = hash(node.id);
  const centerAngle = (kindIndex / Math.max(1, kindCount)) * Math.PI * 2;
  const centerRadius = kindCount > 1 ? 310 : 0;
  const angle = ((seed % 10000) / 10000) * Math.PI * 2;
  const radius = 35 + ((seed >>> 8) % 170);
  return [
    Math.cos(centerAngle) * centerRadius + Math.cos(angle) * radius + (index % 3),
    Math.sin(centerAngle) * centerRadius + Math.sin(angle) * radius + (index % 5),
  ];
}

function destroyGraph() {
  if (graph) {
    try { graph.destroy(); } catch { /* A failed WebGL initialization has nothing to destroy. */ }
  }
  graph = undefined;
  fallbackMode = false;
  dom.graph.replaceChildren();
}

function svgElement(name, attrs = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function hasHardwareWebGL() {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2");
  if (!context) return false;
  const debug = context.getExtension("WEBGL_debug_renderer_info");
  const renderer = debug ? String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "";
  return !/swiftshader|software/i.test(renderer);
}

function drawFallback(nodeKinds) {
  destroyGraph();
  fallbackMode = true;
  const bounds = dom.graph.getBoundingClientRect();
  const width = Math.max(600, bounds.width);
  const height = Math.max(420, bounds.height);
  const svg = svgElement("svg", { class: "fallback-graph", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Knowledge graph" });
  const defs = svgElement("defs");
  const marker = svgElement("marker", { id: "edge-arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 9, markerHeight: 9, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" });
  marker.append(svgElement("path", { d: "M 0 0 L 8 4 L 0 8 z", fill: "#8e86aa" }));
  defs.append(marker);
  svg.append(defs);

  const byKind = new Map(nodeKinds.map((kind) => [kind, renderedNodes.filter((node) => node.kind === kind)]));
  const positions = new Map();
  const clusterRadius = nodeKinds.length > 1 ? Math.min(width, height) * 0.27 : 0;
  nodeKinds.forEach((kind, kindIndex) => {
    const nodes = byKind.get(kind);
    const centerAngle = (kindIndex / Math.max(1, nodeKinds.length)) * Math.PI * 2 - Math.PI / 2;
    const centerX = width / 2 + Math.cos(centerAngle) * clusterRadius;
    const centerY = height / 2 + Math.sin(centerAngle) * clusterRadius;
    nodes.forEach((node, index) => {
      const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2 + (hash(node.id) % 100) / 100;
      const radius = nodes.length > 1 ? 48 + (index % 2) * 18 : 0;
      positions.set(node.id, { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius });
    });
  });

  const edgesLayer = svgElement("g", { class: "fallback-edges" });
  for (const edge of renderedEdges) {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) continue;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const start = { x: source.x + (dx / length) * 11, y: source.y + (dy / length) * 11 };
    const end = { x: target.x - (dx / length) * 15, y: target.y - (dy / length) * 15 };
    const bend = ((hash(edge.id) % 2) * 2 - 1) * Math.min(38, length * 0.12);
    const mx = (start.x + end.x) / 2 - (dy / length) * bend;
    const my = (start.y + end.y) / 2 + (dx / length) * bend;
    const pathData = `M ${start.x} ${start.y} Q ${mx} ${my} ${end.x} ${end.y}`;
    const path = svgElement("path", {
      d: pathData,
      class: "fallback-edge",
      stroke: styleFor(edge.kind, "edges").color,
      "stroke-width": Math.max(1.2, Number(styleFor(edge.kind, "edges").width || 1) * 1.7),
      "marker-end": "url(#edge-arrow)",
    });
    path.addEventListener("click", () => showEdge(edge));
    path.addEventListener("pointerenter", (event) => showTooltip(edge, event));
    path.addEventListener("pointerleave", hideTooltip);
    const hit = svgElement("path", { d: pathData, class: "fallback-edge-hit" });
    hit.addEventListener("click", () => showEdge(edge));
    hit.addEventListener("pointerenter", (event) => showTooltip(edge, event));
    hit.addEventListener("pointerleave", hideTooltip);
    edgesLayer.append(path, hit);
  }
  svg.append(edgesLayer);

  const nodesLayer = svgElement("g", { class: "fallback-nodes" });
  renderedNodes.forEach((node, index) => {
    const position = positions.get(node.id);
    const style = styleFor(node.kind, "nodes");
    const group = svgElement("g", { class: `fallback-node${node.provenance === "stub" ? " stub" : ""}`, transform: `translate(${position.x} ${position.y})`, "data-index": index });
    group.dataset.search = `${node.kind} ${node.label} ${JSON.stringify(node.identity)} ${JSON.stringify(node.props)}`.toLocaleLowerCase();
    const halo = svgElement("circle", { class: "node-halo", r: 16 * Number(style.size || 1), fill: style.color });
    const circle = svgElement("circle", { class: "node-circle", r: 8 * Number(style.size || 1), fill: style.color });
    const label = svgElement("text", { class: "node-label", x: 13, y: 4 });
    label.textContent = node.label;
    group.append(halo, circle, label);
    group.addEventListener("click", () => showNode(node));
    group.addEventListener("pointerenter", (event) => showTooltip(node, event));
    group.addEventListener("pointerleave", hideTooltip);
    nodesLayer.append(group);
  });
  svg.append(nodesLayer);
  svg.addEventListener("click", (event) => { if (event.target === svg) closeInspector(); });
  dom.graph.append(svg);
  applySearch();
}

function draw() {
  if (!payload || !payload.nodes.length) {
    destroyGraph();
    return;
  }
  const nodeKinds = [...new Set(payload.nodes.map((node) => node.kind))].sort();
  renderedNodes = payload.nodes.filter((node) => !hiddenNodes.has(node.kind));
  const indexById = new Map(renderedNodes.map((node, index) => [node.id, index]));
  renderedEdges = payload.edges.filter((edge) =>
    !hiddenEdges.has(edge.kind) && indexById.has(edge.source) && indexById.has(edge.target));

  destroyGraph();
  if (!hasHardwareWebGL()) {
    drawFallback(nodeKinds);
    return;
  }
  graph = new Cosmos.Graph(dom.graph, {
    backgroundColor: "#08090d",
    spaceSize: 2048,
    fitViewOnInit: true,
    fitViewDelay: 650,
    fitViewPadding: 0.22,
    enableDrag: true,
    curvedLinks: true,
    linkDefaultArrows: true,
    linkArrowsSizeScale: 0.72,
    pointDefaultSize: 11,
    pointGreyoutOpacity: 0.13,
    linkGreyoutOpacity: 0.06,
    simulationGravity: 0.22,
    simulationCenter: 0.28,
    simulationRepulsion: 0.18,
    simulationLinkSpring: 0.6,
    simulationLinkDistance: 12,
    simulationFriction: 0.18,
    simulationCollision: 0.5,
    simulationCollisionPadding: 4,
    onPointClick: (index) => showNode(renderedNodes[index]),
    onLinkClick: (index) => showEdge(renderedEdges[index]),
    onBackgroundClick: closeInspector,
    onPointMouseOver: (index, _position, event) => showTooltip(renderedNodes[index], event),
    onPointMouseOut: hideTooltip,
    onLinkMouseOver: (index) => showTooltip(renderedEdges[index]),
    onLinkMouseOut: hideTooltip,
  });

  const positions = new Float32Array(renderedNodes.length * 2);
  const pointColors = new Float32Array(renderedNodes.length * 4);
  const pointSizes = new Float32Array(renderedNodes.length);
  renderedNodes.forEach((node, index) => {
    const kindIndex = nodeKinds.indexOf(node.kind);
    positions.set(seededPosition(node, index, kindIndex, nodeKinds.length), index * 2);
    pointColors.set(rgba(styleFor(node.kind, "nodes").color, node.provenance === "stub" ? 0.55 : 0.94), index * 4);
    pointSizes[index] = 10 * Number(styleFor(node.kind, "nodes").size || 1) * (node.provenance === "stub" ? 0.78 : 1);
  });
  const links = new Float32Array(renderedEdges.length * 2);
  const linkColors = new Float32Array(renderedEdges.length * 4);
  const linkWidths = new Float32Array(renderedEdges.length);
  renderedEdges.forEach((edge, index) => {
    links.set([indexById.get(edge.source), indexById.get(edge.target)], index * 2);
    linkColors.set(rgba(styleFor(edge.kind, "edges").color, 0.62 + Math.min(0.28, edge.confidence * 0.2)), index * 4);
    linkWidths[index] = Math.max(0.7, Number(styleFor(edge.kind, "edges").width || 1) * (1 + edge.confidence * 0.55));
  });
  graph.setPointPositions(positions);
  graph.setPointColors(pointColors);
  graph.setPointSizes(pointSizes);
  graph.setLinks(links);
  graph.setLinkColors(linkColors);
  graph.setLinkWidths(linkWidths);
  graph.render();
  const currentGraph = graph;
  currentGraph.ready.then(() => setTimeout(() => {
    if (graph === currentGraph) currentGraph.fitView(700, 0.28);
  }, 900)).catch(() => {
    if (graph === currentGraph) drawFallback(nodeKinds);
  });
  applySearch();
}

function propertySection(title, value) {
  const section = document.createElement("section");
  section.className = "detail-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);
  const entries = Object.entries(value || {});
  if (!entries.length) {
    const badge = document.createElement("span");
    badge.className = "detail-badge";
    badge.textContent = "None";
    section.append(badge);
    return section;
  }
  const list = document.createElement("dl");
  list.className = "property-list";
  for (const [key, raw] of entries) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = key;
    detail.textContent = typeof raw === "string" ? raw : JSON.stringify(raw);
    row.append(term, detail);
    list.append(row);
  }
  section.append(list);
  return section;
}

function showNode(node) {
  if (!node) return;
  dom.detailKind.textContent = `${node.kind} · ${node.provenance}`;
  dom.detailTitle.textContent = node.label;
  dom.detailBody.replaceChildren(propertySection("Identity", node.identity), propertySection("Properties", node.props));
  dom.inspector.hidden = false;
}

function showEdge(edge) {
  if (!edge) return;
  const source = payload.nodes.find((node) => node.id === edge.source);
  const target = payload.nodes.find((node) => node.id === edge.target);
  dom.detailKind.textContent = "Relationship";
  dom.detailTitle.textContent = edge.kind;
  dom.detailBody.replaceChildren(
    propertySection("Endpoints", { from: source?.label || edge.source, to: target?.label || edge.target }),
    propertySection("Evidence", { confidence: edge.confidence, count: edge.evidenceCount }),
    propertySection("Identity", edge.identity),
    propertySection("Properties", edge.props),
  );
  dom.inspector.hidden = false;
}

function closeInspector() { dom.inspector.hidden = true; }

function showTooltip(item, event) {
  if (!item) return;
  dom.tooltip.textContent = item.label ? `${item.kind} · ${item.label}` : item.kind;
  const x = event?.clientX ?? window.innerWidth / 2;
  const y = event?.clientY ?? window.innerHeight / 2;
  dom.tooltip.style.left = `${x}px`;
  dom.tooltip.style.top = `${y}px`;
  dom.tooltip.hidden = false;
}

function hideTooltip() { dom.tooltip.hidden = true; }

function applySearch() {
  const query = dom.search.value.trim().toLocaleLowerCase();
  if (fallbackMode) {
    for (const node of dom.graph.querySelectorAll(".fallback-node")) {
      const match = !query || node.dataset.search.includes(query);
      node.classList.toggle("search-dim", Boolean(query) && !match);
      node.classList.toggle("search-match", Boolean(query) && match);
    }
    return;
  }
  if (!graph) return;
  const matches = query ? renderedNodes.flatMap((node, index) =>
    `${node.kind} ${node.label} ${JSON.stringify(node.identity)} ${JSON.stringify(node.props)}`.toLocaleLowerCase().includes(query) ? [index] : []) : [];
  graph.setConfigPartial({
    highlightedPointIndices: matches,
    outlinedPointIndices: matches,
  });
  if (matches.length === 1) graph.zoomToPointByIndex(matches[0], 1.8, 500);
}

function setEmptyState() {
  const empty = !payload.initialized || payload.nodes.length === 0;
  dom.empty.hidden = !empty;
  dom.graph.style.opacity = empty ? "0" : "1";
  if (!empty) return;
  if (!payload.initialized) {
    dom.emptyTitle.textContent = "Initialize the graph";
    dom.emptyCopy.textContent = "Build the profile, then extract and resolve the repository.";
    dom.emptyCommand.textContent = "trestle profile build";
  } else {
    dom.emptyTitle.textContent = "No resolved nodes yet";
    dom.emptyCopy.textContent = "The profile is ready. Extract facts and run the resolvers to populate this view.";
    dom.emptyCommand.textContent = "trestle extract && trestle resolve";
  }
}

async function refresh() {
  dom.refresh.classList.add("loading");
  dom.refresh.disabled = true;
  try {
    const response = await fetch("/api/graph", { cache: "no-store" });
    if (!response.ok) throw new Error(`Graph request failed (${response.status})`);
    payload = await response.json();
    document.title = payload.config.title || "Trestle Graph";
    dom.title.textContent = payload.config.title || "Knowledge graph";
    if (firstLoad) {
      for (const [kind, style] of Object.entries(payload.config.nodes || {})) if (style.hidden) hiddenNodes.add(kind);
      for (const [kind, style] of Object.entries(payload.config.edges || {})) if (style.hidden) hiddenEdges.add(kind);
      firstLoad = false;
    }
    renderControls();
    setEmptyState();
    draw();
  } catch (error) {
    dom.empty.hidden = false;
    dom.emptyTitle.textContent = "Unable to load graph";
    dom.emptyCopy.textContent = error instanceof Error ? error.message : String(error);
    dom.emptyCommand.textContent = "amp orb service logs trestle";
  } finally {
    dom.refresh.classList.remove("loading");
    dom.refresh.disabled = false;
  }
}

dom.refresh.addEventListener("click", refresh);
dom.fit.addEventListener("click", () => graph?.fitView(600, 0.22));
dom.search.addEventListener("input", applySearch);
dom.closeInspector.addEventListener("click", closeInspector);
dom.nodesAll.addEventListener("click", () => { hiddenNodes.clear(); renderControls(); draw(); });
dom.edgesAll.addEventListener("click", () => { hiddenEdges.clear(); renderControls(); draw(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== dom.search) { event.preventDefault(); dom.search.focus(); }
  if (event.key === "Escape") { dom.search.blur(); closeInspector(); }
});

refresh();
