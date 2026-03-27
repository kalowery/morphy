function numberValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function firstPreview(context) {
  return (context?.previews ?? [])[0] ?? null;
}

function firstQueryWindow(context) {
  return firstPreview(context)?.detail?.queryWindow ?? null;
}

function queryResult(context, queryName) {
  for (const preview of context?.previews ?? []) {
    for (const result of preview?.detail?.queryResults ?? []) {
      if (result?.queryName === queryName) {
        return result;
      }
    }
  }

  return null;
}

function querySample(context, queryName) {
  return queryResult(context, queryName)?.sample ?? [];
}

function sortEntries(entries = [], direction = "desc") {
  const sorted = [...entries].sort((left, right) => numberValue(left?.value) - numberValue(right?.value));
  return direction === "asc" ? sorted : sorted.reverse();
}

function formatMetricLabels(metric = {}, labelFields = []) {
  const keys = labelFields.length ? labelFields : Object.keys(metric);
  const values = keys
    .filter((key) => metric[key] !== undefined && metric[key] !== null && metric[key] !== "")
    .map((key) => String(metric[key]));
  return values.join(" · ");
}

function applyValueTransform(value, transform = "identity", decimals = null) {
  const numeric = numberValue(value);
  let transformed = numeric;

  if (transform === "percent") {
    transformed = numeric * 100;
  }

  if (Number.isInteger(decimals) && Number.isFinite(transformed)) {
    transformed = Number(transformed.toFixed(decimals));
  }

  return transformed;
}

function displayValue(value, unit = "", transform = "identity", decimals = null) {
  const transformed = applyValueTransform(value, transform, decimals);
  if (!unit) {
    return String(transformed);
  }

  if (unit === "percent") {
    return `${transformed}%`;
  }

  return `${transformed} ${unit}`.trim();
}

function summarizeContextCoverage(context) {
  const previews = context?.previews ?? [];
  const readySources = previews.filter((preview) => preview?.status === "ready");
  const warningSources = previews.filter((preview) => preview?.status !== "ready");

  return {
    previewCount: previews.length,
    readySources: readySources.map((preview) => ({
      sourceId: preview.sourceId,
      sourceName: preview.sourceName,
      sourceType: preview.sourceType
    })),
    warningSources: warningSources.map((preview) => ({
      sourceId: preview.sourceId,
      sourceName: preview.sourceName,
      message: preview.detail?.message ?? "Source preview warning"
    })),
    queryWindow: firstQueryWindow(context)
  };
}

function normalizeRecipe(recipe, titleFallback = "Analysis Recipe") {
  const blocks = Array.isArray(recipe?.blocks)
    ? recipe.blocks
        .filter((block) => block?.id && block?.title && block?.operation)
        .map((block) => ({
          id: block.id,
          title: block.title,
          operation: block.operation,
          description: block.description ?? "",
          queryName: block.queryName ?? null,
          queryNames: Array.isArray(block.queryNames) ? block.queryNames.filter(Boolean) : [],
          labelFields: Array.isArray(block.labelFields) ? block.labelFields.filter(Boolean) : [],
          valueField: block.valueField ?? "value",
          valueTransform: block.valueTransform ?? "identity",
          unit: block.unit ?? "",
          decimals: Number.isInteger(block.decimals) ? block.decimals : null,
          limit: Number.isInteger(block.limit) ? block.limit : 5,
          sort: block.sort === "asc" ? "asc" : "desc"
        }))
    : [];

  return {
    focus: recipe?.focus ?? titleFallback,
    blocks
  };
}

function buildFallbackBlocksFromContext(context, limit = 3) {
  const previews = context?.previews ?? [];
  const seen = new Set();
  const blocks = [];

  for (const preview of previews) {
    for (const result of preview?.detail?.queryResults ?? []) {
      if (!result?.queryName || seen.has(result.queryName)) {
        continue;
      }

      seen.add(result.queryName);
      blocks.push({
        id: result.queryName,
        title: result.queryName,
        operation: result.resultType === "vector" ? "top_entries" : "scalar",
        description: "Fallback recipe generated from available source preview context.",
        queryName: result.queryName,
        labelFields: [],
        valueField: "value",
        valueTransform: "identity",
        unit: "",
        decimals: null,
        limit: 5,
        sort: "desc"
      });

      if (blocks.length >= limit) {
        return blocks;
      }
    }
  }

  return blocks;
}

