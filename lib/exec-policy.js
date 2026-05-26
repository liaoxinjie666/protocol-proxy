/**
 * 执行策略引擎 — 评估 shell 命令的安全性
 *
 * 三值决策：Allow（直接执行）/ Prompt（需用户确认）/ Forbidden（直接拒绝）
 * 多 token 前缀匹配 + 通配符支持
 * 两层规则：Default（内置）< User（用户配置）
 * deny 规则始终优先于 allow
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

const POLICY_PATH = path.join(os.homedir(), '.protocol-proxy', 'execpolicy.json');

// ==================== 内置默认规则 ====================

const DEFAULT_RULES = {
  allow: [
    // 文件浏览
    { pattern: 'ls', description: '列出目录' },
    { pattern: 'dir', description: '列出目录 (Windows)' },
    { pattern: 'cat', description: '查看文件内容' },
    { pattern: 'type', description: '查看文件内容 (Windows)' },
    { pattern: 'head', description: '查看文件头部' },
    { pattern: 'tail', description: '查看文件尾部' },
    { pattern: 'less', description: '分页查看文件' },
    { pattern: 'more', description: '分页查看文件' },
    { pattern: 'wc', description: '统计行数/字数' },
    { pattern: 'file', description: '查看文件类型' },
    { pattern: 'stat', description: '查看文件信息' },
    { pattern: 'du', description: '查看磁盘用量' },
    { pattern: 'df', description: '查看磁盘空间' },
    { pattern: 'pwd', description: '当前目录' },
    { pattern: 'which', description: '查找命令路径' },
    { pattern: 'where', description: '查找命令路径 (Windows)' },
    { pattern: 'echo', description: '输出文本' },
    { pattern: 'printf', description: '格式化输出' },
    { pattern: 'date', description: '当前日期时间' },
    { pattern: 'env', description: '查看环境变量' },
    { pattern: 'printenv', description: '查看环境变量' },
    { pattern: 'hostname', description: '主机名' },
    { pattern: 'uname', description: '系统信息' },
    { pattern: 'whoami', description: '当前用户' },
    { pattern: 'id', description: '用户 ID' },
    { pattern: 'uptime', description: '运行时间' },
    { pattern: 'free', description: '内存使用' },
    { pattern: 'true', description: '返回成功' },
    { pattern: 'false', description: '返回失败' },

    // 搜索
    { pattern: 'grep', description: '文本搜索' },
    { pattern: 'rg', description: 'ripgrep 搜索' },
    { pattern: 'ag', description: 'silver searcher' },
    { pattern: 'find', description: '查找文件' },
    { pattern: 'whereis', description: '查找文件' },
    { pattern: 'locate', description: '查找文件' },
    { pattern: 'tree', description: '目录树' },

    // Git（安全操作）
    { pattern: 'git status', description: 'Git 状态' },
    { pattern: 'git log', description: 'Git 日志' },
    { pattern: 'git diff', description: 'Git 差异' },
    { pattern: 'git show', description: 'Git 显示提交' },
    { pattern: 'git branch', description: 'Git 分支列表' },
    { pattern: 'git tag', description: 'Git 标签' },
    { pattern: 'git remote', description: 'Git 远程仓库' },
    { pattern: 'git stash list', description: 'Git stash 列表' },
    { pattern: 'git stash show', description: 'Git stash 查看' },
    { pattern: 'git config --list', description: 'Git 配置列表' },
    { pattern: 'git config --get', description: 'Git 配置查询' },
    { pattern: 'git rev-parse', description: 'Git 解析引用' },
    { pattern: 'git describe', description: 'Git 描述' },
    { pattern: 'git shortlog', description: 'Git 短日志' },
    { pattern: 'git blame', description: 'Git 追溯' },
    { pattern: 'git reflog', description: 'Git 引用日志' },
    { pattern: 'git ls-files', description: 'Git 列出文件' },
    { pattern: 'git ls-remote', description: 'Git 列出远程' },

    // Node.js / npm（安全操作）
    { pattern: 'node --version', description: 'Node 版本' },
    { pattern: 'npm --version', description: 'npm 版本' },
    { pattern: 'npm ls', description: 'npm 依赖列表' },
    { pattern: 'npm list', description: 'npm 依赖列表' },
    { pattern: 'npm info', description: 'npm 包信息' },
    { pattern: 'npm view', description: 'npm 包信息' },
    { pattern: 'npm outdated', description: 'npm 过期检查' },
    { pattern: 'npm test', description: 'npm 测试' },
    { pattern: 'npm run', description: 'npm 运行脚本' },
    { pattern: 'npx', description: 'npx 执行' },
    { pattern: 'yarn --version', description: 'yarn 版本' },
    { pattern: 'yarn list', description: 'yarn 依赖列表' },
    { pattern: 'yarn info', description: 'yarn 包信息' },
    { pattern: 'yarn test', description: 'yarn 测试' },
    { pattern: 'yarn run', description: 'yarn 运行脚本' },
    { pattern: 'pnpm --version', description: 'pnpm 版本' },
    { pattern: 'pnpm list', description: 'pnpm 依赖列表' },
    { pattern: 'pnpm test', description: 'pnpm 测试' },
    { pattern: 'pnpm run', description: 'pnpm 运行脚本' },

    // Python（安全操作）
    { pattern: 'python --version', description: 'Python 版本' },
    { pattern: 'python3 --version', description: 'Python3 版本' },
    { pattern: 'pip list', description: 'pip 包列表' },
    { pattern: 'pip show', description: 'pip 包信息' },
    { pattern: 'pip freeze', description: 'pip 冻结依赖' },
    { pattern: 'pip --version', description: 'pip 版本' },
    { pattern: 'python -m pytest', description: 'pytest 测试' },
    { pattern: 'python -m unittest', description: 'unittest 测试' },

    // Docker（只读操作）
    { pattern: 'docker ps', description: 'Docker 容器列表' },
    { pattern: 'docker images', description: 'Docker 镜像列表' },
    { pattern: 'docker logs', description: 'Docker 日志' },
    { pattern: 'docker inspect', description: 'Docker 检查' },
    { pattern: 'docker version', description: 'Docker 版本' },
    { pattern: 'docker info', description: 'Docker 信息' },
    { pattern: 'docker top', description: 'Docker 进程' },
    { pattern: 'docker stats', description: 'Docker 统计' },
    { pattern: 'docker port', description: 'Docker 端口' },
    { pattern: 'docker diff', description: 'Docker 差异' },

    // 网络诊断（安全）
    { pattern: 'ping', description: 'Ping 测试' },
    { pattern: 'nslookup', description: 'DNS 查询' },
    { pattern: 'dig', description: 'DNS 查询' },
    { pattern: 'host', description: 'DNS 查询' },
    { pattern: 'ip addr', description: 'IP 地址' },
    { pattern: 'ip route', description: '路由表' },
    { pattern: 'ifconfig', description: '网络接口' },
    { pattern: 'netstat', description: '网络状态' },
    { pattern: 'ss', description: 'Socket 统计' },
    { pattern: 'curl -I', description: 'HTTP 头信息' },
    { pattern: 'curl --head', description: 'HTTP 头信息' },
    { pattern: 'curl --version', description: 'curl 版本' },
    { pattern: 'wget --version', description: 'wget 版本' },

    // 系统信息
    { pattern: 'ps', description: '进程列表' },
    { pattern: 'top -b', description: '进程监控' },
    { pattern: 'htop', description: '进程监控' },
    { pattern: 'lsof', description: '打开文件列表' },
    { pattern: 'mount', description: '挂载点' },
    { pattern: 'lsblk', description: '块设备' },
    { pattern: 'lscpu', description: 'CPU 信息' },
    { pattern: 'lsusb', description: 'USB 设备' },
    { pattern: 'lspci', description: 'PCI 设备' },
    { pattern: 'dmesg', description: '内核日志' },
    { pattern: 'journalctl', description: '系统日志' },
    { pattern: 'systemctl status', description: '服务状态' },
    { pattern: 'systemctl is-active', description: '服务是否活跃' },
    { pattern: 'systemctl list-units', description: '服务列表' },

    // 测试和构建
    { pattern: 'make', description: 'Make 构建' },
    { pattern: 'cargo build', description: 'Cargo 构建' },
    { pattern: 'cargo test', description: 'Cargo 测试' },
    { pattern: 'cargo check', description: 'Cargo 检查' },
    { pattern: 'cargo clippy', description: 'Cargo lint' },
    { pattern: 'go build', description: 'Go 构建' },
    { pattern: 'go test', description: 'Go 测试' },
    { pattern: 'go vet', description: 'Go 检查' },
    { pattern: 'go mod tidy', description: 'Go 模块整理' },
    { pattern: 'go mod download', description: 'Go 模块下载' },
  ],

  prompt: [
    // Git（修改操作）
    { pattern: 'git add', description: 'Git 暂存文件' },
    { pattern: 'git commit', description: 'Git 提交' },
    { pattern: 'git checkout', description: 'Git 切换分支/恢复文件' },
    { pattern: 'git switch', description: 'Git 切换分支' },
    { pattern: 'git restore', description: 'Git 恢复文件' },
    { pattern: 'git merge', description: 'Git 合并' },
    { pattern: 'git rebase', description: 'Git 变基' },
    { pattern: 'git cherry-pick', description: 'Git 摘取提交' },
    { pattern: 'git stash', description: 'Git 暂存' },
    { pattern: 'git tag -a', description: 'Git 创建标签' },
    { pattern: 'git clean', description: 'Git 清理' },
    { pattern: 'git submodule', description: 'Git 子模块' },

    // npm/yarn/pnpm（安装操作）
    { pattern: 'npm install', description: 'npm 安装依赖' },
    { pattern: 'npm ci', description: 'npm 清洁安装' },
    { pattern: 'npm update', description: 'npm 更新依赖' },
    { pattern: 'npm uninstall', description: 'npm 卸载依赖' },
    { pattern: 'yarn install', description: 'yarn 安装依赖' },
    { pattern: 'yarn add', description: 'yarn 添加依赖' },
    { pattern: 'yarn remove', description: 'yarn 移除依赖' },
    { pattern: 'pnpm install', description: 'pnpm 安装依赖' },
    { pattern: 'pnpm add', description: 'pnpm 添加依赖' },
    { pattern: 'pnpm remove', description: 'pnpm 移除依赖' },

    // Python（安装操作）
    { pattern: 'pip install', description: 'pip 安装包' },
    { pattern: 'pip uninstall', description: 'pip 卸载包' },
    { pattern: 'pip install --upgrade', description: 'pip 升级包' },
    { pattern: 'python -m pip install', description: 'pip 安装包' },
    { pattern: 'venv', description: '虚拟环境' },
    { pattern: 'python -m venv', description: '创建虚拟环境' },

    // 文件操作（需确认）
    { pattern: 'cp', description: '复制文件' },
    { pattern: 'mv', description: '移动/重命名文件' },
    { pattern: 'mkdir', description: '创建目录' },
    { pattern: 'touch', description: '创建/更新文件时间戳' },
    { pattern: 'ln', description: '创建链接' },
    { pattern: 'tar', description: '打包/解包' },
    { pattern: 'zip', description: '压缩' },
    { pattern: 'unzip', description: '解压' },
    { pattern: 'gzip', description: '压缩' },
    { pattern: 'gunzip', description: '解压' },
    { pattern: '7z', description: '7-Zip 压缩' },

    // 网络请求
    { pattern: 'curl', description: 'HTTP 请求' },
    { pattern: 'wget', description: '下载文件' },

    // Docker（修改操作）
    { pattern: 'docker pull', description: 'Docker 拉取镜像' },
    { pattern: 'docker run', description: 'Docker 运行容器' },
    { pattern: 'docker start', description: 'Docker 启动容器' },
    { pattern: 'docker stop', description: 'Docker 停止容器' },
    { pattern: 'docker restart', description: 'Docker 重启容器' },
    { pattern: 'docker exec', description: 'Docker 执行命令' },
    { pattern: 'docker build', description: 'Docker 构建镜像' },
    { pattern: 'docker compose up', description: 'Docker Compose 启动' },
    { pattern: 'docker compose down', description: 'Docker Compose 停止' },

    // 进程管理
    { pattern: 'kill', description: '终止进程' },
    { pattern: 'pkill', description: '按名称终止进程' },
    { pattern: 'systemctl start', description: '启动服务' },
    { pattern: 'systemctl stop', description: '停止服务' },
    { pattern: 'systemctl restart', description: '重启服务' },
    { pattern: 'systemctl enable', description: '启用服务' },
    { pattern: 'systemctl disable', description: '禁用服务' },
    { pattern: 'service', description: '服务管理' },
    { pattern: 'nohup', description: '后台运行' },

    // 权限和属性
    { pattern: 'chmod', description: '修改权限' },
    { pattern: 'chown', description: '修改所有者' },
    { pattern: 'chgrp', description: '修改组' },
    { pattern: 'umask', description: '设置默认权限' },

    // Node.js 运行
    { pattern: 'node', description: '运行 Node.js 脚本' },
    { pattern: 'ts-node', description: '运行 TypeScript' },
    { pattern: 'npx tsx', description: '运行 TypeScript' },

    // Python 运行
    { pattern: 'python', description: '运行 Python 脚本' },
    { pattern: 'python3', description: '运行 Python3 脚本' },

    // 编辑器
    { pattern: 'nano', description: '编辑文件' },
    { pattern: 'vim', description: '编辑文件' },
    { pattern: 'vi', description: '编辑文件' },
    { pattern: 'code', description: 'VS Code 打开' },

    // Cargo（修改操作）
    { pattern: 'cargo install', description: 'Cargo 安装' },
    { pattern: 'cargo add', description: 'Cargo 添加依赖' },
    { pattern: 'cargo remove', description: 'Cargo 移除依赖' },
    { pattern: 'cargo update', description: 'Cargo 更新依赖' },
    { pattern: 'cargo run', description: 'Cargo 运行' },

    // Go（修改操作）
    { pattern: 'go install', description: 'Go 安装' },
    { pattern: 'go get', description: 'Go 获取依赖' },
  ],

  forbidden: [
    // 危险删除
    { pattern: 'rm -rf /', description: '删除根目录' },
    { pattern: 'rm -rf /*', description: '删除根目录所有内容' },
    { pattern: 'rm -rf ~', description: '删除用户目录' },
    { pattern: 'rm -rf .', description: '删除当前目录' },
    { pattern: 'rmdir /s /q C:\\', description: '删除 C 盘 (Windows)' },
    { pattern: 'del /s /q C:\\', description: '删除 C 盘 (Windows)' },
    { pattern: 'format', description: '格式化磁盘' },
    { pattern: 'fdisk', description: '磁盘分区' },
    { pattern: 'mkfs', description: '创建文件系统' },
    { pattern: 'dd if=', description: 'dd 直接写磁盘' },

    // 提权
    { pattern: 'sudo', description: '提权执行' },
    { pattern: 'su -', description: '切换用户' },

    // Git（不可逆操作）
    { pattern: 'git push --force', description: 'Git 强制推送' },
    { pattern: 'git push -f', description: 'Git 强制推送' },
    { pattern: 'git reset --hard', description: 'Git 硬重置' },
    { pattern: 'git checkout -- .', description: 'Git 丢弃所有修改' },
    { pattern: 'git clean -fd', description: 'Git 强制清理' },
    { pattern: 'git branch -D', description: 'Git 强制删除分支' },
    { pattern: 'git push origin --delete', description: 'Git 删除远程分支' },

    // npm/yarn/pnpm（危险操作）
    { pattern: 'npm publish', description: 'npm 发布包' },
    { pattern: 'npm unpublish', description: 'npm 撤回包' },
    { pattern: 'yarn publish', description: 'yarn 发布包' },

    // Docker（危险操作）
    { pattern: 'docker rm -f', description: 'Docker 强制删除容器' },
    { pattern: 'docker rmi -f', description: 'Docker 强制删除镜像' },
    { pattern: 'docker system prune -f', description: 'Docker 强制清理' },
    { pattern: 'docker volume rm', description: 'Docker 删除卷' },

    // 系统危险操作
    { pattern: 'reboot', description: '重启系统' },
    { pattern: 'shutdown', description: '关闭系统' },
    { pattern: 'poweroff', description: '关闭电源' },
    { pattern: 'init 0', description: '关机' },
    { pattern: 'init 6', description: '重启' },
    { pattern: 'halt', description: '停机' },
    { pattern: 'iptables -F', description: '清空防火墙规则' },
    { pattern: 'iptables --flush', description: '清空防火墙规则' },
    { pattern: 'userdel', description: '删除用户' },
    { pattern: 'groupdel', description: '删除组' },
    { pattern: 'visudo', description: '编辑 sudoers' },

    // 网络危险操作
    { pattern: 'nc -l', description: '监听端口（可能暴露服务）' },
    { pattern: 'ncat -l', description: '监听端口' },
    { pattern: 'socat', description: 'Socket 转发' },
  ],
};

// ==================== 匹配引擎 ====================

/**
 * 将命令字符串规范化为 token 数组
 * 去除多余空格，处理引号
 */
