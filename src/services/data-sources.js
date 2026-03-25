import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./config-store.js";

const noopLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {}
};

function relativeToRoot(candidatePath) {
  if (path.isAbsolute(candidatePath)) {
    return candidatePath;
  }

  return path.join(paths.rootDir, candidatePath);
}

function summarizeRows(rows) {
  if (!Array.isArray(rows)) {
    return { kind: typeof rows, rowCount: 0, metrics: {} };
  }

  const metrics = {};

  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== "number") {
        continue;
      }

      const current = metrics[key] ?? {
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        sum: 0,
        count: 0
      };

      current.min = Math.min(current.min, value);
      current.max = Math.max(current.max, value);
      current.sum += value;
      current.count += 1;
      metrics[key] = current;
    }
  }

  const normalized = Object.fromEntries(
    Object.entries(metrics).map(([key, metric]) => [
      key,
      {
        min: metric.min,
        max: metric.max,
        average: Number((metric.sum / metric.count).toFixed(3))
      }
    ])
  );

  return {
    kind: "rows",
    rowCount: rows.length,
    metrics: normalized,
    sample: rows.slice(0, 5)
  };
}

function summarizeVectorResult(result) {
  return result.slice(0, 12).map((entry) => ({
    metric: entry.metric ?? {},
    value: Array.isArray(entry.value) ? entry.value[1] : null
  }));
}

function buildVictoriaQueryUrl(source, queryExpression) {
  const endpoint = source.queryEndpoint ?? "/api/v1/query";
  const url = new URL(endpoint, source.baseUrl);
  url.searchParams.set("query", queryExpression);

  const evaluationTime = source.defaultEvaluationTime ?? source.time;
  if (evaluationTime) {
    url.searchParams.set("time", evaluationTime);
  }

  if (source.start) {
    url.searchParams.set("start", source.start);
  }

  if (source.end) {
    url.searchParams.set("end", source.end);
  }

  return url;
}

async function executeVictoriaQuery(source, queryName, queryExpression, logger = noopLogger) {
  const url = buildVictoriaQueryUrl(source, queryExpression);
  logger.debug("Executing VictoriaMetrics query", {
    sourceId: source.id,
    queryName,
    url: url.toString()
  }, "datasources");
  const response = await fetch(url, { headers: { accept: "application/json" } });

  if (!response.ok) {
    logger.warn("VictoriaMetrics query failed", {
      sourceId: source.id,
      queryName,
      status: response.status
    }, "datasources");
    throw new Error(`VictoriaMetrics returned ${response.status}`);
  }

  const payload = await response.json();
  const result = Array.isArray(payload.data?.result) ? payload.data.result : [];
  logger.debug("VictoriaMetrics query completed", {
    sourceId: source.id,
    queryName,
    resultType: payload.data?.resultType ?? "unknown",
    resultCount: result.length
  }, "datasources");

  return {
    queryName,
    resultType: payload.data?.resultType ?? "unknown",
    resultCount: result.length,
    sample: summarizeVectorResult(result)
  };
}

async function previewJsonFile(source, logger = noopLogger) {
  try {
    const fullPath = relativeToRoot(source.path);
    logger.debug("Previewing JSON source", {
      sourceId: source.id,
      path: fullPath
    }, "datasources");
    const raw = await fs.readFile(fullPath, "utf8");
    const payload = JSON.parse(raw);

    return {
      sourceId: source.id,
      sourceType: source.type,
      sourceName: source.name,
      status: "ready",
      detail: summarizeRows(payload)
    };
  } catch (error) {
    logger.warn("JSON source preview failed", {
      sourceId: source.id,
      error: error.message
    }, "datasources");
    return {
      sourceId: source.id,
      sourceType: source.type,
      sourceName: source.name,
      status: "warning",
      detail: {
        message: error.message
      }
    };
  }
}

async function previewVictoriaMetrics(source, logger = noopLogger) {
  if (!source.baseUrl) {
    return {
      sourceId: source.id,
      sourceType: source.type,
      sourceName: source.name,
      status: "warning",
      detail: {
        message: "No baseUrl configured."
      }
    };
  }

  const queries = source.queries ?? {};
  const queryEntries = Object.entries(queries);

  if (!queryEntries.length) {
    return {
      sourceId: source.id,
      sourceType: source.type,
      sourceName: source.name,
      status: "warning",
      detail: {
        message: "No VictoriaMetrics queries configured."
      }
    };
  }

  try {
    const configuredPreviewNames = Array.isArray(source.previewQueryNames)
      ? source.previewQueryNames.filter((queryName) => typeof queryName === "string" && queries[queryName])
      : [];
    const previewQueries = configuredPreviewNames.length
      ? configuredPreviewNames.map((queryName) => [queryName, queries[queryName]])
      : queryEntries.slice(0, Math.min(4, queryEntries.length));
    const queryResults = await Promise.all(
      previewQueries.map(([queryName, queryExpression]) =>
        executeVictoriaQuery(source, queryName, queryExpression, logger)
      )
    );
    logger.info("VictoriaMetrics preview ready", {
      sourceId: source.id,
      queryNames: previewQueries.map(([queryName]) => queryName),
      queryCount: queryResults.length
    }, "datasources");

    return {
      sourceId: source.id,
      sourceType: source.type,
      sourceName: source.name,
      status: "ready",
      detail: {
        queryWindow: {
          evaluationTime: source.defaultEvaluationTime ?? source.time ?? null,
          start: source.start ?? null,
          end: source.end ?? null
        },
        queryResults
      }
    };
  } catch (error) {
    logger.warn("VictoriaMetrics preview failed", {
      sourceId: source.id,
      error: error.message
    }, "datasources");
    return {
      sourceId: source.id,
      sourceType: source.type,
      sourceName: source.name,
      status: "warning",
      detail: {
        message: error.message
      }
    };
  }
}

async function previewRelational(source, logger = noopLogger) {
  logger.debug("Previewing relational source", {
    sourceId: source.id,
    sampleRowCount: Array.isArray(source.sampleRows) ? source.sampleRows.length : 0
  }, "datasources");
  return {
    sourceId: source.id,
    sourceType: source.type,
    sourceName: source.name,
    status: "ready",
    detail: {
      message: "Using configured sample rows. Swap in a live adapter for production.",
      ...summarizeRows(source.sampleRows ?? [])
    }
  };
}

export async function previewSource(source, options = {}) {
  const logger = options.logger ?? noopLogger;
  switch (source.type) {
    case "json-file":
      return previewJsonFile(source, logger);
    case "victoria-metrics":
      return previewVictoriaMetrics(source, logger);
    case "relational":
      return previewRelational(source, logger);
    default:
      logger.warn("Unsupported source type", {
        sourceId: source.id,
        sourceType: source.type
      }, "datasources");
      return {
        sourceId: source.id,
        sourceType: source.type,
        sourceName: source.name,
        status: "warning",
        detail: {
          message: `Unsupported source type: ${source.type}`
        }
      };
  }
}

export async function gatherDomainContext(domain, dataSources, options = {}) {
  const logger = options.logger ?? noopLogger;
  const applicableSources = dataSources.filter((source) => domain.dataSources.includes(source.id));
  logger.debug("Gathering domain context", {
    domainId: domain.id,
    sourceIds: applicableSources.map((source) => source.id)
  }, "datasources");
  const previews = await Promise.all(applicableSources.map((source) => previewSource(source, { logger })));

  return {
    domainId: domain.id,
    domainName: domain.name,
    previewCount: previews.length,
    previews
  };
}
