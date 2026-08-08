(() => {
  function classify(response, data) {
    if (response.status === 409) return "conflict";
    if (response.status === 503 && data.outcome === "not_applied") return "not_applied";
    if (response.status === 202 || data.outcome === "unknown" || data.state === "pending" || data.state === "outcome_unknown") return "outcome_unknown";
    if (response.ok) return "committed";
    return "definitive_error";
  }

  async function send(url, options) {
    try {
      const response = await fetch(url, options);
      const data = await response.json().catch(() => ({}));
      return {
        kind: classify(response, data),
        status: response.status,
        data,
        retryAfter: Math.max(1, Number.parseInt(response.headers.get("Retry-After") || "1", 10) || 1),
      };
    } catch (error) {
      return { kind: "network_ambiguous", status: 0, data: { error: error.message }, retryAfter: 1 };
    }
  }

  function storage(scope) {
    const key = `sprinkler.pendingMutation.${scope}.v1`;
    return {
      load() {
        try {
          const value = JSON.parse(sessionStorage.getItem(key));
          return value && typeof value.requestId === "string" && value.payload && typeof value.payload === "object" ? value : null;
        } catch {
          sessionStorage.removeItem(key);
          return null;
        }
      },
      save(value) {
        sessionStorage.setItem(key, JSON.stringify(value));
        return value;
      },
      clear() { sessionStorage.removeItem(key); },
      key,
    };
  }

  function storageEntries(scopePrefix) {
    const keyPrefix = `sprinkler.pendingMutation.${scopePrefix}`;
    const keySuffix = ".v1";
    const entries = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith(keyPrefix) || !key.endsWith(keySuffix)) continue;
      const scope = key.slice("sprinkler.pendingMutation.".length, -keySuffix.length);
      const value = storage(scope).load();
      if (value) entries.push({ scope, value, store: storage(scope) });
    }
    return entries;
  }

  function taskDeleteSemantics(kind) {
    const operationKind = kind === "remove" ? "remove" : "stop";
    const label = operationKind === "remove" ? "Remove" : "Stop";
    return Object.freeze({
      kind: operationKind,
      label,
      progress: operationKind === "remove" ? "Removing" : "Stopping",
      success: operationKind === "remove" ? "Task removed" : "Task stopped",
      conflict: `${label} conflict · task unchanged. Refresh status before a deliberate new ${label}.`,
      pending: `${label} outcome unknown · reconciling. No new ${label} will be sent.`,
      rejected: `${label} rejected · task unchanged. Refresh status before a deliberate new ${label}.`,
      notCommitted: `${label} not committed · retry only this same ${label}.`,
      unresolved: `${label} outcome unknown · check the visible task state. No new ${label} will be sent.`,
      notApplied(seconds) {
        return `Datastore busy · ${label} was not applied. Retry this same ${label} in ${seconds} second${seconds === 1 ? "" : "s"}.`;
      },
      waiting(seconds) {
        return `Datastore busy · wait ${seconds} second${seconds === 1 ? "" : "s"} before retrying this same ${label}.`;
      },
      failed(error) { return `${label} failed · ${error || "request rejected"}. Task unchanged.`; },
    });
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function reconcile(requestId, { attempts = 4, delayMs = 250 } = {}) {
    let missing = true;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await send(`/api/operations/${encodeURIComponent(requestId)}`, { cache: "no-store" });
      if (result.status === 404) {
        if (attempt < attempts - 1) await delay(delayMs);
        continue;
      }
      missing = false;
      if (result.data.state === "rejected") return { ...result, kind: "rejected" };
      if (result.kind === "committed") return result;
      if (result.kind === "outcome_unknown") return result;
      if (result.kind === "network_ambiguous") {
        if (attempt < attempts - 1) await delay(delayMs);
        continue;
      }
      return result;
    }
    return missing
      ? { kind: "not_found", status: 404, data: { recovery: "No durable operation was found. Retry only this same request." } }
      : { kind: "network_ambiguous", status: 0, data: {} };
  }

  window.MutationRecovery = Object.freeze({ classify, send, storage, storageEntries, taskDeleteSemantics, reconcile, delay });
})();