function defaultPanelRecipe(panel, context) {
  return normalizeRecipe(
    {
      focus: `Summarize the most relevant evidence for ${panel?.title ?? "this panel"} using available local preview results.`,
      blocks: buildFallbackBlocksFromContext(context, 3)
    },
    `Fallback analysis recipe for ${panel?.title ?? "this panel"}`
  );
}

function defaultDomainRecipe(domain, context) {
  return normalizeRecipe(
    {
      focus: `Summarize the operating picture for ${domain?.name ?? "this domain"} from available local preview results.`,
      blocks: buildFallbackBlocksFromContext(context, 4)
    },
    `Fallback analysis recipe for ${domain?.name ?? "this domain"}`
  );
}

function scalarBlockOutput(block, context) {
  const sample = querySample(context, block.queryName);
  const entry = sample[0] ?? null;
  const rawValue = entry?.value ?? 0;
  const transformedValue = applyValueTransform(rawValue, block.valueTransform, block.decimals);

  return {
    blockId: block.id,
    title: block.title,
    operation: "scalar",
    description: block.description,
    sourceQuery: block.queryName,
    valueField: block.valueField,
    unit: block.unit,
    value: transformedValue,
    displayValue: displayValue(rawValue, block.unit, block.valueTransform, block.decimals),
    metric: entry?.metric ?? {}
  };
}

function topEntriesBlockOutput(block, context) {
  const queryNames = block.queryNames.length ? block.queryNames : [block.queryName].filter(Boolean);
  const rawEntries = queryNames.flatMap((queryName) =>
    querySample(context, queryName).map((entry) => ({
      queryName,
      metric: entry.metric ?? {},
      value: numberValue(entry.value)
    }))
  );

  const entries = sortEntries(rawEntries, block.sort)
    .slice(0, block.limit)
    .map((entry) => ({
      queryName: entry.queryName,
      label: formatMetricLabels(entry.metric, block.labelFields),
      metric: entry.metric,
      valueField: block.valueField,
      value: applyValueTransform(entry.value, block.valueTransform, block.decimals),
      displayValue: displayValue(entry.value, block.unit, block.valueTransform, block.decimals)
    }));

  return {
    blockId: block.id,
    title: block.title,
    operation: "top_entries",
    description: block.description,
    sourceQueries: queryNames,
    unit: block.unit,
    entries
  };
}

function executeRecipe(recipe, context) {
  return recipe.blocks.map((block) => {
    if (block.operation === "scalar") {
      return scalarBlockOutput(block, context);
    }

    return topEntriesBlockOutput(block, context);
  });
}

function summarizeRecipeDefinition(recipe) {
  const normalized = normalizeRecipe(recipe);
  return {
    focus: normalized.focus,
    blocks: normalized.blocks.map((block) => ({
      id: block.id,
      title: block.title,
      operation: block.operation,
      description: block.description,
      queryName: block.queryName,
      queryNames: block.queryNames,
      labelFields: block.labelFields,
      valueField: block.valueField,
      valueTransform: block.valueTransform,
      unit: block.unit,
      decimals: block.decimals,
      limit: block.limit,
      sort: block.sort
    }))
  };
}

function normalizeInteractionContract(panel) {
  const contract = panel?.interactionContract ?? {};
  const controls = Array.isArray(contract.controls)
    ? contract.controls
        .filter((control) => control?.id && control?.parameter && control?.type)
        .map((control) => ({
          id: control.id,
          label: control.label ?? control.id,
          description: control.description ?? "",
          type: control.type,
          parameter: control.parameter,
          source: control.source ?? null,
          queryName: control.queryName ?? null,
          field: control.field ?? null,
          displayFields: Array.isArray(control.displayFields) ? control.displayFields.filter(Boolean) : [],
          maxOptions: Number.isInteger(control.maxOptions) ? control.maxOptions : 24,
          multiple: control.multiple !== false,
          required: Boolean(control.required),
          defaultStrategy: control.defaultStrategy ?? "none"
        }))
    : [];

  return {
    mode: panel?.interactionMode ?? (controls.length ? "interactive" : "report"),
    summary: contract.summary ?? "",
    controls
  };
}

