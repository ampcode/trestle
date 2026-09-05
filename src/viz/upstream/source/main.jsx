import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import GISDK, { useContext as useGIContext } from '@antv/gi-sdk';
import * as Basic from '@antv/gi-assets-basic';
import 'antd/dist/antd.css';
import '@antv/gi-sdk/dist/index.css';
import '@antv/gi-assets-basic/dist/index.css';
import './styles.css';

/** @typedef {import('../../../server/serve.ts').VisualizationGraph} VisualizationGraph */

const PALETTE = ['#7c5cff', '#00c2ff', '#ff4ecd', '#ffb547', '#55d6a5', '#ff6b6b', '#8f9bb3', '#6fddff'];
const SERVICE_GRAPH = 'Trestle/GI_SERVICE_INTIAL_GRAPH';
const SERVICE_SCHEMA = 'Trestle/GI_SERVICE_SCHEMA';
const SERVICE_PROPERTIES = 'Trestle/PropertiesPanel';

const { components, elements, layouts } = Basic;

function AutoFit() {
  const { graph } = useGIContext();
  useEffect(() => {
    let timer;
    const afterLayout = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => graph.fitView(80), 150);
    };
    graph.on('afterlayout', afterLayout);
    return () => { window.clearTimeout(timer); graph.off('afterlayout', afterLayout); };
  }, [graph]);
  return null;
}

// gi-assets-basic's published declarations disagree with gi-sdk on asset
// metadata and registration signatures. Keep the compatibility cast here.
const assets = /** @type {import('@antv/gi-sdk').GIAssets} */ (/** @type {unknown} */ ({
  components: {
    AutoFit: { info: { id: 'AutoFit', name: 'Fit graph after layout', type: 'AUTO', category: 'canvas-interaction', icon: '' }, component: AutoFit },
    Initializer: components.Initializer,
    CanvasSetting: components.CanvasSetting,
    ActivateRelations: components.ActivateRelations,
    PropertiesPanel: components.PropertiesPanel,
    ZoomIn: components.ZoomIn,
    ZoomOut: components.ZoomOut,
    FitCenterView: components.FitCenterView,
    LassoSelect: components.LassoSelect,
    LayoutSwitch: components.LayoutSwitch,
    Export: components.Export,
    ClearCanvas: components.ClearCanvas,
    Toolbar: components.Toolbar,
    MiniMap: components.MiniMap,
    NodeLegend: components.NodeLegend,
    Tooltip: components.Tooltip,
    ShortcutKeys: components.ShortcutKeys,
  },
  elements: { SimpleNode: elements.SimpleNode, SimpleEdge: elements.SimpleEdge },
  layouts: {
    Force2: layouts.Force2,
    GraphinForce: layouts.GraphinForce,
    Concentric: layouts.Concentric,
    Dagre: layouts.Dagre,
    Grid: layouts.Grid,
    Radial: layouts.Radial,
    Circular: layouts.Circular,
    FundForce: layouts.FundForce,
  },
}));

/** @param {VisualizationGraph} snapshot */
function toGraphData(snapshot) {
  const hiddenNodes = new Set(Object.entries(snapshot.config.nodes || {}).filter(([, style]) => style.hidden).map(([kind]) => kind));
  const hiddenEdges = new Set(Object.entries(snapshot.config.edges || {}).filter(([, style]) => style.hidden).map(([kind]) => kind));
  const nodes = snapshot.nodes.filter(node => !hiddenNodes.has(node.kind)).map(node => ({
    id: node.id,
    nodeType: node.kind,
    nodeTypeKeyFromProperties: 'kind',
    data: { ...node.identity, ...node.props, label: node.label, kind: node.kind, provenance: node.provenance },
  }));
  const ids = new Set(nodes.map(node => node.id));
  const edges = snapshot.edges
    .filter(edge => !hiddenEdges.has(edge.kind) && ids.has(edge.source) && ids.has(edge.target))
    .map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      edgeType: edge.kind,
      edgeTypeKeyFromProperties: 'kind',
      data: { ...edge.identity, ...edge.props, kind: edge.kind, evidenceCount: edge.evidenceCount },
    }));
  return { nodes, edges };
}

