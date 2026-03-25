import crypto from "node:crypto";

function roundUsd(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
}

function emptyTokenSummary() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    visibleOutputTokens: 0,
    totalTokens: 0
  };
}

function emptyCostSummary() {
  return {
    inputUsd: 0,
    cachedInputUsd: 0,
    outputUsd: 0,
    reasoningOutputUsd: 0,
    visibleOutputUsd: 0,
    totalUsd: 0
  };
}

export function normalizeUsage(usage = {}) {
  const inputTokens = Number(
    usage.input_tokens ??
      usage.inputTokens ??
      usage.prompt_tokens ??
      0
  );
  const cachedInputTokens = Number(
    usage.input_tokens_details?.cached_tokens ??
      usage.cachedInputTokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      usage.cached_input_tokens ??
      0
  );
  const outputTokens = Number(
    usage.output_tokens ??
      usage.outputTokens ??
      usage.completion_tokens ??
      0
  );
  const reasoningTokens = Number(
    usage.output_tokens_details?.reasoning_tokens ??
      usage.reasoningTokens ??
      usage.completion_tokens_details?.reasoning_tokens ??
      0
  );
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const visibleOutputTokens = Math.max(0, outputTokens - reasoningTokens);
  const totalTokens = Number(
    usage.total_tokens ??
      usage.totalTokens ??
      inputTokens + outputTokens
  );

  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    reasoningTokens,
    visibleOutputTokens,
    totalTokens
  };
}

export function normalizePricingTable(appConfig = {}) {
  return {
    currency: appConfig.billing?.currency ?? "USD",
    models: appConfig.billing?.models ?? {}
  };
}

export function resolveModelPricing(appConfig = {}, modelName) {
  const pricingTable = normalizePricingTable(appConfig);
  const models = pricingTable.models ?? {};

  if (!modelName) {
    return null;
  }

  if (models[modelName]) {
    return {
      model: modelName,
      pricing: models[modelName],
      currency: pricingTable.currency
    };
  }

  const keys = Object.keys(models).sort((left, right) => right.length - left.length);
  const matchedKey = keys.find((key) => modelName === key || modelName.startsWith(`${key}-`) || modelName.startsWith(`${key}:`));

  if (!matchedKey) {
    return null;
  }

  return {
    model: matchedKey,
    pricing: models[matchedKey],
    currency: pricingTable.currency
  };
}

export function calculateCostSummary(pricingRecord, usage) {
  const normalizedUsage = normalizeUsage(usage);

  if (!pricingRecord?.pricing) {
    return {
      currency: pricingRecord?.currency ?? "USD",
      priced: false,
      ...emptyCostSummary()
    };
  }

  const inputUsd = (normalizedUsage.uncachedInputTokens / 1_000_000) * Number(pricingRecord.pricing.inputPer1M ?? 0);
  const cachedInputUsd = (normalizedUsage.cachedInputTokens / 1_000_000) * Number(pricingRecord.pricing.cachedInputPer1M ?? 0);
  const outputUsd = (normalizedUsage.outputTokens / 1_000_000) * Number(pricingRecord.pricing.outputPer1M ?? 0);
  const reasoningOutputUsd = (normalizedUsage.reasoningTokens / 1_000_000) * Number(pricingRecord.pricing.outputPer1M ?? 0);
  const visibleOutputUsd = Math.max(0, outputUsd - reasoningOutputUsd);
  const totalUsd = inputUsd + cachedInputUsd + outputUsd;

  return {
    currency: pricingRecord.currency,
    priced: true,
    inputUsd: roundUsd(inputUsd),
    cachedInputUsd: roundUsd(cachedInputUsd),
    outputUsd: roundUsd(outputUsd),
    reasoningOutputUsd: roundUsd(reasoningOutputUsd),
    visibleOutputUsd: roundUsd(visibleOutputUsd),
    totalUsd: roundUsd(totalUsd)
  };
}

function accumulateUsage(target, usage) {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.uncachedInputTokens += usage.uncachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningTokens += usage.reasoningTokens;
  target.visibleOutputTokens += usage.visibleOutputTokens;
  target.totalTokens += usage.totalTokens;
}

