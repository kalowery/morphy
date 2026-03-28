import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

function stripInlineComment(line) {
  let inString = false;
  let quote = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === quote) {
        inString = false;
        quote = null;
      }

      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "#") {
      return line.slice(0, index);
    }
  }

  return line;
}

function splitTopLevel(value, separator = ",") {
  const parts = [];
  let current = "";
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let quote = null;
  let escaped = false;

  for (const char of value) {
    if (inString) {
      current += char;
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === quote) {
        inString = false;
        quote = null;
      }

      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      current += char;
      continue;
    }

    if (char === "{") {
      braceDepth += 1;
      current += char;
      continue;
    }

    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      current += char;
      continue;
    }

    if (char === "[") {
      bracketDepth += 1;
      current += char;
      continue;
    }

    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += char;
      continue;
    }

    if (char === separator && braceDepth === 0 && bracketDepth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function findTopLevelEquals(line) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let quote = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === quote) {
        inString = false;
        quote = null;
      }

      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") {
      braceDepth += 1;
      continue;
    }

    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (char === "[") {
      bracketDepth += 1;
      continue;
    }

    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }

    if (char === "=" && braceDepth === 0 && bracketDepth === 0) {
      return index;
    }
  }

  return -1;
}

function parseTomlString(value) {
  if (value.startsWith("\"")) {
    return JSON.parse(value);
  }

  return value.slice(1, -1);
}

function parseTomlValue(value) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("\"") || trimmed.startsWith("'")) {
    return parseTomlString(trimmed);
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return {};
    }

    return Object.fromEntries(
      splitTopLevel(inner).map((entry) => {
        const equalsIndex = findTopLevelEquals(entry);
        if (equalsIndex < 0) {
          throw new Error(`Invalid inline table entry: ${entry}`);
        }

        const keyText = entry.slice(0, equalsIndex).trim();
        const parsedKey = keyText.startsWith("\"") || keyText.startsWith("'")
          ? parseTomlString(keyText)
          : keyText;
        const parsedValue = parseTomlValue(entry.slice(equalsIndex + 1));
        return [parsedKey, parsedValue];
      })
    );
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }

    return splitTopLevel(inner).map((entry) => parseTomlValue(entry));
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  return trimmed;
}

function parseProviderSectionId(sectionName) {
  const prefix = "model_providers.";
  if (!sectionName.startsWith(prefix)) {
    return null;
  }

  const remainder = sectionName.slice(prefix.length).trim();
  if (!remainder) {
    return null;
  }

  return remainder.startsWith("\"") || remainder.startsWith("'")
    ? parseTomlString(remainder)
    : remainder;
}

function parseMorphyToml(text) {
  const root = {};
  const providers = {};
  let currentSection = null;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = stripInlineComment(rawLine).trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      currentSection = line.slice(1, -1).trim();
      continue;
    }

    const equalsIndex = findTopLevelEquals(line);
    if (equalsIndex < 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const value = parseTomlValue(line.slice(equalsIndex + 1));
    const providerId = currentSection ? parseProviderSectionId(currentSection) : null;

    if (providerId) {
      providers[providerId] = {
        ...(providers[providerId] ?? {}),
        [key]: value
      };
      continue;
    }

    if (!currentSection) {
      root[key] = value;
    }
  }

  return {
    model: typeof root.model === "string" ? root.model : null,
    modelProvider: typeof root.model_provider === "string" ? root.model_provider : null,
    modelProviders: providers
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function defaultConfigCandidates(projectRoot, env) {
  const candidates = [];

  if (env.MORPHY_CONFIG) {
    candidates.push({
      path: path.resolve(env.MORPHY_CONFIG),
      source: "env"
    });
  }

  candidates.push({
    path: path.join(projectRoot, "morphy.config.toml"),
    source: "project"
  });
  candidates.push({
    path: path.join(projectRoot, "config.toml"),
    source: "project"
  });
  candidates.push({
    path: path.join(os.homedir(), ".morphy", "config.toml"),
    source: "home"
  });

  return candidates;
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value != null && value !== "")
      .map(([key, value]) => [String(key), String(value)])
  );
}

function resolveEnvHeaders(envHeaderMap = {}, env) {
  const headers = {};
  const missing = [];

  for (const [headerName, envVarName] of Object.entries(envHeaderMap ?? {})) {
    const resolvedValue = env?.[String(envVarName)] ?? "";
    if (!resolvedValue) {
      missing.push({
        headerName: String(headerName),
        envVarName: String(envVarName)
      });
      continue;
    }

    headers[String(headerName)] = String(resolvedValue);
  }

  return {
    headers,
    missing
  };
}

function buildOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.length) {
    return response.output_text;
  }

  const chunks = [];
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === "string" && content.text.length) {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n");
}

class ResponsesApiClient {
  constructor({ baseUrl, headers = {}, fetchImpl = fetch }) {
    this.baseUrl = String(baseUrl).endsWith("/")
      ? String(baseUrl)
      : `${String(baseUrl)}/`;
    this.headers = headers;
    this.fetchImpl = fetchImpl;
    this.responses = {
      create: async (body) => this.request("responses", {
        method: "POST",
        body
      }),
      retrieve: async (responseId) => this.request(`responses/${encodeURIComponent(responseId)}`, {
        method: "GET"
      })
    };
  }

