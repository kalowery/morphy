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
    emit,
    getState() {
      return currentPayload;
    }
  };

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
    currentPayload = message.payload;

    if (message.type === "init" && initHandler) {
      initHandler(currentPayload);
    }

    if (message.type === "update" && updateHandler) {
      updateHandler(currentPayload);
    }
  });

  emit("widget:bootstrap", {});
})();