function buildControlOptionLabel(metric, control) {
  const displayFields = control.displayFields.length ? control.displayFields : [control.field];
  const values = displayFields
    .map((field) => metric?.[field])
    .filter((value) => value !== undefined && value !== null && value !== "");
  return values.length ? values.join(" · ") : String(metric?.[control.field] ?? "");
}

function collectControlOptions(control, context) {
  if (control.source === "query_window") {
    const queryWindow = firstQueryWindow(context);
    if (!queryWindow) {
      return [];
    }

    return [
      {
        value: {
          start: queryWindow.start ?? null,
          end: queryWindow.end ?? null
        },
        label: queryWindow.start && queryWindow.end
          ? `${queryWindow.start} to ${queryWindow.end}`
          : "Visible query window"
      }
    ];
  }

  if (!control.queryName || !control.field) {
    return [];
  }

  const sample = querySample(context, control.queryName);
  const options = [];

  for (const entry of sample) {
    const metric = entry?.metric ?? {};
    const value = metric[control.field];
    if (value === undefined || value === null || value === "") {
      continue;
    }

    const stringValue = String(value);
    if (!options.some((option) => option.value === stringValue)) {
      options.push({
        value: stringValue,
        label: buildControlOptionLabel(metric, control)
      });
    }

    if (options.length >= control.maxOptions) {
      break;
    }
  }

  return options;
}

function defaultSelectionForControl(control, options) {
  if (control.source === "query_window") {
    return options[0]?.value ?? null;
  }

  if (control.defaultStrategy === "top" && options.length) {
    return control.multiple ? [options[0].value] : options[0].value;
  }

  if (control.defaultStrategy === "all" && options.length) {
    return control.multiple ? options.map((option) => option.value) : options[0].value;
  }

  return control.multiple ? [] : null;
}

function normalizeControlValue(control, rawValue, options) {
  if (control.source === "query_window") {
    const fallback = options[0]?.value ?? { start: null, end: null };
    const start = rawValue?.start ?? fallback.start ?? null;
    const end = rawValue?.end ?? fallback.end ?? null;
    return { start, end };
  }

  const validValues = new Set(options.map((option) => option.value));
  if (control.multiple) {
    const values = Array.isArray(rawValue) ? rawValue.map((value) => String(value)) : [];
    return values.filter((value) => validValues.has(value));
  }

  const stringValue = rawValue == null ? null : String(rawValue);
  return stringValue && validValues.has(stringValue) ? stringValue : null;
}

function metricMatchesSelection(metric, control, value) {
  if (!control.field || control.source === "query_window") {
    return true;
  }

  const metricValue = metric?.[control.field];
  if (metricValue == null || metricValue === "") {
    return false;
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      return true;
    }
    return value.includes(String(metricValue));
  }

  if (value == null || value === "") {
    return true;
  }

  return String(metricValue) === String(value);
}

function filterFindingsBySelections(findings, contract, values) {
  const selectionControls = contract.controls.filter((control) => control.source !== "query_window");
  if (!selectionControls.length) {
    return findings;
  }

  return findings.map((finding) => {
    if (!Array.isArray(finding?.entries)) {
      return finding;
    }

    const filteredEntries = finding.entries.filter((entry) =>
      selectionControls.every((control) => metricMatchesSelection(entry.metric ?? {}, control, values[control.parameter]))
    );

    return {
      ...finding,
      entries: filteredEntries
    };
  });
}

function buildChartFromFindings(findings, panel) {
  const candidate = findings.find((finding) => Array.isArray(finding?.entries) && finding.entries.length) ?? null;
  if (!candidate) {
    return null;
  }

  return {
    type: panel?.chartPreference ?? "bar",
    title: candidate.title,
    labels: candidate.entries.map((entry) => entry.label),
    values: candidate.entries.map((entry) => Number(entry.value ?? 0))
  };
}

function buildDetailsFromFindings(findings) {
  return findings
    .filter((finding) => Array.isArray(finding?.entries) && finding.entries.length)
    .slice(0, 4)
    .map((finding) => ({
      title: finding.title,
      items: finding.entries.slice(0, 5).map((entry) => `${entry.label}: ${entry.displayValue}`)
    }));
}