/** @param {VisualizationGraph} snapshot @param {'nodes' | 'edges'} target */
function styleConfigs(snapshot, target) {
  const kinds = [...new Set(snapshot[target].map(item => item.kind))].sort();
  const configured = snapshot.config[target] || {};
  const isNode = target === 'nodes';
  const base = {
    id: isNode ? 'SimpleNode' : 'SimpleEdge',
    props: isNode
      ? { size: 30, color: '#5f6b85', label: ['default^^label'], advanced: { label: { fill: '#dce6ff', fontSize: 12 } } }
      : { size: 1.5, color: '#4b5875', label: ['default^^kind'] },
    expressions: [], logic: true, groupName: 'Default', order: -1,
  };
  return [base, ...kinds.filter(kind => !configured[kind]?.hidden).map((kind, index) => ({
    id: isNode ? 'SimpleNode' : 'SimpleEdge',
    props: isNode
      ? { size: 30 * (snapshot.config.nodes?.[kind]?.size || 1), color: configured[kind]?.color || PALETTE[index % PALETTE.length], label: [`${kind}^^label`], advanced: { label: { fill: '#dce6ff', fontSize: 12 } } }
      : { size: snapshot.config.edges?.[kind]?.width || 1.5, color: configured[kind]?.color || '#53617f', label: [`${kind}^^kind`] },
    expressions: [{ name: 'kind', operator: 'eql', value: kind }],
    logic: true, groupName: kind, order: index,
  }))];
}

function giac(title, icon, tooltip = title) {
  return { GI_CONTAINER_INDEX: 2, GIAC: { visible: false, disabled: false, isShowTitle: false, title, isShowIcon: true, icon, isShowTooltip: true, tooltip, tooltipColor: '#7c5cff', tooltipPlacement: 'right', hasDivider: false, height: '42px', isVertical: true } };
}

/** @param {VisualizationGraph} snapshot @returns {import('@antv/gi-sdk').GIConfig} */
function createConfig(snapshot) {
  return {
    pageLayout: undefined, // Use the SDK's default canvas layout.
    nodes: styleConfigs(snapshot, 'nodes'),
    edges: styleConfigs(snapshot, 'edges'),
    layout: { id: 'Dagre', props: { type: 'dagre', rankdir: 'LR', nodesep: 70, ranksep: 130, controlPoints: true } },
    components: [
      { id: 'Initializer', type: 'INITIALIZER', props: { serviceId: SERVICE_GRAPH, schemaServiceId: SERVICE_SCHEMA, GI_INITIALIZER: true, aggregate: false, transByFieldMapping: false } },
      { id: 'AutoFit', type: 'AUTO', props: {} },
      { id: 'CanvasSetting', type: 'AUTO', props: { styleCanvas: { backgroundColor: '#0b0d0b', backgroundImage: 'none' }, dragCanvas: { disabled: false, direction: 'both', enableOptimize: true }, zoomCanvas: { disabled: false, enableOptimize: true }, clearStatus: true, doubleClick: true } },
      { id: 'ActivateRelations', type: 'AUTO', props: { enableNodeHover: true, enableEdgeHover: true, enable: true, trigger: 'click', upstreamDegree: 1, downstreamDegree: 1 } },
      { id: 'PropertiesPanel', type: 'AUTO', props: { serviceId: SERVICE_PROPERTIES, title: 'Entity details', placement: 'RT', width: '360px', height: 'calc(100% - 48px)', offset: [12, 48], animate: true, enableInfoDetect: false, defaultiStatistic: false } },
      { id: 'MiniMap', type: 'AUTO', props: { placement: 'RB', offset: [18, 18] } },
      { id: 'NodeLegend', type: 'AUTO', props: { sortKey: 'kind', textColor: '#aab6d3', placement: 'LB', offset: [88, 20] } },
      { id: 'Tooltip', type: 'AUTO', props: { mappingKeys: ['label', 'kind', 'provenance'], placement: 'top', width: '240px', hasArrow: true } },
      { id: 'ZoomIn', type: 'GIAC', props: giac('Zoom in', 'icon-zoomin') },
      { id: 'ZoomOut', type: 'GIAC', props: giac('Zoom out', 'icon-zoomout') },
      { id: 'FitCenterView', type: 'GIAC', props: giac('Fit graph', 'icon-fit-center') },
      { id: 'LassoSelect', type: 'GIAC', props: giac('Lasso select', 'icon-lasso', 'Hold Shift and drag to select') },
      { id: 'LayoutSwitch', type: 'GIAC', props: giac('Change layout', 'icon-layout') },
      { id: 'Export', type: 'GIAC', props: giac('Export', 'icon-export', 'Export PNG, CSV, or JSON') },
      { id: 'ClearCanvas', type: 'GIAC', props: giac('Clear canvas', 'icon-delete') },
      { id: 'ShortcutKeys', type: 'GIAC', props: giac('Shortcuts', 'icon-command') },
      { id: 'Toolbar', type: 'GICC', props: { GI_CONTAINER: ['ZoomIn', 'ZoomOut', 'FitCenterView', 'LassoSelect', 'LayoutSwitch', 'Export', 'ClearCanvas', 'ShortcutKeys'], direction: 'vertical', placement: 'LT', offset: [12, 48] } },
    ],
  };
}