function tokenize(cmd) {
  const tokens = [];
  let current = '';
  let inQuote = null;
  for (const ch of cmd.trim()) {
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * 按 shell 命令连接符拆分命令为子命令数组
 * 拆分符：;、&&、||、|、\n
 * 引号内的连接符不拆分
 */
function splitOnShellOperators(cmd) {
  const segments = [];
  let current = '';
  let inQuote = null;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (inQuote) {
      if (ch === inQuote) { inQuote = null; }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }

    // 检查多字符连接符 &&、||
    if (i + 1 < cmd.length) {
      const two = cmd[i] + cmd[i + 1];
      if (two === '&&' || two === '||') {
        const trimmed = current.trim();
        if (trimmed) segments.push(trimmed);
        current = '';
        i++; // 跳过第二个字符
        continue;
      }
    }

    // 单字符连接符
    if (ch === ';' || ch === '|' || ch === '\n') {
      const trimmed = current.trim();
      if (trimmed) segments.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) segments.push(trimmed);
  return segments;
}

/**
 * 检查命令 token 是否匹配规则 pattern
 * 支持：
 *   - 精确前缀匹配："git status" 匹配 "git status -s"
 *   - 通配符 *："git log *" 匹配 "git log --oneline -10"
 *   - 多 token 匹配："rm -rf" 匹配 "rm -rf ./dir"
 */
function matchPattern(pattern, cmdTokens) {
  const patternTokens = tokenize(pattern.toLowerCase());
  const lower = cmdTokens.map(t => t.toLowerCase());

  for (let i = 0; i < patternTokens.length; i++) {
    const pt = patternTokens[i];
    if (pt === '*') return true; // 通配符匹配剩余所有
    if (i >= lower.length) return false; // 命令太短
    if (pt !== lower[i]) return false; // 不匹配
  }
  return true; // 所有 pattern token 都匹配了
}

// ==================== 策略引擎 ====================

class ExecPolicy {
  constructor() {
    this.userRules = { allow: [], prompt: [], forbidden: [] };
    this.sessionApproved = new Set(); // 本次会话已批准的命令前缀
    this.load();
  }

  /**
   * 从磁盘加载用户规则
   */
  load() {
    try {
      if (fs.existsSync(POLICY_PATH)) {
        const data = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
        this.userRules = {
          allow: Array.isArray(data.allow) ? data.allow : [],
          prompt: Array.isArray(data.prompt) ? data.prompt : [],
          forbidden: Array.isArray(data.forbidden) ? data.forbidden : [],
        };
        logger.log(`[exec-policy] 加载用户规则: allow=${this.userRules.allow.length}, prompt=${this.userRules.prompt.length}, forbidden=${this.userRules.forbidden.length}`);
      }
    } catch (err) {
      logger.warn(`[exec-policy] 加载用户规则失败: ${err.message}`);
    }
  }

  /**
   * 保存用户规则到磁盘
   */
  save() {
    try {
      const dir = path.dirname(POLICY_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(POLICY_PATH, JSON.stringify(this.userRules, null, 2), 'utf8');
    } catch (err) {
      logger.warn(`[exec-policy] 保存用户规则失败: ${err.message}`);
    }
  }

  /**
   * 评估单个子命令（不含 shell 连接符）的安全性
   * 评估顺序：User forbidden > Default forbidden > Session approved > User allow > Default allow > User prompt > Default prompt
   * @param {string} command - 单个 shell 命令
   * @returns {{ decision: 'allow'|'prompt'|'forbidden', matchedRule?: string, description?: string }}
   */
  _evaluateSingle(command) {
    const cmdTokens = tokenize(command);
    if (cmdTokens.length === 0) {
      return { decision: 'forbidden', description: '空命令' };
    }

    // 1. forbidden（deny 始终最高优先级，不可被 session 审批绕过）
    for (const rule of this.userRules.forbidden) {
      if (matchPattern(rule.pattern, cmdTokens)) {
        return { decision: 'forbidden', matchedRule: rule.pattern, description: rule.description || '用户禁止' };
      }
    }
    for (const rule of DEFAULT_RULES.forbidden) {
      if (matchPattern(rule.pattern, cmdTokens)) {
        return { decision: 'forbidden', matchedRule: rule.pattern, description: rule.description || '系统禁止' };
      }
    }

    // 2. 会话级批准（在 forbidden 评估之后，确保 forbidden 不可绕过）
    const cmdLower = command.toLowerCase().trim();
    for (const approved of this.sessionApproved) {
      if (cmdLower.startsWith(approved)) {
        return { decision: 'allow', matchedRule: 'session-approved', description: '会话已批准' };
      }
    }

    // 3. allow
    for (const rule of this.userRules.allow) {
      if (matchPattern(rule.pattern, cmdTokens)) {
        return { decision: 'allow', matchedRule: rule.pattern, description: rule.description || '用户允许' };
      }
    }
    for (const rule of DEFAULT_RULES.allow) {
      if (matchPattern(rule.pattern, cmdTokens)) {
        return { decision: 'allow', matchedRule: rule.pattern, description: rule.description || '系统允许' };
      }
    }

    // 4. prompt
    for (const rule of this.userRules.prompt) {
      if (matchPattern(rule.pattern, cmdTokens)) {
        return { decision: 'prompt', matchedRule: rule.pattern, description: rule.description || '需用户确认' };
      }
    }
    for (const rule of DEFAULT_RULES.prompt) {
      if (matchPattern(rule.pattern, cmdTokens)) {
        return { decision: 'prompt', matchedRule: rule.pattern, description: rule.description || '需用户确认' };
      }
    }

    // 5. 无规则匹配 → 默认 prompt（未知命令需确认）
    return { decision: 'prompt', matchedRule: null, description: '未知命令，需用户确认' };
  }

  /**
   * 评估命令安全性
   * 先按 shell 连接符拆分，对每个子命令独立评估
   * forbidden 优先级最高（任一子命令 forbidden → 整体 forbidden）
   * @param {string} command - shell 命令
   * @returns {{ decision: 'allow'|'prompt'|'forbidden', matchedRule?: string, description?: string }}
   */
  check(command) {
    if (!command || typeof command !== 'string') {
      return { decision: 'forbidden', description: '空命令' };
    }

    const segments = splitOnShellOperators(command);
    if (segments.length === 0) {
      return { decision: 'forbidden', description: '空命令' };
    }

    // 对每个子命令独立评估，合并结果
    let worstDecision = 'allow';
    let worstResult = null;
    let firstAllowResult = null;

    for (const segment of segments) {
      const result = this._evaluateSingle(segment);

      if (result.decision === 'forbidden') {
        return result; // forbidden 立即返回，最高优先级
      }
      if (result.decision === 'prompt' && worstDecision === 'allow') {
        worstDecision = 'prompt';
        worstResult = result;
      }
      if (!firstAllowResult && result.decision === 'allow') {
        firstAllowResult = result;
      }
    }

    // 如果有任何 prompt 级别的子命令，整体返回 prompt
    if (worstDecision === 'prompt' && worstResult) {
      return worstResult;
    }

    // 单个子命令时保留原始匹配信息
    if (segments.length === 1 && firstAllowResult) {
      return firstAllowResult;
    }

    // 所有子命令都是 allow
    return { decision: 'allow', matchedRule: 'all-subcommands-allowed', description: '所有子命令均已允许' };
  }

  /**
   * 会话级批准命令前缀
   */
  approveForSession(prefix) {
    this.sessionApproved.add(prefix.toLowerCase().trim());
  }

  /**
   * 永久添加规则到用户配置
   * @param {'allow'|'prompt'|'forbidden'} category
   * @param {string} pattern
   * @param {string} [description]
   */
  addRule(category, pattern, description) {
    if (!this.userRules[category]) return false;
    if (this.userRules[category].some(r => r.pattern === pattern)) return false;
    const labels = { allow: '用户允许', prompt: '用户需确认', forbidden: '用户禁止' };
    this.userRules[category].push({ pattern, description: description || `${labels[category] || category}: ${pattern}` });
    this.save();
    return true;
  }

  addAllowRule(pattern, description) { this.addRule('allow', pattern, description); }
  addForbiddenRule(pattern, description) { this.addRule('forbidden', pattern, description); }
  addPromptRule(pattern, description) { this.addRule('prompt', pattern, description); }

  /**
   * 从用户规则中移除指定 pattern
   */
  removeRule(category, pattern) {
    if (!this.userRules[category]) return false;
    const idx = this.userRules[category].findIndex(r => r.pattern === pattern);
    if (idx < 0) return false;
    this.userRules[category].splice(idx, 1);
    this.save();
    return true;
  }

  /**
   * 获取当前策略概览（用于前端展示）
   */
  getSummary() {
    return {
      default: {
        allow: DEFAULT_RULES.allow.length,
        prompt: DEFAULT_RULES.prompt.length,
        forbidden: DEFAULT_RULES.forbidden.length,
      },
      user: {
        allow: this.userRules.allow.length,
        prompt: this.userRules.prompt.length,
        forbidden: this.userRules.forbidden.length,
      },
      userRules: this.userRules,
      sessionApproved: [...this.sessionApproved],
    };
  }

  /**
   * 获取完整规则列表（默认 + 用户，用于前端展示）
   */
  getAllRules() {
    return {
      default: DEFAULT_RULES,
      user: this.userRules,
    };
  }
}

// 单例
const execPolicy = new ExecPolicy();

module.exports = { ExecPolicy, execPolicy, DEFAULT_RULES, POLICY_PATH, tokenize, splitOnShellOperators };