function summarizeInteractionFilters(values = {}) {
  const parts = [];

  for (const [key, value] of Object.entries(values)) {
    if (key === "dateRange" || value === null || value === undefined || value === "") {
      continue;
    }

    const label = key
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .toLowerCase();

    if (Array.isArray(value) && value.length) {
      parts.push(`${value.length} ${label}${value.length === 1 ? "" : "s"}`);
      continue;
    }

    if (typeof value === "object") {
      continue;
    }

    parts.push(`${label} ${value}`);
  }

  if (values.dateRange?.start || values.dateRange?.end) {
    const start = values.dateRange.start ? String(values.dateRange.start).slice(0, 10) : "open";
    const end = values.dateRange.end ? String(values.dateRange.end).slice(0, 10) : "open";
    parts.push(`window ${start} to ${end}`);
  }

  return parts;
}

function buildNarrativeFromFindings(findings, coverage, values, panel) {
  const rankedFindings = findings
    .filter((finding) => Array.isArray(finding?.entries) && finding.entries.length)
    .slice(0, 3);
  const filterSummary = summarizeInteractionFilters(values);
  const queryWindow = coverage?.queryWindow ?? null;
  const windowSummary = queryWindow?.start || queryWindow?.end
    ? `${String(queryWindow.start ?? "").slice(0, 10)} to ${String(queryWindow.end ?? queryWindow.evaluationTime ?? "").slice(0, 10)}`
    : "the available preview window";

  if (!rankedFindings.length) {
    return [
      `No strong ${panel?.title?.toLowerCase?.() ?? "panel"} findings matched the current interactive filters.`,
      `Current scope covers ${filterSummary.join(", ") || "the full available selection set"} across ${windowSummary}.`
    ];
  }

  const leadFinding = rankedFindings[0];
  const leadEntry = leadFinding.entries[0];
  const firstLine = `${leadFinding.title} is led by ${leadEntry.label} at ${leadEntry.displayValue} for ${filterSummary.join(", ") || "the current scope"}.`;
  const secondLine = rankedFindings[1]
    ? `${rankedFindings[1].title} also remains elevated in this filtered view, while the evidence window covers ${windowSummary}.`
    : `The filtered view is grounded in ${windowSummary} and retains ${rankedFindings.length} ranked evidence block${rankedFindings.length === 1 ? "" : "s"}.`;

  return [firstLine, secondLine];
}

export function getInteractionDateRangeOverrides(panel, params = {}, context = null) {
  const contract = normalizeInteractionContract(panel);
  const control = contract.controls.find((entry) => entry.type === "date_range" && entry.source === "query_window");
  if (!control) {
    return {};
  }

  const options = collectControlOptions(control, context ?? { previews: [] });
  const normalized = normalizeControlValue(control, params[control.parameter], options);
  if (!normalized?.start && !normalized?.end) {
    return {};
  }

  return {
    defaultEvaluationTime: normalized.end ?? null,
    start: normalized.start ?? null,
    end: normalized.end ?? null
  };
}

export function buildPanelInteractionState(panel, context, params = {}) {
  const contract = normalizeInteractionContract(panel);
  const controls = contract.controls.map((control) => {
    const options = collectControlOptions(control, context);
    const selectedValue = normalizeControlValue(
      control,
      params[control.parameter] ?? defaultSelectionForControl(control, options),
      options
    );

    return {
      ...control,
      options,
      value: selectedValue
    };
  });

  const values = Object.fromEntries(controls.map((control) => [control.parameter, control.value]));
  const summary = buildDeterministicPanelSummary(panel, context);
  const filteredFindings = filterFindingsBySelections(summary.findings, contract, values);
  const filteredSummary = {
    ...summary,
    findings: filteredFindings
  };
  const chart = buildChartFromFindings(filteredSummary.findings, panel);
  const details = buildDetailsFromFindings(filteredSummary.findings);
  const highlights = filteredSummary.findings
    .filter((finding) => Array.isArray(finding?.entries) && finding.entries.length)
    .slice(0, 4)
    .map((finding) => `${finding.title}: ${finding.entries[0].label} (${finding.entries[0].displayValue})`);
  const narrative = buildNarrativeFromFindings(filteredSummary.findings, filteredSummary.coverage, values, panel);

  return {
    mode: contract.mode,
    summary: narrative[0] ?? contract.summary,
    controls: controls.map((control) => ({
      id: control.id,
      label: control.label,
      description: control.description,
      type: control.type,
      parameter: control.parameter,
      multiple: control.multiple,
      required: control.required,
      options: control.options,
      value: control.value
    })),
    params: values,
    validation: {
      valid: true
    },
    data: {
      localFindings: filteredSummary,
      findings: filteredSummary.findings,
      chart,
      coverage: filteredSummary.coverage,
      report: {
        chart,
        details,
        highlights,
        narrative
      }
    }
  };
}

