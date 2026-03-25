const BUILTIN_ARCHETYPES = {
  "risk-scoreboard": {
    id: "risk-scoreboard",
    title: "Risk Scoreboard",
    description: "Ranked operational risk layout emphasizing outliers, scores, and triage order.",
    suitedPanels: ["fleet-health", "fabric-storage", "gpu-hotspots"],
    requiredSections: ["ranked-signals", "triage-summary", "operator-notes"],
    detailSections: [
      {
        id: "ranked-signals",
        title: "Ranked Signals",
        description: "Highest-priority entities, hosts, or signals in descending risk order.",
        minItems: 2,
        maxItems: 5
      },
      {
        id: "triage-summary",
        title: "Triage Summary",
        description: "Short statements describing why the top risks matter operationally.",
        minItems: 1,
        maxItems: 4
      },
      {
        id: "operator-notes",
        title: "Operator Notes",
        description: "Caveats, confidence notes, or next checks the operator should keep in mind.",
        minItems: 1,
        maxItems: 4
      }
    ],
    layoutGuidance:
      "Use a ranked, triage-first composition. Emphasize top offenders, relative ordering, and concise risk interpretation over long narrative blocks."
  },
  "pressure-board": {
    id: "pressure-board",
    title: "Pressure Board",
    description: "Partition or capacity pressure layout for queue backlog, saturation, and bottleneck comparison.",
    suitedPanels: ["scheduler-pressure"],
    requiredSections: ["pressure-metrics", "backlog-board", "capacity-notes"],
    detailSections: [
      {
        id: "pressure-metrics",
        title: "Pressure Metrics",
        description: "The highest-pressure partitions, queues, or peer entities and their current values.",
        minItems: 2,
        maxItems: 5
      },
      {
        id: "backlog-board",
        title: "Backlog Board",
        description: "Concrete backlog or saturation leaders that explain the current bottleneck.",
        minItems: 2,
        maxItems: 5
      },
      {
        id: "capacity-notes",
        title: "Capacity Notes",
        description: "Interpretation of what is constrained and what the operator should verify next.",
        minItems: 1,
        maxItems: 4
      }
    ],
    layoutGuidance:
      "Use a board-like comparison layout that makes backlog, saturation, and bottleneck differences immediately legible across peer entities."
  },
  "timeline-analysis": {
    id: "timeline-analysis",
    title: "Timeline Analysis",
    description: "Trend-oriented layout for time-varying signals, slopes, and temporal comparisons.",
    suitedPanels: ["gpu-hotspots", "job-explorer"],
    requiredSections: ["timeline-overview", "peak-metrics", "trend-notes"],
    detailSections: [
      {
        id: "timeline-overview",
        title: "Timeline Overview",
        description: "A compact summary of how the signal evolved over the observed interval.",
        minItems: 1,
        maxItems: 3
      },
      {
        id: "peak-metrics",
        title: "Peak Metrics",
        description: "The strongest peaks, inflection points, or entities with the most extreme temporal behavior.",
        minItems: 2,
        maxItems: 5
      },
      {
        id: "trend-notes",
        title: "Trend Notes",
        description: "Interpretation of the time pattern and what it suggests operationally.",
        minItems: 1,
        maxItems: 4
      }
    ],
    layoutGuidance:
      "Use temporal sequencing, trend strips, or slope-oriented visuals. The widget should feel like a time story, not just a ranked list."
  },
  "correlation-inspector": {
    id: "correlation-inspector",
    title: "Correlation Inspector",
    description: "Cross-linked layout for associating hosts, users, jobs, partitions, and other entities.",
    suitedPanels: ["job-correlation", "job-explorer"],
    requiredSections: ["entity-links", "evidence-matrix", "attribution-notes"],
    detailSections: [
      {
        id: "entity-links",
        title: "Entity Links",
        description: "Direct associations among jobs, users, nodes, partitions, or devices.",
        minItems: 2,
        maxItems: 5
      },
      {
        id: "evidence-matrix",
        title: "Evidence Matrix",
        description: "Signals that support or weaken the proposed correlations.",
        minItems: 2,
        maxItems: 5
      },
      {
        id: "attribution-notes",
        title: "Attribution Notes",
        description: "What is direct evidence versus what is inferred or uncertain.",
        minItems: 1,
        maxItems: 4
      }
    ],
    layoutGuidance:
      "Use a cross-linked inspection layout. Show relationships among entities and explicitly surface where attribution is direct versus inferred."
  },
  "incident-summary": {
    id: "incident-summary",
    title: "Incident Summary",
    description: "Narrative-first operational briefing layout for actions, caveats, and confidence.",
    suitedPanels: ["operator-brief", "fleet-health", "fabric-storage"],
    requiredSections: ["briefing", "actions", "confidence-notes"],
    detailSections: [
      {
        id: "briefing",
        title: "Briefing",
        description: "The main operational story in concise handoff-friendly language.",
        minItems: 1,
        maxItems: 3
      },
      {
        id: "actions",
        title: "Actions",
        description: "Immediate operator actions or checks recommended from the current evidence.",
        minItems: 1,
        maxItems: 4
      },
      {
        id: "confidence-notes",
        title: "Confidence Notes",
        description: "Caveats, uncertainty, or validation guidance for the current conclusions.",
        minItems: 1,
        maxItems: 4
      }
    ],
    layoutGuidance:
      "Lead with concise briefing text and action chips. Visuals should support the handoff summary rather than dominate it."
  },
  "job-detail-sheet": {
    id: "job-detail-sheet",
    title: "Job Detail Sheet",
    description: "Job-centric layout with workload attribution, resource behavior, and candidate drilldowns.",
    suitedPanels: ["job-explorer", "job-correlation"],
    requiredSections: ["job-header", "resource-profile", "candidate-drilldowns"],
    detailSections: [
      {
        id: "job-header",
        title: "Job Header",
        description: "The most likely jobs or workload identities currently worth inspecting.",
        minItems: 1,
        maxItems: 4
      },
      {
        id: "resource-profile",
        title: "Resource Profile",
        description: "Resource behavior linked to the candidate job set, such as utilization, VRAM, or occupancy.",
        minItems: 2,
        maxItems: 5
      },
      {
        id: "candidate-drilldowns",
        title: "Candidate Drilldowns",
        description: "Specific follow-up drilldowns or job-level questions the operator should pursue next.",
        minItems: 1,
        maxItems: 4
      }
    ],
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
    detailSections: definition.detailSections ?? [],
    layoutGuidance: definition.layoutGuidance ?? ""
  };
}

export function buildArchetypeAnalysisContract(appConfig = {}, archetypeId) {
  const definition = getArchetypeDefinition(appConfig, archetypeId);

  if (!definition) {
    return null;
  }

  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    detailSections: definition.detailSections ?? [],
    layoutGuidance: definition.layoutGuidance ?? "",
    requiredSections: definition.requiredSections ?? []
  };
}
