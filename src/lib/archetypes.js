const BUILTIN_ARCHETYPES = {
  "risk-scoreboard": {
    id: "risk-scoreboard",
    title: "Risk Scoreboard",
    description: "Ranked operational risk layout emphasizing outliers, scores, and triage order.",
    requiredSections: ["ranked-signals", "triage-summary", "operator-notes"],
    detailSections: [
      {
        id: "ranked-signals",
        title: "Ranked Signals",
        description: "Highest-priority entities or signals in descending importance order.",
        minItems: 2,
        maxItems: 5
      },
      {
        id: "triage-summary",
        title: "Triage Summary",
        description: "Short statements describing why the top risks or outliers matter.",
        minItems: 1,
        maxItems: 4
      },
      {
        id: "operator-notes",
        title: "Guidance Notes",
        description: "Caveats, confidence notes, or next checks a user should keep in mind.",
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
    description: "Capacity and bottleneck comparison layout for queueing, saturation, or resource pressure.",
    requiredSections: ["pressure-metrics", "backlog-board", "capacity-notes"],
    detailSections: [
      {
        id: "pressure-metrics",
        title: "Pressure Metrics",
        description: "The highest-pressure queues, cohorts, or peer entities and their current values.",
        minItems: 2,
        maxItems: 5
      },
      {
        id: "backlog-board",
        title: "Comparison Board",
        description: "Concrete leaders in backlog, saturation, or comparison metrics that explain the current bottleneck.",
        minItems: 2,
        maxItems: 5
      },
      {
        id: "capacity-notes",
        title: "Capacity Notes",
        description: "Interpretation of what is constrained and what should be verified next.",
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
        description: "Interpretation of the time pattern and what it suggests.",
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
    description: "Cross-linked layout for associating related entities, cohorts, or signals.",
    requiredSections: ["entity-links", "evidence-matrix", "attribution-notes"],
    detailSections: [
      {
        id: "entity-links",
        title: "Entity Links",
        description: "Direct associations among important entities, cohorts, or signals.",
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
    requiredSections: ["briefing", "actions", "confidence-notes"],
    detailSections: [
      {
        id: "briefing",
        title: "Briefing",
        description: "The main story in concise handoff-friendly language.",
        minItems: 1,
        maxItems: 3
      },
      {
        id: "actions",
        title: "Actions",
        description: "Immediate actions or checks recommended from the current evidence.",
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
  }
};

function dedupe(values) {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function getDomainArchetypeLibrary(domain) {
  return domain?.archetypes?.library ?? domain?.archetypes ?? {};
}

export function getArchetypeRegistry(appConfig = {}, domain = null) {
  const configuredLibrary = appConfig.archetypes?.library ?? {};
  const domainLibrary = getDomainArchetypeLibrary(domain);

  return {
    defaultArchetype: appConfig.archetypes?.defaultArchetype ?? "incident-summary",
    library: {
      ...BUILTIN_ARCHETYPES,
      ...configuredLibrary,
      ...domainLibrary
    }
  };
}

export function getArchetypeDefinition(appConfig = {}, domain, archetypeId) {
  const registry = getArchetypeRegistry(appConfig, domain);
  return registry.library[archetypeId] ?? null;
}

export function getPanelAllowedArchetypes(appConfig = {}, domain, panel) {
  const registry = getArchetypeRegistry(appConfig, domain);
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
  if (panel?.interactionMode === "interactive") {
    return dedupe(
      [
        "correlation-inspector",
        "risk-scoreboard",
        "timeline-analysis",
        registry.defaultArchetype
      ].filter((id) => registry.library[id])
    );
  }

  if (panel?.chartPreference === "line") {
    return dedupe(
      ["timeline-analysis", "risk-scoreboard", registry.defaultArchetype].filter((id) => registry.library[id])
    );
  }

  return [registry.defaultArchetype];
}

export function getPreferredArchetype(appConfig = {}, domain, panel) {
  const allowed = getPanelAllowedArchetypes(appConfig, domain, panel);
  if (!allowed.length) {
    return getArchetypeRegistry(appConfig, domain).defaultArchetype;
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
    .map((id) => getArchetypeDefinition(appConfig, domain, id))
    .filter(Boolean);

  return {
    allowed,
    preferred,
    guidance: panel?.archetypeGuidance ?? "",
    definitions
  };
}

export function buildArchetypeWidgetContract(appConfig = {}, domain, archetypeId) {
  const definition = getArchetypeDefinition(appConfig, domain, archetypeId);

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

export function buildArchetypeAnalysisContract(appConfig = {}, domain, archetypeId) {
  const definition = getArchetypeDefinition(appConfig, domain, archetypeId);

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
