/**
 * 子代理权限系统
 * 每个权限档定义：工具过滤策略、沙盒模式、基础行为指引
 *
 * 权限与身份（Agent）正交：权限决定能做什么，身份决定怎么做、输出什么。
 *
 * sandboxMode:
 *   'standard'   — 按全局配置的 blocked/auto-deny 执行（默认）
 *   'readonly'   — 写操作工具自动拒绝，execute_command 禁用
 *   'project'    — 允许写入项目目录，execute_command 由执行策略引擎控制
 */

const ROLES = {
  readonly: {
    name: 'readonly',
    description: '只读分析。适合探索、搜索、代码审查、方案规划',
    systemPromptSuffix:
      '\n你只有只读权限，无法修改任何文件或执行命令。'
      + '\n请使用 read_file、list_directory、search_files、grep_search 等工具获取信息。'
      + '\n分析时关注：代码结构、错误处理、安全漏洞、性能问题、可维护性。'
      + '\n如发现问题，按严重程度分类（高/中/低），给出具体文件位置和修复建议。',
    extraBlockedTools: [],
    extraAutoDenyTools: ['write_file', 'edit_file', 'execute_command'],
    sandboxMode: 'readonly',
  },

  writer: {
    name: 'writer',
    description: '读写执行。允许创建和修改项目文件、执行命令（受执行策略控制）',
    systemPromptSuffix:
      '\n你可以创建和修改项目目录中的文件，也可以执行命令。'
      + '\n修改文件前先用 read_file 确认当前内容，用 edit_file 进行精确替换，用 write_file 创建新文件。'
      + '\nexecute_command 受执行策略控制，部分命令可能被禁止或需要确认。',
    extraBlockedTools: [],
    extraAutoDenyTools: [],
    sandboxMode: 'project',
  },

  full: {
    name: 'full',
    description: '完全访问，继承全局配置的工具权限',
    systemPromptSuffix: '',
    // 不覆盖工具策略，完全使用全局配置
    extraBlockedTools: [],
    extraAutoDenyTools: [],
    sandboxMode: 'standard',
  },
};

/**
 * 获取权限定义，不存在则返回 full
 */
function getRole(roleName) {
  return ROLES[roleName] || ROLES.full;
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
