const BUILTIN_ARCHETYPES = {
  "risk-scoreboard": {
    id: "risk-scoreboard",
    title: "Risk Scoreboard",
    description: "Ranked operational risk layout emphasizing outliers, scores, and triage order.",
    suitedPanels: ["fleet-health", "fabric-storage", "gpu-hotspots"],
    requiredSections: ["ranked-signals", "triage-summary", "operator-notes"],
    layoutGuidance:
      "Use a ranked, triage-first composition. Emphasize top offenders, relative ordering, and concise risk interpretation over long narrative blocks."
  },
  "pressure-board": {
    id: "pressure-board",
    title: "Pressure Board",
    description: "Partition or capacity pressure layout for queue backlog, saturation, and bottleneck comparison.",
    suitedPanels: ["scheduler-pressure"],
    requiredSections: ["pressure-metrics", "backlog-board", "capacity-notes"],
    layoutGuidance:
      "Use a board-like comparison layout that makes backlog, saturation, and bottleneck differences immediately legible across peer entities."
  },
  "timeline-analysis": {
    id: "timeline-analysis",
    title: "Timeline Analysis",
    description: "Trend-oriented layout for time-varying signals, slopes, and temporal comparisons.",
    suitedPanels: ["gpu-hotspots", "job-explorer"],
    requiredSections: ["timeline-overview", "peak-metrics", "trend-notes"],
    layoutGuidance:
      "Use temporal sequencing, trend strips, or slope-oriented visuals. The widget should feel like a time story, not just a ranked list."
  },
  "correlation-inspector": {
    id: "correlation-inspector",
    title: "Correlation Inspector",
    description: "Cross-linked layout for associating hosts, users, jobs, partitions, and other entities.",
    suitedPanels: ["job-correlation", "job-explorer"],
    requiredSections: ["entity-links", "evidence-matrix", "attribution-notes"],
    layoutGuidance:
      "Use a cross-linked inspection layout. Show relationships among entities and explicitly surface where attribution is direct versus inferred."
  },
  "incident-summary": {
    id: "incident-summary",
    title: "Incident Summary",
    description: "Narrative-first operational briefing layout for actions, caveats, and confidence.",
    suitedPanels: ["operator-brief", "fleet-health", "fabric-storage"],
    requiredSections: ["briefing", "actions", "confidence-notes"],
    layoutGuidance:
      "Lead with concise briefing text and action chips. Visuals should support the handoff summary rather than dominate it."
  },
  "job-detail-sheet": {
    id: "job-detail-sheet",
    title: "Job Detail Sheet",
    description: "Job-centric layout with workload attribution, resource behavior, and candidate drilldowns.",
    suitedPanels: ["job-explorer", "job-correlation"],
    requiredSections: ["job-header", "resource-profile", "candidate-drilldowns"],
    layoutGuidance:
      "Use a dossier-like layout centered on one or a few jobs. Resource behavior and attribution should read like an investigation sheet."
  }
};

function dedupe(values) {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export function getArchetypeRegistry(appConfig = {}) {
  const configuredLibrary = appConfig.archetypes?.library ?? {};

  return {
    defaultArchetype: appConfig.archetypes?.defaultArchetype ?? "incident-summary",
    library: {
      ...BUILTIN_ARCHETYPES,
      ...configuredLibrary
    }
  };
}

export function getArchetypeDefinition(appConfig = {}, archetypeId) {
  const registry = getArchetypeRegistry(appConfig);
  return registry.library[archetypeId] ?? null;
}

export function getPanelAllowedArchetypes(appConfig = {}, domain, panel) {
  const registry = getArchetypeRegistry(appConfig);
  const domainAllowed = Array.isArray(domain?.allowedArchetypes)
    ? domain.allowedArchetypes.filter((id) => registry.library[id])
    : [];
  const panelAllowed = Array.isArray(panel?.allowedArchetypes)
    ? panel.allowedArchetypes.filter((id) => registry.library[id])
    : [];

  if (panelAllowed.length) {
    return dedupe(panelAllowed);
  }

  if (domainAllowed.length) {
    return dedupe(domainAllowed);
  }

  const suited = Object.values(registry.library)
    .filter((entry) => entry.suitedPanels?.includes(panel?.id))
    .map((entry) => entry.id);

  return suited.length ? dedupe(suited) : [registry.defaultArchetype];
}

export function getPreferredArchetype(appConfig = {}, domain, panel) {
  const allowed = getPanelAllowedArchetypes(appConfig, domain, panel);
  if (!allowed.length) {
    return getArchetypeRegistry(appConfig).defaultArchetype;
  }

  if (panel?.preferredArchetype && allowed.includes(panel.preferredArchetype)) {
    return panel.preferredArchetype;
  }

  return allowed[0];
}

export function buildArchetypePromptBlock(appConfig = {}, domain, panel) {
  const allowed = getPanelAllowedArchetypes(appConfig, domain, panel);
  const preferred = getPreferredArchetype(appConfig, domain, panel);
  const definitions = allowed
    .map((id) => getArchetypeDefinition(appConfig, id))
    .filter(Boolean);

  return {
    allowed,
    preferred,
    guidance: panel?.archetypeGuidance ?? "",
    definitions
  };
}

export function buildArchetypeWidgetContract(appConfig = {}, archetypeId) {
  const definition = getArchetypeDefinition(appConfig, archetypeId);

  if (!definition) {
    return null;
  }

  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    requiredSections: definition.requiredSections ?? [],
    layoutGuidance: definition.layoutGuidance ?? ""
  };
}
