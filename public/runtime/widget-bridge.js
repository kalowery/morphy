(function bootstrapMorphyBridge() {
  let initHandler = null;
  let updateHandler = null;
  let currentPayload = window.__MORPHY_PAYLOAD__ ?? null;
  let currentSessionId = null;

  function emit(type, payload) {
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
      if (currentPayload) {
        handler(currentPayload);
      }
    },
    onUpdate(handler) {
      updateHandler = handler;
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

    currentSessionId = message.sessionId;
    currentPayload = message.payload;

    if (message.type === "init" && initHandler) {
      initHandler(currentPayload);
    }

    if (message.type === "update" && updateHandler) {
      updateHandler(currentPayload);
    }
  });

  emit("widget:bootstrap", {
    href: window.location.href
  });
})();