export function listDeterministicTools() {
  return [
    {
      id: "source_preview_coverage",
      description: "Summarize preview readiness, source coverage, and the active query window."
    },
    {
      id: "scalar_query_value",
      description: "Extract a single scalar or first-sample numeric value from a named preview query."
    },
    {
      id: "ranked_query_entries",
      description: "Rank top entries from a named preview query using configurable label fields, transforms, and limits."
    },
    {
      id: "recipe_execution",
      description: "Execute a domain- or panel-defined analysis recipe over local preview data without sending raw data to the model."
    }
  ];
}

function discoveryToolId(sourceId, view) {
  return `source:${sourceId}:${view}`;
}

function compactStringList(values = [], limit = 12) {
  return values.filter(Boolean).slice(0, limit);
}

function discoveryTables(detail = {}) {
  return (detail.schema?.tables ?? []).map((table) => ({
    schema: table.schema ?? "main",
    table: table.table ?? table.name ?? null
  })).filter((entry) => entry.table);
}

function discoveryColumns(detail = {}) {
  return (detail.schema?.columns ?? []).map((column) => ({
    schema: column.schema ?? "main",
    table: column.table ?? null,
    name: column.name ?? null,
    type: column.type ?? null
  })).filter((entry) => entry.name);
}

function buildSourceDiscoveryTools(source, evidence) {
  const detail = evidence?.status === "ready" ? evidence : null;
  const tools = [
    {
      id: discoveryToolId(source.id, "overview"),
      scopeType: "source",
      scopeId: source.id,
      scopeTitle: source.name,
      title: `${source.name} Overview`,
      description: `Inspect high-level readiness, type, and evidence coverage for ${source.name}.`,
      operation: "source_overview",
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      sourceEngine: source.engine ?? source.connection?.engine ?? null,
      view: "overview"
    }
  ];

  if (!detail) {
    return tools;
  }

  tools.push({
    id: discoveryToolId(source.id, "structure"),
    scopeType: "source",
    scopeId: source.id,
    scopeTitle: source.name,
    title: `${source.name} Structure`,
    description: `Inspect schema, query catalog, or field structure for ${source.name}.`,
    operation: "source_structure",
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    sourceEngine: source.engine ?? source.connection?.engine ?? null,
    view: "structure"
  });

  tools.push({
    id: discoveryToolId(source.id, "samples"),
    scopeType: "source",
    scopeId: source.id,
    scopeTitle: source.name,
    title: `${source.name} Samples`,
    description: `Inspect representative sample contents for ${source.name}.`,
    operation: "source_samples",
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    sourceEngine: source.engine ?? source.connection?.engine ?? null,
    view: "samples"
  });

  return tools;
}

