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

function getCount() {
  return entries.length;
}

function onEntry(callback) {
  listener = callback;
}

module.exports = { add, getAll, getCount, onEntry, MAX_ENTRIES };
