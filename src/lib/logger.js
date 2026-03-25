const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100
};

function normalizeLevel(level) {
  const candidate = String(level ?? "info").toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, candidate) ? candidate : "info";
}

function normalizeCategories(categories) {
  if (!categories || categories === "*") {
    return null;
  }

  const values = Array.isArray(categories)
    ? categories
    : String(categories)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);

  return values.length ? new Set(values) : null;
}

function truncateValue(value, maxFieldLength) {
  if (typeof value === "string") {
    return value.length > maxFieldLength
      ? `${value.slice(0, maxFieldLength)}…(${value.length - maxFieldLength} more chars)`
      : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => truncateValue(entry, maxFieldLength));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, truncateValue(entry, maxFieldLength)])
    );
  }

  return value;
}

function shouldLog({ enabled, level, threshold, categories, namespace, category }) {
  if (!enabled) {
    return false;
  }

  if (LEVELS[level] < LEVELS[threshold]) {
    return false;
  }

  if (!categories) {
    return true;
  }

  return categories.has(namespace) || (category && categories.has(category));
}

export function buildServerDiagnostics(appConfig = {}) {
  const config = appConfig.diagnostics?.server ?? {};
  const enabled = process.env.MORPHY_LOG_ENABLED != null
    ? !["0", "false", "off"].includes(String(process.env.MORPHY_LOG_ENABLED).toLowerCase())
    : config.enabled ?? true;
  const level = normalizeLevel(process.env.MORPHY_LOG_LEVEL ?? config.level ?? "info");
  const categories = normalizeCategories(process.env.MORPHY_LOG_CATEGORIES ?? config.categories ?? null);
  const maxFieldLength = Number(process.env.MORPHY_LOG_MAX_FIELD_LENGTH ?? config.maxFieldLength ?? 320);

  return {
    enabled,
    level,
    categories,
    maxFieldLength: Number.isFinite(maxFieldLength) ? maxFieldLength : 320
  };
}

export function createLogger({ namespace, diagnostics }) {
  const resolvedNamespace = namespace || "app";
  const resolvedDiagnostics = diagnostics ?? {
    enabled: true,
    level: "info",
    categories: null,
    maxFieldLength: 320
  };

  function log(level, message, context = null, category = null) {
    const threshold = normalizeLevel(resolvedDiagnostics.level);

    if (!shouldLog({
      enabled: resolvedDiagnostics.enabled,
      level,
      threshold,
      categories: resolvedDiagnostics.categories,
      namespace: resolvedNamespace,
      category
    })) {
      return;
    }

    const entry = {
      ts: new Date().toISOString(),
      level,
      namespace: resolvedNamespace,
      category: category ?? resolvedNamespace,
      message
    };

    if (context && Object.keys(context).length) {
      entry.context = truncateValue(context, resolvedDiagnostics.maxFieldLength);
    }

    const line = JSON.stringify(entry);
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    trace(message, context = null, category = null) {
      log("trace", message, context, category);
    },
    debug(message, context = null, category = null) {
      log("debug", message, context, category);
    },
    info(message, context = null, category = null) {
      log("info", message, context, category);
    },
    warn(message, context = null, category = null) {
      log("warn", message, context, category);
    },
    error(message, context = null, category = null) {
      log("error", message, context, category);
    }
  };
}