function executeSourceDiscoveryToolDescriptor(tool, sourceDiscoveryContext) {
  const evidence = sourceDiscoveryContext?.evidenceBySourceId?.[tool.sourceId] ?? null;
  const detail = evidence?.status === "ready" ? evidence : null;

  if (tool.view === "overview") {
    return {
      kind: "source_overview",
      title: tool.title,
      sourceId: tool.sourceId,
      sourceName: tool.sourceName,
      sourceType: tool.sourceType,
      engine: tool.sourceEngine ?? null,
      status: evidence?.status ?? "unknown",
      summary: detail
        ? `${tool.sourceName} is a ready ${tool.sourceType}${tool.sourceEngine ? ` (${tool.sourceEngine})` : ""} source.`
        : `${tool.sourceName} is not currently ready: ${evidence?.issue ?? "preview unavailable"}`,
      details: detail
        ? {
            description: evidence.description ?? "",
            rowCount: detail.rowCount ?? null,
            previewQueries: compactStringList(detail.previewQueries ?? []),
            queryWindow: detail.window ?? null,
            tableCount: detail.schema?.tableCount ?? null,
            sampleKeys: compactStringList(detail.sampleKeys ?? []),
            numericFields: compactStringList(detail.numericFields ?? [])
          }
        : {
            issue: evidence?.issue ?? "preview unavailable"
          }
    };
  }

  if (!detail) {
    return {
      kind: "source_unavailable",
      title: tool.title,
      sourceId: tool.sourceId,
      summary: `${tool.sourceName} is unavailable for ${tool.view} inspection.`,
      details: {
        issue: evidence?.issue ?? "preview unavailable"
      }
    };
  }

  if (tool.view === "structure") {
    return {
      kind: "source_structure",
      title: tool.title,
      sourceId: tool.sourceId,
      sourceName: tool.sourceName,
      sourceType: tool.sourceType,
      engine: tool.sourceEngine ?? null,
      summary: `Structure view for ${tool.sourceName}.`,
      details: {
        previewQueries: compactStringList(detail.previewQueries ?? []),
        queryCatalog: (detail.queryCatalog ?? []).slice(0, 12),
        labelKeys: compactStringList(
          (detail.queryResults ?? []).flatMap((result) => result.labelKeys ?? [])
        ),
        tables: discoveryTables(detail).slice(0, 12),
        columns: discoveryColumns(detail).slice(0, 20),
        sampleKeys: compactStringList(detail.sampleKeys ?? []),
        numericFields: compactStringList(detail.numericFields ?? [])
      }
    };
  }

  return {
    kind: "source_samples",
    title: tool.title,
    sourceId: tool.sourceId,
    sourceName: tool.sourceName,
    sourceType: tool.sourceType,
    engine: tool.sourceEngine ?? null,
    summary: `Sample content view for ${tool.sourceName}.`,
    details: {
      queryResults: (detail.queryResults ?? []).slice(0, 6),
      sampleRows: (detail.sampleRows ?? []).slice(0, 6),
      rowCount: detail.rowCount ?? null,
      representativeRows: (detail.sampleRows ?? detail.sample ?? []).slice(0, 6)
    }
  };
}

function recipeToolsForScope(scopeType, scopeId, scopeTitle, recipe) {
  const normalized = normalizeRecipe(recipe, scopeTitle);
  return normalized.blocks.map((block) => {
    const queryNames = [...new Set([...(block.queryNames ?? []), ...(block.queryName ? [block.queryName] : [])])];
    return {
      id: `${scopeType}:${scopeId}:${block.id}`,
      scopeType,
      scopeId,
      scopeTitle,
      title: block.title,
      description: block.description || `Run the ${block.title} ${block.operation} block for ${scopeTitle}.`,
      operation: block.operation,
      backedByPrimitives: block.operation === "scalar" ? ["scalar_query_value"] : ["ranked_query_entries"],
      queryNames,
      valueField: block.valueField,
      labelFields: block.labelFields,
      valueTransform: block.valueTransform,
      unit: block.unit,
      limit: block.limit,
      focus: normalized.focus
    };
  });
}

function executeToolDescriptor(tool, context) {
  const block = {
    id: tool.id,
    title: tool.title,
    operation: tool.operation,
    description: tool.description ?? "",
    queryName: tool.queryNames?.length === 1 ? tool.queryNames[0] : tool.queryName ?? null,
    queryNames: tool.queryNames ?? [],
    labelFields: tool.labelFields ?? [],
    valueField: tool.valueField ?? "value",
    valueTransform: tool.valueTransform ?? "identity",
    unit: tool.unit ?? "",
    decimals: Number.isInteger(tool.decimals) ? tool.decimals : null,
    limit: Number.isInteger(tool.limit) ? tool.limit : 5,
    sort: tool.sort === "asc" ? "asc" : "desc"
  };

  return block.operation === "scalar" ? scalarBlockOutput(block, context) : topEntriesBlockOutput(block, context);
}

export function buildDomainToolRegistry(domain) {
  const domainRecipe = domain?.analysisRecipe ? normalizeRecipe(domain.analysisRecipe, domain?.name ?? "domain") : null;
  const tools = [
    ...recipeToolsForScope("domain", domain?.id ?? "domain", domain?.name ?? "Domain", domainRecipe),
    ...((domain?.panels ?? []).flatMap((panel) =>
      recipeToolsForScope("panel", panel.id, panel.title, panel.analysisRecipe)
    ))
  ];

  return {
    domainId: domain?.id ?? null,
    domainName: domain?.name ?? null,
    toolCount: tools.length,
    tools
  };
}