function App() {
  const [snapshot, setSnapshot] = useState(/** @type {VisualizationGraph | null} */ (null));
  const [error, setError] = useState('');
  useEffect(() => {
    fetch('/api/graph').then(async response => {
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }).then(data => { document.title = data.config.title || 'Knowledge graph'; setSnapshot(data); }).catch(err => setError(String(err)));
  }, []);
  const graphData = useMemo(() => snapshot ? toGraphData(snapshot) : null, [snapshot]);
  const config = useMemo(() => snapshot ? createConfig(snapshot) : null, [snapshot]);
  const services = useMemo(/** @returns {import('@antv/gi-sdk').GIService[]} */ () => graphData ? [
    { id: SERVICE_GRAPH, name: 'Trestle graph', method: 'GET', service: async () => graphData },
    { id: SERVICE_SCHEMA, name: 'Trestle schema', method: 'GET', service: async () => null },
    { id: SERVICE_PROPERTIES, name: 'Trestle entity details', method: 'GET', service: async model => model },
  ] : [], [graphData]);

  if (error) return <main className="state"><strong>Could not load the Trestle graph</strong><code>{error}</code></main>;
  if (!snapshot) return <main className="state"><span className="pulse" />Loading knowledge graph…</main>;
  if (!snapshot.initialized) return <main className="state"><strong>{snapshot.config.title || 'Knowledge graph'}</strong><span>Run profile build, extract, and resolve to initialize this graph.</span></main>;

  return <main className="app">
    <header>
      <div className="title"><span className="crumb">graph</span><span className="separator">/</span><h1>{snapshot.config.title || 'Knowledge graph'}</h1></div>
      <div className="metadata"><span className="revision"><i />revision {snapshot.revision}</span><span>{snapshot.stats.nodes} nodes</span><span>{snapshot.stats.edges} edges</span><span>{snapshot.stats.claims} open {snapshot.stats.claims === 1 ? 'claim' : 'claims'}</span></div>
    </header>
    <section className="canvas"><GISDK id="trestle-g6vp" config={config} assets={assets} services={services} /></section>
  </main>;
}

ReactDOM.render(<App />, document.getElementById('root'));