function accumulateCost(target, cost) {
  target.inputUsd = roundUsd(target.inputUsd + cost.inputUsd);
  target.cachedInputUsd = roundUsd(target.cachedInputUsd + cost.cachedInputUsd);
  target.outputUsd = roundUsd(target.outputUsd + cost.outputUsd);
  target.reasoningOutputUsd = roundUsd(target.reasoningOutputUsd + cost.reasoningOutputUsd);
  target.visibleOutputUsd = roundUsd(target.visibleOutputUsd + cost.visibleOutputUsd);
  target.totalUsd = roundUsd(target.totalUsd + cost.totalUsd);
}

function aggregateEntry(map, key, createBase, entry) {
  if (!key) {
    return;
  }

  if (!map.has(key)) {
    map.set(key, {
      ...createBase(),
      usage: emptyTokenSummary(),
      cost: emptyCostSummary(),
      entries: 0
    });
  }

  const bucket = map.get(key);
  bucket.entries += 1;
  accumulateUsage(bucket.usage, entry.usage);
  accumulateCost(bucket.cost, entry.cost);
}

function serializeBuckets(map, sortField = "totalUsd") {
  return Array.from(map.values()).sort((left, right) => {
    if (sortField === "totalUsd") {
      return right.cost.totalUsd - left.cost.totalUsd;
    }
    return right.entries - left.entries;
  });
}

export function summarizeLedger(entries = [], appConfig = {}) {
  const pricingTable = normalizePricingTable(appConfig);
  const totals = {
    currency: pricingTable.currency,
    usage: emptyTokenSummary(),
    cost: emptyCostSummary(),
    entries: 0,
    pricedEntries: 0,
    unpricedEntries: 0
  };
  const byModel = new Map();
  const byOperation = new Map();
  const byPanel = new Map();
  const byPanelArchetype = new Map();
  const byArchetype = new Map();

  for (const entry of entries) {
    const effectiveCost =
      entry.cost?.totalUsd || entry.cost?.inputUsd || entry.cost?.outputUsd || entry.cost?.cachedInputUsd
        ? entry.cost
        : calculateCostSummary(resolveModelPricing(appConfig, entry.model), entry.usage);
    const effectiveEntry = {
      ...entry,
      usage: normalizeUsage(entry.usage ?? {}),
      cost: effectiveCost
    };
    totals.entries += 1;
    accumulateUsage(totals.usage, effectiveEntry.usage ?? emptyTokenSummary());
    accumulateCost(totals.cost, effectiveEntry.cost ?? emptyCostSummary());
    if (effectiveEntry.cost?.priced) {
      totals.pricedEntries += 1;
    } else {
      totals.unpricedEntries += 1;
    }

    aggregateEntry(
      byModel,
      entry.model,
      () => ({
        model: effectiveEntry.model,
        currency: pricingTable.currency
      }),
      effectiveEntry
    );
    aggregateEntry(
      byOperation,
      entry.operation,
      () => ({
        operation: effectiveEntry.operation,
        currency: pricingTable.currency
      }),
      effectiveEntry
    );
    aggregateEntry(
      byPanel,
      effectiveEntry.panelId ? `${effectiveEntry.domainId ?? "global"}:${effectiveEntry.panelId}` : null,
      () => ({
        domainId: effectiveEntry.domainId ?? null,
        panelId: effectiveEntry.panelId,
        panelTitle: effectiveEntry.panelTitle ?? effectiveEntry.panelId,
        currency: pricingTable.currency
      }),
      effectiveEntry
    );
    aggregateEntry(
      byPanelArchetype,
      effectiveEntry.panelId ? `${effectiveEntry.domainId ?? "global"}:${effectiveEntry.panelId}:${effectiveEntry.archetypeId ?? "none"}` : null,
      () => ({
        domainId: effectiveEntry.domainId ?? null,
        panelId: effectiveEntry.panelId,
        panelTitle: effectiveEntry.panelTitle ?? effectiveEntry.panelId,
        archetypeId: effectiveEntry.archetypeId ?? null,
        archetypeTitle: effectiveEntry.archetypeTitle ?? null,
        currency: pricingTable.currency
      }),
      effectiveEntry
    );
    aggregateEntry(
      byArchetype,
      effectiveEntry.archetypeId,
      () => ({
        archetypeId: effectiveEntry.archetypeId,
        archetypeTitle: effectiveEntry.archetypeTitle ?? effectiveEntry.archetypeId,
        currency: pricingTable.currency
      }),
      effectiveEntry
    );
  }

  return {
    currency: pricingTable.currency,
    updatedAt: new Date().toISOString(),
    totals,
    byModel: serializeBuckets(byModel),
    byOperation: serializeBuckets(byOperation),
    byPanel: serializeBuckets(byPanel),
    byPanelArchetype: serializeBuckets(byPanelArchetype),
    byArchetype: serializeBuckets(byArchetype),
    recentEntries: entries.slice(0, 20)
  };
}

