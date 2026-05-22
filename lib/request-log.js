const MAX_ENTRIES = 1000;

const entries = [];
let listener = null;

function add(entry) {
  entry.timestamp = entry.timestamp || new Date().toISOString();
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.pop();
  if (listener) {
    try { listener(entry); } catch { /* ignore */ }
  }
}

function getAll(limit) {
  return entries.slice(0, limit || MAX_ENTRIES);
}

function getFiltered({ limit, proxyId, status, model } = {}) {
  let result = entries;
  if (proxyId) result = result.filter(e => e.proxyId === proxyId);
  if (status) result = result.filter(e => e.status === status);
  if (model) result = result.filter(e => e.model && e.model.includes(model));
  return result.slice(0, Math.min(Math.max(1, parseInt(limit) || 20), 100));
}

function getCount() {
  return entries.length;
}

function onEntry(callback) {
  listener = callback;
}

module.exports = { add, getAll, getFiltered, getCount, onEntry, MAX_ENTRIES };
