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

function quoteSqlIdentifier(identifier) {
  return `"${String(identifier).replaceAll("\"", "\"\"")}"`;
}

function sqlConnectionConfig(source) {
  return {
    engine: source.engine ?? source.connection?.engine ?? "unknown",
    databasePath: source.databasePath ?? source.connection?.databasePath ?? null,
    connectionString: source.connectionString ?? source.connection?.connectionString ?? null,
    options: source.options ?? source.connection?.options ?? {}
  };
}

function buildSqlPreviewQueryFromSchema(schemaRows, rowLimit = 25) {
  const firstTable = schemaRows.find((row) => row?.table_name);

  if (!firstTable) {
    return null;
  }

  const tableName = firstTable.table_schema && firstTable.table_schema !== "main"
    ? `${quoteSqlIdentifier(firstTable.table_schema)}.${quoteSqlIdentifier(firstTable.table_name)}`
    : quoteSqlIdentifier(firstTable.table_name);

  return `select * from ${tableName} limit ${Math.max(1, Number(rowLimit) || 25)}`;
}

function summarizeSqlSchema(schemaRows = [], columnRows = []) {
  const tables = [];
  const seenTables = new Set();

  for (const row of schemaRows) {
    const schemaName = row?.table_schema ?? row?.schema_name ?? "main";
    const tableName = row?.table_name ?? row?.name;

    if (!tableName) {
      continue;
    }

    const key = `${schemaName}.${tableName}`;
    if (seenTables.has(key)) {
      continue;
    }

    seenTables.add(key);
    tables.push({
      schema: schemaName,
      table: tableName
    });
  }

  const columns = columnRows
    .filter((row) => row?.column_name)
    .slice(0, 60)
    .map((row) => ({
      schema: row.table_schema ?? row.schema_name ?? "main",
      table: row.table_name ?? row.table ?? null,
      name: row.column_name,
      type: row.data_type ?? row.column_type ?? row.type_name ?? null
    }));

  return {
    tableCount: tables.length,
    tables: tables.slice(0, 20),
    columns
  };
}

let duckDbModulePromise = null;

async function loadDuckDbModule() {
  if (!duckDbModulePromise) {
    duckDbModulePromise = import("@duckdb/node-api");
  }

  return duckDbModulePromise;
}

async function withDuckDbConnection(source, logger, handler) {
  const { DuckDBInstance } = await loadDuckDbModule();
  const connectionConfig = sqlConnectionConfig(source);
  const databasePath = connectionConfig.databasePath ?? ":memory:";
  logger.debug("Opening DuckDB SQL source", {
    sourceId: source.id,
    databasePath
  }, "datasources");
  const instance = await DuckDBInstance.fromCache(databasePath, connectionConfig.options);
  const connection = await instance.connect();

  try {
    return await handler(connection, databasePath);
  } finally {
    connection.closeSync();
  }
}

async function runDuckDbQuery(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjectsJson();
}

let sqliteModulePromise = null;

async function loadSqliteModule() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import("node:sqlite");
  }

  return sqliteModulePromise;
}

async function withSqliteDatabase(source, logger, handler) {
  const { DatabaseSync } = await loadSqliteModule();
  const connectionConfig = sqlConnectionConfig(source);
  const databasePath = connectionConfig.databasePath ?? ":memory:";
  logger.debug("Opening SQLite SQL source", {
    sourceId: source.id,
    databasePath
  }, "datasources");
  const database = new DatabaseSync(databasePath, {
    open: true,
    readOnly: false
  });

  try {
    return await handler(database, databasePath);
  } finally {
    database.close();
  }
}

function runSqliteQuery(database, sql) {
  return database.prepare(sql).all();
}

