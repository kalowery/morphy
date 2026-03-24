
    const root = document.getElementById("app");

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function formatValue(value) {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return String(value);
      }

      if (Math.abs(value) >= 1000) {
        return value.toLocaleString();
      }

      return value.toFixed(value < 10 ? 2 : 1);
    }

    function render(payload) {
      const report = payload?.report ?? {};
      const chart = report.chart ?? {};
      const labels = Array.isArray(chart.labels) ? chart.labels : [];
      const values = Array.isArray(chart.values) ? chart.values : [];
      const max = Math.max(...values, 1);
      const metricTape = root.querySelector("#metric-tape");
      const vizTarget = root.querySelector("#viz-target");
      const narrativeTarget = root.querySelector("#narrative-target");

      metricTape.innerHTML = labels.slice(0, 4).map((label, index) => `
        <article class="metric">
          <span class="label">${escapeHtml(label)}</span>
          <span class="value">${escapeHtml(formatValue(values[index] ?? ""))}</span>
        </article>
      `).join("");

      vizTarget.innerHTML = labels.length ? `
        <div class="viz-stack">
          ${labels.map((label, index) => {
            const width = Math.max(6, ((values[index] ?? 0) / max) * 100);
            return `
              <div class="viz-row">
                <span>${escapeHtml(label)}</span>
                <div class="bar-track"><div class="bar-fill" style="width: ${width}%"></div></div>
                <strong>${escapeHtml(formatValue(values[index] ?? 0))}</strong>
              </div>
            `;
          }).join("")}
        </div>
      ` : '<p class="summary">No numeric chart data is available for this run.</p>';

      narrativeTarget.innerHTML = `
        ${(report.narrative ?? []).map((entry) => `<p>${escapeHtml(entry)}</p>`).join("")}
        ${(report.highlights ?? []).length ? `<ul>${report.highlights.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>` : ""}
      `;

      window.MorphyBridge.emit("widget:resize", {
        height: Math.ceil(document.documentElement.scrollHeight)
      });
    }

    window.MorphyBridge.onInit(render);
    window.MorphyBridge.onUpdate(render);
    window.MorphyBridge.emit("widget:ready", {
      title: "Fleet Health",
      runId: "d93be204-d796-4aeb-ac37-42b6f5f851b6"
    });
  