export function buildDomainGenerationToolRegistry(dataSources, sourceDiscoveryEvidence) {
  const evidenceBySourceId = Object.fromEntries(
    (sourceDiscoveryEvidence ?? []).map((evidence) => [evidence.sourceId, evidence])
  );
  const tools = (dataSources ?? []).flatMap((source) =>
    buildSourceDiscoveryTools(source, evidenceBySourceId[source.id] ?? null)
  );

  return {
    toolCount: tools.length,
    tools
  };
}

export function buildPanelToolRegistry(domain, panel) {
  const domainRegistry = buildDomainToolRegistry(domain);
  return {
    domainId: domain?.id ?? null,
    panelId: panel?.id ?? null,
    panelTitle: panel?.title ?? null,
    tools: domainRegistry.tools.filter((tool) => tool.scopeType === "domain" || tool.scopeId === panel?.id)
  };
}

export function executeDerivedTool(toolRegistry, context, toolId) {
  const tool = (toolRegistry?.tools ?? []).find((entry) => entry.id === toolId);

  if (!tool) {
    throw new Error(`Unknown derived tool: ${toolId}`);
  }

  return {
    tool: {
      id: tool.id,
      scopeType: tool.scopeType,
      scopeId: tool.scopeId,
      scopeTitle: tool.scopeTitle,
      title: tool.title,
      description: tool.description,
      operation: tool.operation,
      queryNames: tool.queryNames ?? [],
      focus: tool.focus ?? ""
    },
    result: executeToolDescriptor(tool, context)
  };
}

export function executeDomainGenerationTool(toolRegistry, sourceDiscoveryContext, toolId) {
  const tool = (toolRegistry?.tools ?? []).find((entry) => entry.id === toolId);

  if (!tool) {
    throw new Error(`Unknown domain-generation tool: ${toolId}`);
  }

  return {
    tool: {
      id: tool.id,
      scopeType: tool.scopeType,
      scopeId: tool.scopeId,
      scopeTitle: tool.scopeTitle,
      title: tool.title,
      description: tool.description,
      operation: tool.operation,
      sourceType: tool.sourceType,
      sourceEngine: tool.sourceEngine ?? null
    },
    result: executeSourceDiscoveryToolDescriptor(tool, sourceDiscoveryContext)
  };
}

export function getRelevantQueryNamesFromRecipe(recipe) {
  const normalized = normalizeRecipe(recipe);
  const names = normalized.blocks.flatMap((block) => [
    ...block.queryNames,
    ...(block.queryName ? [block.queryName] : [])
  ]);
  return [...new Set(names.filter(Boolean))];
}

export function buildDeterministicDomainSummary(domain, context) {
  const recipe = domain?.analysisRecipe ? normalizeRecipe(domain.analysisRecipe, domain.name) : defaultDomainRecipe(domain, context);
  return {
    domainId: domain.id,
    domainName: domain.name,
    mode: "recipe-tooling",
    coverage: summarizeContextCoverage(context),
    recipe: summarizeRecipeDefinition(recipe),
    findings: executeRecipe(recipe, context)
  };
}

export function buildDeterministicPanelSummary(panel, context) {
  const recipe = panel?.analysisRecipe ? normalizeRecipe(panel.analysisRecipe, panel.title) : defaultPanelRecipe(panel, context);
  return {
    panelId: panel.id,
    panelTitle: panel.title,
    mode: "recipe-tooling",
    coverage: summarizeContextCoverage(context),
    recipe: summarizeRecipeDefinition(recipe),
    findings: executeRecipe(recipe, context)
  };
}

export function buildDeterministicToolEnvelope(domain, panel, context) {
  return {
    primitives: listDeterministicTools(),
    toolRegistry: buildPanelToolRegistry(domain, panel),
    domainSummary: buildDeterministicDomainSummary(domain, context),
    panelSummary: panel ? buildDeterministicPanelSummary(panel, context) : null
  };
}

export { normalizeInteractionContract };