function summarizeSqliteSchema(tableRows = [], columnRows = []) {
  const tables = tableRows
    .filter((row) => row?.table_name)
    .map((row) => ({
      schema: "main",
      table: row.table_name
    }));

  const columns = columnRows
    .filter((row) => row?.column_name)
    .slice(0, 60)
    .map((row) => ({
      schema: "main",
      table: row.table_name ?? null,
      name: row.column_name,
      type: row.data_type ?? null
    }));

  return {
    tableCount: tables.length,
    tables: tables.slice(0, 20),
    columns
  };
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

async function previewSql(source, logger = noopLogger) {
  const connectionConfig = sqlConnectionConfig(source);
  const engine = connectionConfig.engine;

  if (!engine || engine === "unknown") {
    return {
      sourceId: source.id,
      sourceType: source.type,
      sourceName: source.name,
      status: "warning",
      detail: {
        message: "SQL source is missing an engine. Configure engine: \"duckdb\" or another supported SQL engine."
      }
    };
  }

  switch (engine) {
    case "duckdb":
      return previewDuckDb(source, logger);
    case "sqlite":
      return previewSqlite(source, logger);
    default:
      logger.warn("Unsupported SQL engine", {
        sourceId: source.id,
        engine
      }, "datasources");
      return {
        sourceId: source.id,
        sourceType: source.type,
        sourceName: source.name,
        status: "warning",
        detail: {
          message: `Unsupported SQL engine: ${engine}. Add a connector for this engine to enable live previews.`
        }
      };
  }
}

async function previewDuckDb(source, logger = noopLogger) {
  const connectionConfig = sqlConnectionConfig(source);
  const schemaQuery = source.schemaQuery
    ?? "select table_schema, table_name from information_schema.tables where table_schema not in ('information_schema', 'pg_catalog') order by 1, 2 limit 50";
  const columnsQuery = source.columnsQuery
    ?? "select table_schema, table_name, column_name, data_type from information_schema.columns where table_schema not in ('information_schema', 'pg_catalog') order by 1, 2, ordinal_position limit 200";
  const rowCountQuery = source.rowCountQuery ?? null;

  try {
    return await withDuckDbConnection(source, logger, async (connection, databasePath) => {
      const schemaRows = await runDuckDbQuery(connection, schemaQuery);
      const columnRows = await runDuckDbQuery(connection, columnsQuery);
      const previewQuery = source.previewQuery
        ?? buildSqlPreviewQueryFromSchema(schemaRows, source.previewRowLimit ?? 25);

      if (!previewQuery) {
        return {
          sourceId: source.id,
          sourceType: source.type,
          sourceName: source.name,
          status: "warning",
          detail: {
            message: "DuckDB preview could not infer a table to sample. Configure previewQuery explicitly.",
            engine: "duckdb",
            connection: {
              databasePath
            },
            schema: summarizeSqlSchema(schemaRows, columnRows)
          }
        };
      }

      const previewRows = await runDuckDbQuery(connection, previewQuery);
      const rowCountRows = rowCountQuery ? await runDuckDbQuery(connection, rowCountQuery) : [];
      const configuredRowCount = Number(rowCountRows?.[0]?.row_count ?? rowCountRows?.[0]?.count ?? 0);
      const detail = summarizeRows(previewRows);
      const schema = summarizeSqlSchema(schemaRows, columnRows);

      logger.info("SQL preview ready", {
        sourceId: source.id,
        engine: "duckdb",
        databasePath,
        tableCount: schema.tableCount,
        previewRowCount: detail.rowCount
      }, "datasources");

      return {
        sourceId: source.id,
        sourceType: source.type,
        sourceName: source.name,
        status: "ready",
        detail: {
          message: "Live SQL preview executed successfully.",
          engine: "duckdb",
          connection: {
            databasePath
          },
          executedQueries: {
            schemaQuery,
            columnsQuery,
            previewQuery,
            rowCountQuery
          },
          schema,
          rowCount: Number.isFinite(configuredRowCount) && configuredRowCount > 0 ? configuredRowCount : detail.rowCount,
          metrics: detail.metrics,
          sample: detail.sample ?? [],
          previewRowCount: detail.rowCount
        }
      };
    });
  } catch (error) {
    logger.warn("DuckDB preview failed", {
      sourceId: source.id,
      error: error.message
    }, "datasources");
    return {
      sourceId: source.id,
      sourceType: source.type,
      sourceName: source.name,
      status: "warning",
      detail: {
        message: error.message,
        engine: "duckdb",
        connection: {
          databasePath: connectionConfig.databasePath ?? ":memory:"
        }
      }
    };
  }
}

async function previewSqlite(source, logger = noopLogger) {
  const connectionConfig = sqlConnectionConfig(source);
  const schemaQuery = source.schemaQuery
    ?? "select name as table_name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by 1 limit 50";

  try {
    return await withSqliteDatabase(source, logger, async (database, databasePath) => {
      const tableRows = runSqliteQuery(database, schemaQuery);
      const tableNames = tableRows
        .map((row) => row.table_name)
        .filter((tableName) => typeof tableName === "string" && tableName.length);

      const columnRows = tableNames.flatMap((tableName) =>
        runSqliteQuery(database, `select '${tableName}' as table_name, name as column_name, type as data_type from pragma_table_info('${String(tableName).replaceAll("'", "''")}')`)
      );
      const previewQuery = source.previewQuery
        ?? (tableNames[0] ? `select * from ${quoteSqlIdentifier(tableNames[0])} limit ${Math.max(1, Number(source.previewRowLimit) || 25)}` : null);
      const rowCountQuery = source.rowCountQuery
        ?? (tableNames[0] ? `select count(*) as row_count from ${quoteSqlIdentifier(tableNames[0])}` : null);

      if (!previewQuery) {
        return {
          sourceId: source.id,
          sourceType: source.type,
          sourceName: source.name,
          status: "warning",
          detail: {
            message: "SQLite preview could not infer a table to sample. Configure previewQuery explicitly.",
            engine: "sqlite",
            connection: {
              databasePath
            },
            schema: summarizeSqliteSchema(tableRows, columnRows)
          }
        };
      }

      const previewRows = runSqliteQuery(database, previewQuery);
      const rowCountRows = rowCountQuery ? runSqliteQuery(database, rowCountQuery) : [];
      const configuredRowCount = Number(rowCountRows?.[0]?.row_count ?? rowCountRows?.[0]?.count ?? 0);
      const detail = summarizeRows(previewRows);
      const schema = summarizeSqliteSchema(tableRows, columnRows);

      logger.info("SQL preview ready", {
        sourceId: source.id,
        engine: "sqlite",
        databasePath,
        tableCount: schema.tableCount,
        previewRowCount: detail.rowCount
      }, "datasources");

      return {
        sourceId: source.id,
        sourceType: source.type,
        sourceName: source.name,
        status: "ready",
        detail: {
          message: "Live SQL preview executed successfully.",
          engine: "sqlite",
          connection: {
            databasePath
          },
          executedQueries: {
            schemaQuery,
            previewQuery,
            rowCountQuery
          },
          schema,
          rowCount: Number.isFinite(configuredRowCount) && configuredRowCount > 0 ? configuredRowCount : detail.rowCount,
          metrics: detail.metrics,
          sample: detail.sample ?? [],
          previewRowCount: detail.rowCount
        }
      };
    });
  } catch (error) {
    logger.warn("SQLite preview failed", {
      sourceId: source.id,
      error: error.message
    }, "datasources");
    return {
      sourceId: source.id,
      sourceType: source.type,
      sourceName: source.name,
      status: "warning",
      detail: {
        message: error.message,
        engine: "sqlite",
        connection: {
          databasePath: connectionConfig.databasePath ?? ":memory:"
        }
      }
    };
  }
}

export async function previewSource(source, options = {}) {
  const logger = options.logger ?? noopLogger;
  const effectiveSource = {
    ...source,
    ...(options.overrides ?? {})
  };
  switch (source.type) {
    case "json-file":
      return previewJsonFile(effectiveSource, logger);
    case "victoria-metrics":
      return previewVictoriaMetrics(effectiveSource, logger);
    case "sql":
      return previewSql(effectiveSource, logger);
    case "relational":
      return previewRelational(effectiveSource, logger);
    default:
      logger.warn("Unsupported source type", {
        sourceId: effectiveSource.id,
        sourceType: effectiveSource.type
      }, "datasources");
      return {
        sourceId: effectiveSource.id,
        sourceType: effectiveSource.type,
        sourceName: effectiveSource.name,
        status: "warning",
        detail: {
          message: `Unsupported source type: ${effectiveSource.type}`
        }
      };
  }
}

export async function gatherDomainContext(domain, dataSources, options = {}) {
  const logger = options.logger ?? noopLogger;
  const sourceOverrides = options.sourceOverrides ?? {};
  const applicableSources = dataSources.filter((source) => domain.dataSources.includes(source.id));
  logger.debug("Gathering domain context", {
    domainId: domain.id,
    sourceIds: applicableSources.map((source) => source.id)
  }, "datasources");
  const previews = await Promise.all(
    applicableSources.map((source) =>
      previewSource(source, {
        logger,
        overrides: sourceOverrides[source.id] ?? {}
      })
    )
  );

  return {
    domainId: domain.id,
    domainName: domain.name,
    previewCount: previews.length,
    previews
  };
}
