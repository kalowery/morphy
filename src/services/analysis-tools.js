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
        labelFields: ["instance", "partition", "jobid", "user", "card", "device"],
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