  async request(relativePath, { method, body = null }) {
    const response = await this.fetchImpl(new URL(relativePath, this.baseUrl), {
      method,
      headers: {
        Accept: "application/json",
        ...this.headers,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        payload?.error?.message ??
        payload?.message ??
        `${response.status} ${response.statusText}`;
      throw new Error(`AI provider request failed: ${message}`);
    }

    if (payload && typeof payload === "object" && !("output_text" in payload)) {
      return {
        ...payload,
        output_text: buildOutputText(payload)
      };
    }

    return payload;
  }
}

function buildClientHeaders({ selectedProvider, env }) {
  const staticHeaders = normalizeHeaders(selectedProvider?.http_headers ?? {});
  const { headers: envHeaders, missing } = resolveEnvHeaders(selectedProvider?.env_http_headers ?? {}, env);

  return {
    headers: {
      ...staticHeaders,
      ...envHeaders
    },
    missingEnvHeaders: missing
  };
}

export async function loadModelProviderConfig({
  configPath = null,
  projectRoot = process.cwd(),
  env = process.env
} = {}) {
  const explicitPath = configPath ? path.resolve(configPath) : null;
  const candidates = explicitPath
    ? [{ path: explicitPath, source: "cli" }]
    : defaultConfigCandidates(projectRoot, env);

  for (const candidate of candidates) {
    if (!await fileExists(candidate.path)) {
      continue;
    }

    const raw = await fs.readFile(candidate.path, "utf8");
    return {
      path: candidate.path,
      source: candidate.source,
      ...parseMorphyToml(raw)
    };
  }

  return null;
}

export async function resolveAiRuntime({
  configPath = null,
  projectRoot = process.cwd(),
  env = process.env,
  logger = noopLogger
} = {}) {
  const loadedConfig = await loadModelProviderConfig({ configPath, projectRoot, env });

  if (loadedConfig?.modelProvider) {
    const selectedProvider = loadedConfig.modelProviders?.[loadedConfig.modelProvider] ?? null;
    if (!selectedProvider) {
      throw new Error(
        `Morphy model provider config references unknown provider "${loadedConfig.modelProvider}" in ${loadedConfig.path}.`
      );
    }

    const wireApi = selectedProvider.wire_api ?? "responses";
    if (wireApi !== "responses") {
      throw new Error(
        `Morphy only supports wire_api = "responses" today. Received "${wireApi}" for provider "${loadedConfig.modelProvider}".`
      );
    }

    const baseUrl = selectedProvider.base_url ?? null;
    if (!baseUrl) {
      throw new Error(
        `Morphy model provider "${loadedConfig.modelProvider}" is missing base_url in ${loadedConfig.path}.`
      );
    }

    const { headers, missingEnvHeaders } = buildClientHeaders({ selectedProvider, env });
    logger.info("Using Morphy model provider config", {
      configPath: loadedConfig.path,
      providerId: loadedConfig.modelProvider,
      wireApi,
      baseUrl,
      configuredHeaderNames: Object.keys(headers),
      missingEnvHeaderVars: missingEnvHeaders.map((entry) => entry.envVarName)
    }, "server");

    return {
      client: new ResponsesApiClient({ baseUrl, headers }),
      mode: `${loadedConfig.modelProvider}:${wireApi}`,
      billingProvider: `${loadedConfig.modelProvider}:${wireApi}`,
      providerId: loadedConfig.modelProvider,
      providerName: selectedProvider.name ?? loadedConfig.modelProvider,
      wireApi,
      baseUrl,
      model: loadedConfig.model ?? null,
      configPath: loadedConfig.path,
      configSource: loadedConfig.source,
      hasCredentials: Object.keys(headers).length > 0,
      usesConfigFile: true,
      hasApiKey: false
    };
  }

  if (env.OPENAI_API_KEY) {
    logger.info("Using OPENAI_API_KEY for Morphy AI runtime", {}, "server");
    return {
      client: new ResponsesApiClient({
        baseUrl: "https://api.openai.com/v1",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`
        }
      }),
      mode: "openai-responses",
      billingProvider: "openai-responses",
      providerId: "openai",
      providerName: "OpenAI",
      wireApi: "responses",
      baseUrl: "https://api.openai.com/v1",
      model: loadedConfig?.model ?? null,
      configPath: loadedConfig?.path ?? null,
      configSource: loadedConfig?.source ?? null,
      hasCredentials: true,
      usesConfigFile: Boolean(loadedConfig),
      hasApiKey: true
    };
  }

  if (loadedConfig) {
    logger.warn("Morphy config file loaded without an active model provider or OPENAI_API_KEY fallback", {
      configPath: loadedConfig.path
    }, "server");
  }

  return {
    client: null,
    mode: "fallback",
    billingProvider: "local-fallback",
    providerId: null,
    providerName: null,
    wireApi: null,
    baseUrl: null,
    model: loadedConfig?.model ?? null,
    configPath: loadedConfig?.path ?? null,
    configSource: loadedConfig?.source ?? null,
    hasCredentials: false,
    usesConfigFile: Boolean(loadedConfig),
    hasApiKey: false
  };
}
