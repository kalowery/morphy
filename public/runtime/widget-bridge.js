(function bootstrapMorphyBridge() {
  function diagnosticsEnabled() {
    const params = new URLSearchParams(window.location.search);
    const enabled = params.get("morphyLogEnabled");
    const level = params.get("morphyLogLevel");
    const categories = params.get("morphyLogCategories");
    let storageEnabled = null;
    let storageLevel = null;
    let storageCategories = null;

    try {
      storageEnabled = window.localStorage.getItem("morphy:log:enabled");
      storageLevel = window.localStorage.getItem("morphy:log:level");
      storageCategories = window.localStorage.getItem("morphy:log:categories");
    } catch {
      storageEnabled = null;
      storageLevel = null;
      storageCategories = null;
    }

    const finalEnabled = enabled ?? storageEnabled;
    const finalLevel = String(level ?? storageLevel ?? "info").toLowerCase();
    const finalCategories = String(categories ?? storageCategories ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);

    return {
      enabled: finalEnabled == null ? true : !["0", "false", "off"].includes(String(finalEnabled).toLowerCase()),
      level: finalLevel,
      categories: finalCategories
    };
  }

  function log(level, message, context) {
    const diagnostics = diagnosticsEnabled();
    const ranks = {
      trace: 10,
      debug: 20,
      info: 30,
      warn: 40,
      error: 50
    };

    if (!diagnostics.enabled) {
      return;
    }

    if ((ranks[level] ?? 30) < (ranks[diagnostics.level] ?? 30)) {
      return;
    }

    if (diagnostics.categories.length && !diagnostics.categories.includes("widgets") && !diagnostics.categories.includes("bridge")) {
      return;
    }

    const payload = {
      ts: new Date().toISOString(),
      message,
      context
    };

    if (level === "error") {
      console.error("[Morphy widget bridge]", payload);
    } else if (level === "warn") {
      console.warn("[Morphy widget bridge]", payload);
    } else {
      console.debug("[Morphy widget bridge]", payload);
    }
  }

  let initHandler = null;
  let updateHandler = null;
  let currentPayload = window.__MORPHY_PAYLOAD__ ?? null;
  let currentSessionId = null;
  let nextRequestId = 1;
  const pendingRequests = new Map();
  let lastInteractionAt = 0;

  function emit(type, payload) {
    log("trace", "Emitting widget bridge event", {
      type,
      sessionId: currentSessionId
    });
    window.parent.postMessage(
      {
        source: "morphy-widget",
        type,
        sessionId: currentSessionId,
        payload
      },
      "*"
    );
  }

  window.MorphyBridge = {
    onInit(handler) {
      initHandler = handler;
      log("debug", "Registered onInit handler", {
        hasInitialPayload: Boolean(currentPayload)
      });
      if (currentPayload) {
        handler(currentPayload);
      }
    },
    onUpdate(handler) {
      updateHandler = handler;
      log("debug", "Registered onUpdate handler", {});
    },
    requestData(params) {
      const requestId = `req-${Date.now()}-${nextRequestId++}`;
      emit("widget:request-data", {
        requestId,
        params
      });

      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error("Widget data request timed out."));
        }, 20000);

        pendingRequests.set(requestId, {
          resolve,
          reject,
          timeout
        });
      });
    },
    requestInterpretation(params) {
      const requestId = `req-${Date.now()}-${nextRequestId++}`;
      emit("widget:request-interpretation", {
        requestId,
        params
      });

      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error("Widget reinterpretation is still running. Please wait for the response."));
        }, 90000);

        pendingRequests.set(requestId, {
          resolve,
          reject,
          timeout
        });
      });
    },
    emit,
    getState() {
      return currentPayload;
    }
  };

  function emitInteractionHeartbeat() {
    const now = Date.now();
    if (now - lastInteractionAt < 1000) {
      return;
    }
    lastInteractionAt = now;
    emit("widget:interaction", {
      ts: new Date(now).toISOString()
    });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;

    if (!message || message.source !== "morphy-host") {
      return;
    }

    log("trace", "Received host message", {
      type: message.type,
      sessionId: message.sessionId ?? null
    });
    currentSessionId = message.sessionId;
    currentPayload = {
      ...(currentPayload ?? {}),
      ...(message.payload ?? {}),
      interaction: message.payload?.interaction ?? currentPayload?.interaction ?? null
    };

    if (message.type === "widget:data-response" || message.type === "widget:reinterpretation-response") {
      const interaction = message.payload?.interaction ?? null;
      if (interaction) {
        currentPayload = {
          ...(currentPayload ?? {}),
          interaction,
          report: interaction.data?.report
            ? {
                ...((currentPayload ?? {}).report ?? {}),
                ...interaction.data.report,
                chart: interaction.data?.chart ?? interaction.data.report?.chart ?? ((currentPayload ?? {}).report ?? {}).chart ?? null,
                narrative: interaction.data.report?.narrative?.length
                  ? interaction.data.report.narrative
                  : (((currentPayload ?? {}).report ?? {}).narrative ?? []),
                highlights: interaction.data.report?.highlights?.length
                  ? interaction.data.report.highlights
                  : (((currentPayload ?? {}).report ?? {}).highlights ?? []),
                details: interaction.data.report?.details?.length
                  ? interaction.data.report.details
                  : (((currentPayload ?? {}).report ?? {}).details ?? [])
              }
            : (currentPayload ?? {}).report ?? null,
          context: {
            ...((currentPayload ?? {}).context ?? {}),
            coverage: interaction.data?.coverage ?? ((currentPayload ?? {}).context ?? {}).coverage ?? null,
            findings: interaction.data?.findings ?? interaction.data?.localFindings?.findings ?? ((currentPayload ?? {}).context ?? {}).findings ?? null
          }
        };
      }
      const requestId = message.requestId ?? null;
      const pending = requestId ? pendingRequests.get(requestId) : null;
      if (pending) {
        window.clearTimeout(pending.timeout);
        pendingRequests.delete(requestId);
        pending.resolve(currentPayload);
      }
      if (updateHandler) {
        updateHandler(currentPayload);
      } else if (initHandler) {
        initHandler(currentPayload);
      }
      return;
    }

    if (message.type === "widget:data-error" || message.type === "widget:reinterpretation-error") {
      const requestId = message.requestId ?? null;
      const pending = requestId ? pendingRequests.get(requestId) : null;
      if (pending) {
        window.clearTimeout(pending.timeout);
        pendingRequests.delete(requestId);
        pending.reject(new Error(message.payload?.error ?? "Widget interaction request failed."));
      }
      return;
    }

    if (message.type === "init" && initHandler) {
      initHandler(currentPayload);
    }

    if (message.type === "update" && updateHandler) {
      updateHandler(currentPayload);
    }
  });

  window.addEventListener("focusin", () => {
    emitInteractionHeartbeat();
  });

  window.addEventListener("input", () => {
    emitInteractionHeartbeat();
  });

  window.addEventListener("change", () => {
    emitInteractionHeartbeat();
  });

  emit("widget:bootstrap", {});
})();
