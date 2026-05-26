const fs = require('fs');
const path = require('path');
const os = require('os');

const ENTRY_DELIMITER = '\n§\n';
const SUMMARY_MAX = 50;

// Prompt injection patterns
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /you\s+are\s+now\s+(a|an|the)/i,
  /system\s*:\s*/i,
  /assistant\s*:\s*/i,
  /human\s*:\s*/i,
  /forget\s+(everything|all|what)\s+(you|I)/i,
  /disregard\s+(all|previous|your)/i,
  /\bcurl\b.*\b(http|ftp):\/\//i,
  /\bwget\b.*\b(http|ftp):\/\//i,
  /\bssh\b.*@/i,
  new RegExp("[​‌‍﻿⁠  ]"),  // invisible Unicode
];

function scanForInjection(text) {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) return pattern.toString();
  }
  return null;
}

class MemoryStore {
  constructor(opts = {}) {
    this.memoryCharLimit = opts.memoryCharLimit || 2200;
    this.userCharLimit = opts.userCharLimit || 1375;
    this.baseDir = opts.baseDir || path.join(os.homedir(), '.protocol-proxy');

    // Tier 1: single markdown text (like SOUL.md)
    this._memoryTier1 = '';
    this._userTier1 = '';
    // Tier 2: array of entries with metadata
    this._memoryTier2 = [];  // [{content, createdAt}]
    this._userTier2 = [];
    // Soul
    this._soul = '';
  }

  // ── Paths ──

  get _memoryDir() { return path.join(this.baseDir, 'memory'); }
  get _memTier1Path() { return path.join(this._memoryDir, 'MEMORY_TIER1.md'); }
  get _userTier1Path() { return path.join(this._memoryDir, 'USER_TIER1.md'); }
  get _memTier2Path() { return path.join(this._memoryDir, 'MEMORY_TIER2.json'); }
  get _userTier2Path() { return path.join(this._memoryDir, 'USER_TIER2.json'); }
  // Legacy paths for migration
  get _memoryJsonPath() { return path.join(this._memoryDir, 'MEMORY.json'); }
  get _userJsonPath() { return path.join(this._memoryDir, 'USER.json'); }
  get _memoryMdPath() { return path.join(this._memoryDir, 'MEMORY.md'); }
  get _userMdPath() { return path.join(this._memoryDir, 'USER.md'); }
  get _soulPath() { return path.join(this.baseDir, 'SOUL.md'); }

  // ── Load ──

  loadFromDisk() {
    fs.mkdirSync(this._memoryDir, { recursive: true });

    this._ensureFile(this._memTier1Path);
    this._ensureFile(this._userTier1Path);
    this._ensureFile(this._soulPath);

    this._memoryTier1 = this._readText(this._memTier1Path);
    this._userTier1 = this._readText(this._userTier1Path);
    this._memoryTier2 = this._loadTier2(this._memTier2Path, 'memory');
    this._userTier2 = this._loadTier2(this._userTier2Path, 'user');
    this._soul = this._readText(this._soulPath, 2000);
  }

  /**
   * 加载二级记忆，优先读 TIER2.json，不存在时从旧格式迁移
   */
  _loadTier2(tier2Path, target) {
    // Try TIER2.json first
    if (fs.existsSync(tier2Path)) {
      try {
        const raw = JSON.parse(fs.readFileSync(tier2Path, 'utf8'));
        if (Array.isArray(raw)) {
          return raw.map(e => ({
            content: String(e.content || '').trim(),
            summary: String(e.summary || '').trim(),
            createdAt: e.createdAt || Date.now(),
          })).filter(e => e.content);
        }
      } catch {}
    }

    // Migrate from old MEMORY.json (all entries → tier 2)
    const oldJsonPath = target === 'memory' ? this._memoryJsonPath : this._userJsonPath;
    if (fs.existsSync(oldJsonPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(oldJsonPath, 'utf8'));
        if (Array.isArray(raw)) {
          const entries = raw.map(e => ({
            content: String(e.content || e || '').trim(),
            summary: '',
            createdAt: e.createdAt || Date.now(),
          })).filter(e => e.content);
          // Dedup
          const seen = new Set();
          const deduped = entries.filter(e => { if (seen.has(e.content)) return false; seen.add(e.content); return true; });
          this._writeJson(tier2Path, deduped);
          try { fs.renameSync(oldJsonPath, oldJsonPath + '.bak'); } catch {}
          return deduped;
        }
      } catch {}
    }

