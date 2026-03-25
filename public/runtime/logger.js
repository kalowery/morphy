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

function readQueryOverrides() {
  const params = new URLSearchParams(window.location.search);
  return {
    enabled: params.get("morphyLogEnabled"),
    level: params.get("morphyLogLevel"),
    categories: params.get("morphyLogCategories")
  };
}

function readStorageOverrides() {
  try {
    return {
      enabled: window.localStorage.getItem("morphy:log:enabled"),
      level: window.localStorage.getItem("morphy:log:level"),
      categories: window.localStorage.getItem("morphy:log:categories")
    };
  } catch {
    return {
      enabled: null,
      level: null,
      categories: null
    };
  }
}

function resolveDiagnostics(config = {}) {
  const query = readQueryOverrides();
  const storage = readStorageOverrides();
  const enabledSource = query.enabled ?? storage.enabled;
  const enabled = enabledSource != null
    ? !["0", "false", "off"].includes(String(enabledSource).toLowerCase())
    : config.enabled ?? true;

  return {
    enabled,
    level: normalizeLevel(query.level ?? storage.level ?? config.level ?? "info"),
    categories: normalizeCategories(query.categories ?? storage.categories ?? config.categories ?? null),
    maxFieldLength: Number(config.maxFieldLength ?? 240)
  };
}

export function createBrowserLogger(namespace) {
  let diagnostics = resolveDiagnostics({});

  function shouldLog(level, category) {
    if (!diagnostics.enabled) {
      return false;
    }

    if (LEVELS[level] < LEVELS[diagnostics.level]) {
      return false;
    }

    if (!diagnostics.categories) {
      return true;
    }

    return diagnostics.categories.has(namespace) || (category && diagnostics.categories.has(category));
  }

  function emit(level, message, context = null, category = null) {
    if (!shouldLog(level, category)) {
      return;
    }

    const payload = {
      ts: new Date().toISOString(),
      namespace,
      category: category ?? namespace,
      message
    };

    if (context && Object.keys(context).length) {
      payload.context = truncateValue(context, diagnostics.maxFieldLength);
    }

    const prefix = `[Morphy:${level}] ${namespace}${category && category !== namespace ? `/${category}` : ""} ${message}`;

    if (level === "error") {
      console.error(prefix, payload);
    } else if (level === "warn") {
      console.warn(prefix, payload);
    } else if (level === "debug" || level === "trace") {
      console.debug(prefix, payload);
    } else {
      console.info(prefix, payload);
    }
  }

  return {
    update(config = {}) {
      diagnostics = resolveDiagnostics(config);
    },
    trace(message, context = null, category = null) {
      emit("trace", message, context, category);
    },
    debug(message, context = null, category = null) {
      emit("debug", message, context, category);
    },
    info(message, context = null, category = null) {
      emit("info", message, context, category);
    },
    warn(message, context = null, category = null) {
      emit("warn", message, context, category);
    },
    error(message, context = null, category = null) {
      emit("error", message, context, category);
    }
  };
}
