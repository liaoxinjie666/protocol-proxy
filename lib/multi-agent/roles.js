/**
 * 子代理角色系统
 * 每个角色定义：系统提示词后缀、工具过滤策略、沙盒模式
 *
 * sandboxMode:
 *   'standard'   — 按全局配置的 blocked/auto-deny 执行（默认）
 *   'readonly'   — 写操作工具自动拒绝，execute_command 禁用
 *   'project'    — 允许写入项目目录，execute_command 由执行策略引擎控制
 */

const ROLES = {
  general: {
    name: 'general',
    description: '通用任务，使用全局配置的工具权限',
    systemPromptSuffix: '',
    // 不覆盖工具策略，完全使用全局配置
    extraBlockedTools: [],
    extraAutoDenyTools: [],
    sandboxMode: 'standard',
  },

  explore: {
    name: 'explore',
    description: '探索、搜索、只读分析。适合文件搜索、代码分析、日志查看',
    systemPromptSuffix:
      '\n你是一个探索型子代理，专注于搜索和分析。你只有只读权限，无法修改任何文件或执行命令。'
      + '\n请使用 read_file、list_directory、search_files、grep_search 等工具获取信息，然后给出清晰的分析结论。',
    extraBlockedTools: [],
    extraAutoDenyTools: ['write_file', 'edit_file', 'execute_command'],
    sandboxMode: 'readonly',
  },

  implementer: {
    name: 'implementer',
    description: '编码实现，允许创建和修改项目文件、执行命令（受执行策略控制）。适合功能开发、代码重构',
    systemPromptSuffix:
      '\n你是一个实现型子代理，负责编码和文件操作。你可以创建和修改项目目录中的文件，也可以执行命令。'
      + '\n修改文件前先用 read_file 确认当前内容，用 edit_file 进行精确替换，用 write_file 创建新文件。'
      + '\nexecute_command 受执行策略控制，部分命令可能被禁止或需要确认。',
    extraBlockedTools: [],
    extraAutoDenyTools: [],
    sandboxMode: 'project',
  },

  reviewer: {
    name: 'reviewer',
    description: '代码审查，只读分析并给出改进建议。适合代码质量检查、安全审计',
    systemPromptSuffix:
      '\n你是一个审查型子代理，负责代码审查和质量分析。你只有只读权限。'
      + '\n审查要点：代码风格一致性、错误处理完整性、安全漏洞、性能问题、可维护性。'
      + '\n输出格式：按严重程度分类（高/中/低），每条问题给出具体文件位置和修复建议。',
    extraBlockedTools: [],
    extraAutoDenyTools: ['write_file', 'edit_file', 'execute_command'],
    sandboxMode: 'readonly',
  },
};

/**
 * 获取角色定义，不存在则返回 general
 */
function getRole(roleName) {
  return ROLES[roleName] || ROLES.general;
}

/**
 * 获取所有角色列表（用于前端展示和工具 description）
 */
function listRoles() {
  return Object.values(ROLES).map(r => ({
    name: r.name,
    description: r.description,
    sandboxMode: r.sandboxMode,
  }));
}

/**
 * 合并角色的工具策略与全局配置
 * 返回 { blockedTools, autoDenyTools }
 */
function mergeToolPolicy(role, globalBlocked, globalAutoDeny) {
  const blocked = new Set(globalBlocked);
  for (const t of role.extraBlockedTools) blocked.add(t);

  const autoDeny = new Set(globalAutoDeny);
  for (const t of role.extraAutoDenyTools) autoDeny.add(t);

  return {
    blockedTools: [...blocked],
    autoDenyTools: [...autoDeny],
  };
}

module.exports = { ROLES, getRole, listRoles, mergeToolPolicy };