    // Migrate from old MEMORY.md (§ delimited → tier 2)
    const oldMdPath = target === 'memory' ? this._memoryMdPath : this._userMdPath;
    if (fs.existsSync(oldMdPath)) {
      try {
        const text = fs.readFileSync(oldMdPath, 'utf8').trim();
        if (text) {
          const entries = [...new Set(text.split(ENTRY_DELIMITER).map(e => e.trim()).filter(Boolean))]
            .map(content => ({ content, summary: '', createdAt: Date.now() }));
          this._writeJson(tier2Path, entries);
          try { fs.renameSync(oldMdPath, oldMdPath + '.bak'); } catch {}
          return entries;
        }
      } catch {}
    }

    return [];
  }

  // ── Tier 1 (single markdown) ──

  loadTier1(target) {
    if (target === 'memory') return this._memoryTier1;
    if (target === 'user') return this._userTier1;
    return '';
  }

  saveTier1(target, content) {
    const maxChars = this._getLimit(target);
    content = (content || '').trim();
    if (content.length > maxChars) {
      return { success: false, error: `超出字符限制 (${content.length}/${maxChars})` };
    }

    const injection = scanForInjection(content);
    if (injection) return { success: false, error: '内容包含潜在的注入模式，已拒绝保存' };
    const filePath = target === 'memory' ? this._memTier1Path : this._userTier1Path;
    const tmpPath = filePath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, filePath);
      if (target === 'memory') this._memoryTier1 = content;
      else this._userTier1 = content;
      return { success: true };
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      try {
        fs.writeFileSync(filePath, content, 'utf8');
        if (target === 'memory') this._memoryTier1 = content;
        else this._userTier1 = content;
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
  }

  // ── Tier 2 (entry list) ──

  addTier2(target, content, summary) {
    const entries = this._resolveTier2(target);
    if (!entries) return { success: false, error: `无效目标 '${target}'` };

    content = content.trim();
    if (!content) return { success: false, error: '内容不能为空' };

    summary = (summary || '').trim();
    if (summary.length > SUMMARY_MAX) summary = summary.slice(0, SUMMARY_MAX);

    const injection = scanForInjection(content);
    if (injection) return { success: false, error: '内容包含潜在的注入模式，已拒绝保存' };

    if (entries.some(e => e.content === content)) {
      return { success: false, error: '该条目已存在（完全重复）' };
    }

    entries.push({ content, summary, createdAt: Date.now() });
    this._saveTier2(target);
    return { success: true, entries: entries.map(e => e.content) };
  }

  replaceTier2(target, oldText, newContent, newSummary) {
    const entries = this._resolveTier2(target);
    if (!entries) return { success: false, error: `无效目标 '${target}'` };
    if (!oldText) return { success: false, error: 'old_text 不能为空' };
    if (!newContent) return { success: false, error: 'content 不能为空' };

    newContent = newContent.trim();
    const injection = scanForInjection(newContent);
    if (injection) return { success: false, error: '内容包含潜在的注入模式，已拒绝保存' };

    const idx = entries.findIndex(e => e.content.includes(oldText));
    if (idx === -1) return { success: false, error: `未找到包含 '${oldText}' 的条目` };

    entries[idx].content = newContent;
    if (newSummary !== undefined) {
      entries[idx].summary = (newSummary || '').trim().slice(0, SUMMARY_MAX);
    }
    this._saveTier2(target);
    return { success: true, entries: entries.map(e => e.content) };
  }

  removeTier2(target, oldText) {
    const entries = this._resolveTier2(target);
    if (!entries) return { success: false, error: `无效目标 '${target}'` };
    if (!oldText) return { success: false, error: 'old_text 不能为空' };

    const idx = entries.findIndex(e => e.content.includes(oldText));
    if (idx === -1) return { success: false, error: `未找到包含 '${oldText}' 的条目` };

    entries.splice(idx, 1);
    this._saveTier2(target);
    return { success: true, entries: entries.map(e => e.content) };
  }

  // ── Read (for prompt building) ──

  renderTier1Block(target) {
    const text = this.loadTier1(target);
    if (!text) return '';
    const label = target === 'memory' ? '经验笔记' : '用户画像';
    const limit = this._getLimit(target);
    const pct = limit ? Math.round(text.length / limit * 100) : 0;
    const header = `═`.repeat(20) + ` ${label} [${pct}% -- ${text.length}/${limit} chars] ` + `═`.repeat(20);
    return `${header}\n${text}`;
  }

  getTier2Index(target) {
    const entries = this._resolveTier2(target);
    if (!entries || !entries.length) return [];
    const label = target === 'memory' ? '经验记忆' : '用户画像';
    return entries.map((e, i) => ({
      idx: i,
      title: e.summary || this._fallbackSummary(e.content),
      label,
    }));
  }

  renderTier2Index(target) {
    const index = this.getTier2Index(target);
    if (!index.length) return '';
    const lines = index.map((e, i) => `- [${e.label} ${i + 1}] ${e.title}`);
    return `二级记忆索引（可通过 read_memory 工具读取详情，参数: target="${target}", index=<编号>）：\n${lines.join('\n')}`;
  }

  getEntryByIndex(target, idx) {
    const entries = this._resolveTier2(target);
    if (!entries || idx < 0 || idx >= entries.length) return null;
    return { idx, content: entries[idx].content, summary: entries[idx].summary, createdAt: entries[idx].createdAt };
  }

  getTier2Entries(target) {
    const entries = this._resolveTier2(target);
    return entries ? entries.map((e, i) => ({ idx: i, content: e.content, summary: e.summary, createdAt: e.createdAt })) : [];
  }

  getTier2Count(target) {
    const entries = this._resolveTier2(target);
    return entries ? entries.length : 0;
  }

  // ── Legacy compat (for existing tool handlers) ──

  loadSoul() { return this._soul; }

  // ── Internal ──

  _resolveTier2(target) {
    if (target === 'memory') return this._memoryTier2;
    if (target === 'user') return this._userTier2;
    return null;
  }

  _getLimit(target) {
    if (target === 'memory') return this.memoryCharLimit;
    if (target === 'user') return this.userCharLimit;
    return 0;
  }

  _fallbackSummary(content) {
    if (!content) return '(空)';
    const firstLine = content.split('\n')[0].trim();
    return firstLine.length > SUMMARY_MAX
      ? firstLine.slice(0, SUMMARY_MAX) + '...'
      : firstLine;
  }

  _ensureFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
    } catch {}
  }

  _readText(filePath, maxChars) {
    try {
      if (!fs.existsSync(filePath)) return '';
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (maxChars && content.length > maxChars) return content.slice(0, maxChars);
      return content;
    } catch {
      return '';
    }
  }

  _saveTier2(target) {
    const filePath = target === 'memory' ? this._memTier2Path : this._userTier2Path;
    const entries = this._resolveTier2(target);
    this._writeJson(filePath, entries);
  }

  _writeJson(filePath, data) {
    const tmpPath = filePath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8'); } catch {}
    }
  }
}

module.exports = { MemoryStore, ENTRY_DELIMITER, scanForInjection };