export class BillingTracker {
  constructor({ configStore, eventBus, logger }) {
    this.configStore = configStore;
    this.eventBus = eventBus;
    this.logger = logger ?? {
      debug() {},
      info() {},
      warn() {},
      error() {}
    };
  }

  async getLedger() {
    return this.configStore.getBillingLedger();
  }

  async getSummary() {
    const [ledger, appConfig] = await Promise.all([
      this.getLedger(),
      this.configStore.getAppConfig()
    ]);
    return summarizeLedger(ledger.entries ?? [], appConfig);
  }

  async repairLedgerCosts() {
    const [ledger, appConfig] = await Promise.all([
      this.getLedger(),
      this.configStore.getAppConfig()
    ]);
    let updated = false;
    const entries = (ledger.entries ?? []).map((entry) => {
      const recalculated = calculateCostSummary(resolveModelPricing(appConfig, entry.model), entry.usage);
      const hasNonZeroCost =
        Number(entry.cost?.totalUsd ?? 0) > 0 ||
        Number(entry.cost?.inputUsd ?? 0) > 0 ||
        Number(entry.cost?.outputUsd ?? 0) > 0 ||
        Number(entry.cost?.cachedInputUsd ?? 0) > 0;

      if (hasNonZeroCost || !recalculated.priced) {
        return entry;
      }

      updated = true;
      return {
        ...entry,
        usage: normalizeUsage(entry.usage ?? {}),
        cost: recalculated
      };
    });

    if (!updated) {
      return null;
    }

    const nextLedger = {
      updatedAt: new Date().toISOString(),
      entries
    };
    await this.configStore.saveBillingLedger(nextLedger);
    const summary = summarizeLedger(entries, appConfig);
    this.eventBus?.emit("spend.update", summary);
    this.logger.info("Repaired ledger costs", {
      entryCount: entries.length,
      totalUsd: summary.totals.cost.totalUsd
    }, "billing");
    return summary;
  }

  async resetLedger() {
    const nextLedger = {
      updatedAt: new Date().toISOString(),
      entries: []
    };
    await this.configStore.saveBillingLedger(nextLedger);
    const appConfig = await this.configStore.getAppConfig();
    const summary = summarizeLedger([], appConfig);
    this.eventBus?.emit("spend.update", summary);
    this.logger.info("Reset billing ledger", {}, "billing");
    return summary;
  }

  async recordResponseUsage({
    response,
    model,
    operation,
    provider = "openai-responses",
    domainId = null,
    panelId = null,
    panelTitle = null,
    archetypeId = null,
    archetypeTitle = null,
    runId = null
  }) {
    const usage = normalizeUsage(response?.usage ?? {});
    if (!(usage.inputTokens || usage.outputTokens || usage.cachedInputTokens)) {
      return null;
    }

    const [ledger, appConfig] = await Promise.all([
      this.getLedger(),
      this.configStore.getAppConfig()
    ]);
    const resolvedModel = model ?? response?.model ?? "unknown";
    const pricingRecord = resolveModelPricing(appConfig, resolvedModel);
    const cost = calculateCostSummary(pricingRecord, usage);
    const entry = {
      id: crypto.randomUUID(),
      recordedAt: new Date().toISOString(),
      provider,
      model: resolvedModel,
      pricingModel: pricingRecord?.model ?? null,
      operation,
      domainId,
      panelId,
      panelTitle,
      archetypeId,
      archetypeTitle,
      runId,
      remoteResponseId: response?.id ?? null,
      usage,
      cost
    };

    const nextEntries = [entry, ...(ledger.entries ?? [])].slice(0, 5000);
    const nextLedger = {
      updatedAt: entry.recordedAt,
      entries: nextEntries
    };
    await this.configStore.saveBillingLedger(nextLedger);
    const summary = summarizeLedger(nextEntries, appConfig);
    this.eventBus?.emit("spend.update", summary);
    this.logger.info("Recorded model usage cost", {
      operation,
      model: resolvedModel,
      runId,
      panelId,
      totalUsd: cost.totalUsd
    }, "billing");
    return entry;
  }
}
