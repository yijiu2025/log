/**
 * 日志配置：环境变量 + configureLog() 编程覆盖 + 模块级规则
 *
 * 浏览器安全：不依赖任何 Node 内置模块（env 缺失时全部走默认值）。
 *
 * 环境变量：
 * - LOG_LEVEL         全局最低级别：trace|debug|info|warn|error|fatal，默认 info
 * - LOG_DEBUG         debug/trace 白名单关键词，逗号分隔；
 *                     '*' 或 'all' 表示放开所有模块；支持前缀通配（如 'auth.*'）；
 *                     关键词按"路径段"匹配：LOG_DEBUG=auth 可命中 framework.auth.session
 * - DEBUG_<NAME>=true 兼容旧调试开关，自动映射为关键词（如 DEBUG_AUTH=true → 关键词 auth）
 * - LOG_DIR           日志文件目录，默认 logs/
 * - LOG_FILE_NAME     主日志文件名前缀，默认 app（生成 app-YYYY-MM-DD.log）
 * - LOG_FILE_EXT      文件扩展名，默认 .log
 * - LOG_FILE_DATE     文件名日期后缀，默认 on；off = 单文件不滚动
 * - LOG_DATE_DIR      日期作为子目录，默认 off（保持平铺）；
 *                     on = logs/2026-09-12/app.log（文件名不再带日期后缀）
 * - LOG_SUBDIR        模块子目录，默认不启用；
 *                     auto/true = 用 tag 首段自动分类（framework.auth.x → framework）；
 *                     也可填固定目录名（如 LOG_SUBDIR=firewall）
 * - LOG_ERROR_FILE    错误文件开关，默认 on；off = 不单独写错误文件；也可填自定义前缀
 * - LOG_KEEP_DAYS     滚动日志保留天数，默认 30；0 = 关闭过期清理
 * - LOG_FILE_SUFFIX   文件名后缀（主日志与错误文件都带），默认无；
 *                     'pid' = 用进程号（多进程部署防行交错），如 app-12345-2026-09-13.log
 * - LOG_MAX_STR       单字段字符串长度上限（字符数），默认 2000；0 = 关闭截断。
 *                     超长截断并追加 '…(len=原长)' 标记，防单条日志撑爆文件
 * - LOG_CONSOLE       是否输出到控制台，默认 true
 * - LOG_FILE          是否写入文件（仅 Node 生效），默认 true
 * - LOG_PRETTY        控制台是否彩色人类可读输出；默认：非 production 为 true
 * - LOG_DEV           dev 专属输出（log.dev）显示开关；默认非 production 显示
 *
 * 模块级覆盖（<NAME> 小写并转点分后按 tag 路径段匹配）：
 * - LOG_LEVEL_<NAME>   覆盖该模块最低级别，如 LOG_LEVEL_AUTH=info
 * - LOG_CONSOLE_<NAME> 该模块是否输出到控制台，如 LOG_CONSOLE_REDIS=off
 * - LOG_FILE_<NAME>    该模块是否写文件，如 LOG_FILE_CLI=false
 *
 * @author yijiu2025
 * @since 2026-09-10
 */

/** 级别数值：越小越详细 */
export const LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
});

/**
 * 解析宽松布尔值。
 * @param {*} value - 原始值（'1'/'true'/'yes'/'on' 视为 true，其余 false）
 * @param {boolean} defaultValue - 值缺失（undefined/null/''）时的默认值
 * @returns {boolean}
 */
function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/**
 * 三态布尔解析：未配置返回 null（用于区分"未配置，走默认"与"显式配置"）。
 * @param {*} value - 原始值
 * @returns {boolean|null} null = 未配置
 */
function parseBoolOpt(value) {
  if (value === undefined || value === null || value === '') return null;
  return parseBool(value, null);
}

/**
 * 解析模块子目录配置（LOG_SUBDIR / 实例 file.subdir）：
 * - 未配置 / '' / 'off' / 'false' → null（不分子目录）
 * - 'true' / 'auto'              → true（自动用 tag 首段，如 framework.auth.x → framework）
 * - 其他字符串                    → 该字符串作为固定子目录名
 * @param {string|boolean|null} value - 配置值（'auto'/'true'/布尔 true = 自动模式）
 * @returns {string|true|null} true = 用 tag 首段；字符串 = 固定目录名；null = 不分子目录
 */
function parseSubdirOpt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value ? true : null;
  const s = String(value).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'off' || lower === 'false' || lower === '0' || lower === 'no') return null;
  if (lower === 'true' || lower === 'auto' || lower === '1' || lower === 'on') return true;
  return s;
}

/**
 * 解析 LOG_DEBUG 关键词串（逗号分隔）进集合。
 * @param {string|undefined} raw - 环境变量原始值
 * @param {Set<string>} set - 关键词集合（原地追加）
 * @returns {void}
 */
function parseKeywords(raw, set) {
  if (!raw) return;
  for (const part of String(raw).split(',')) {
    const kw = part.trim().toLowerCase();
    if (kw) set.add(kw);
  }
}

/**
 * 兼容旧的 DEBUG_XXX=true 调试开关：DEBUG_AUTH=true → 关键词 auth。
 * @param {object} env - process.env 对象
 * @param {Set<string>} set - 关键词集合（原地追加）
 * @returns {void}
 */
function collectLegacyDebugFlags(env, set) {
  for (const [key, value] of Object.entries(env)) {
    if (!/^DEBUG_[A-Z0-9_]+$/.test(key)) continue;
    if (!parseBool(value, false)) continue;
    set.add(key.slice(6).toLowerCase());
  }
}

/**
 * 模块级覆盖规则：LOG_LEVEL_<NAME> / LOG_CONSOLE_<NAME> / LOG_FILE_<NAME>
 * NAME 小写并把下划线转为点分（AUTH_SESSION → auth.session），按 tag 路径段匹配。
 * @param {object} env - process.env 对象
 * @param {Map<string, object>} rules - 规则表（原地填充：关键词 → { level?, console?, file? }）
 * @returns {void}
 */
function collectModuleRules(env, rules) {
  for (const [key, value] of Object.entries(env)) {
    const m = /^LOG_(LEVEL|CONSOLE|FILE)_([A-Z0-9_]+)$/.exec(key);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    const name = m[2].toLowerCase().replaceAll('_', '.');
    let rule = rules.get(name);
    if (!rule) {
      rule = {};
      rules.set(name, rule);
    }
    if (kind === 'level') {
      const lv = String(value).trim().toLowerCase();
      if (Object.hasOwn(LEVELS, lv)) rule.level = lv;
    } else {
      rule[kind] = parseBool(value, true);
    }
  }
}

/** configureLog() 编程覆盖（优先级最高） */
let runtimeOverrides = {};

/**
 * 从环境变量 + runtimeOverrides 构建完整配置。
 * @returns {Readonly<object>} 冻结的配置对象（level/maxStr/modules/dir/file/consoleEnabled/
 *          fileEnabled/pretty/isProd/showDev/debugKeywords），运行期不可变
 */
function buildConfig() {
  const env = (typeof process !== 'undefined' && process.env) || {};
  const rawLevel = String(env.LOG_LEVEL || 'info')
    .trim()
    .toLowerCase();
  const keywords = new Set();
  parseKeywords(env.LOG_DEBUG, keywords);
  collectLegacyDebugFlags(env, keywords);

  const modules = new Map();
  collectModuleRules(env, modules);

  const isProd = env.NODE_ENV === 'production';
  // dev 专属输出的显示开关：默认 NODE_ENV !== 'production' 时显示；
  // LOG_DEV=true 可强制在生产环境显示，LOG_DEV=false 可在开发环境隐藏
  const devOverride = parseBoolOpt(env.LOG_DEV);

  // 写文件相关配置（仅 Node 生效）
  const fileCfg = {
    name: env.LOG_FILE_NAME || 'app',
    dir: env.LOG_DIR || 'logs',
    ext: env.LOG_FILE_EXT || '.log',
    // 日期后缀：默认带（YYYY-MM-DD）；LOG_FILE_DATE=off / 实例 file.date=false 时为单文件
    date: parseBoolOpt(env.LOG_FILE_DATE) ?? true,
    // 日期目录：true 时日期作为子目录（logs/2026-09-12/app.log），文件名不再带日期后缀
    // LOG_DATE_DIR=true 启用；默认 false 保持旧布局
    dateDir: parseBool(env.LOG_DATE_DIR, false),
    // 模块子目录：字符串为固定子目录名（logs/firewall/...）；true = 用 tag 首段自动分类
    // 默认 null（不分子目录，全部写在同一层）
    subdir: parseSubdirOpt(env.LOG_SUBDIR),
    // 错误文件：默认另写；LOG_ERROR_FILE=off 或实例 file.error=false 关闭；字符串 = 自定义前缀
    error: parseBoolOpt(env.LOG_ERROR_FILE) ?? true,
    // 文件名后缀：'' 无；'pid' = 进程号；其他字符串 = 原样（多进程部署防行交错用）
    suffix: env.LOG_FILE_SUFFIX || '',
    // 保留天数：滚动日志过期自动清理（只删匹配命名模式的文件）；LOG_KEEP_DAYS=0 关闭
    keepDays: (() => {
      const raw = parseInt(env.LOG_KEEP_DAYS, 10);
      return Number.isFinite(raw) && raw >= 0 ? raw : 30;
    })()
  };

  // 单字段字符串长度上限（record 内递归生效；0 = 关闭截断）
  const rawMaxStr = parseInt(env.LOG_MAX_STR, 10);
  const maxStr = Number.isFinite(rawMaxStr) && rawMaxStr >= 0 ? rawMaxStr : 2000;

  const cfg = {
    level: Object.hasOwn(LEVELS, rawLevel) ? rawLevel : 'info',
    debugKeywords: keywords,
    modules,
    maxStr,
    dir: env.LOG_DIR || 'logs',
    fileName: env.LOG_FILE_NAME || 'app',
    file: fileCfg,
    consoleEnabled: parseBool(env.LOG_CONSOLE, true),
    fileEnabled: parseBool(env.LOG_FILE, true),
    pretty: parseBool(env.LOG_PRETTY, !isProd),
    isProd,
    showDev: devOverride !== null ? devOverride : !isProd
  };

  // configureLog() 编程覆盖（优先级高于环境变量）
  const o = runtimeOverrides;
  if (o.level && Object.hasOwn(LEVELS, o.level)) cfg.level = o.level;
  if (o.dir) {
    cfg.dir = o.dir;
    cfg.file.dir = o.dir;
  }
  if (o.fileName) {
    cfg.fileName = o.fileName;
    cfg.file.name = o.fileName;
  }
  if (o.ext) cfg.file.ext = o.ext;
  if (typeof o.fileDate === 'boolean') cfg.file.date = o.fileDate;
  if (typeof o.dateDir === 'boolean') cfg.file.dateDir = o.dateDir;
  if (o.subdir !== undefined) cfg.file.subdir = parseSubdirOpt(o.subdir);
  if (typeof o.fileError === 'boolean' || typeof o.fileError === 'string') {
    cfg.file.error = o.fileError;
  }
  if (o.fileSuffix !== undefined) cfg.file.suffix = String(o.fileSuffix);
  if (o.maxStr !== undefined) {
    const ms = parseInt(o.maxStr, 10);
    if (Number.isFinite(ms) && ms >= 0) cfg.maxStr = ms;
  }
  if (typeof o.console === 'boolean') cfg.consoleEnabled = o.console;
  if (typeof o.file === 'boolean') cfg.fileEnabled = o.file;
  if (o.file && typeof o.file === 'object') {
    // keepDays 是顶层键，实例对象里也允许写，统一搬到 cfg.file
    const merged = { ...o.file };
    if (merged.keepDays !== undefined) {
      const kd = parseInt(merged.keepDays, 10);
      if (Number.isFinite(kd) && kd >= 0) cfg.file.keepDays = kd;
      delete merged.keepDays;
    }
    // 三态/枚举键需要归一化，直接展开会把 'auto' / 'off' 等字面量写进配置
    if (merged.date !== undefined) merged.date = parseBoolOpt(merged.date) ?? true;
    if (merged.dateDir !== undefined) merged.dateDir = parseBool(merged.dateDir, false);
    if (merged.subdir !== undefined) merged.subdir = parseSubdirOpt(merged.subdir);
    if (merged.error !== undefined && typeof merged.error !== 'boolean') {
      merged.error = parseBoolOpt(merged.error) ?? true;
    }
    cfg.file = { ...cfg.file, ...merged };
  }
  if (typeof o.pretty === 'boolean') cfg.pretty = o.pretty;
  if (typeof o.showDev === 'boolean') cfg.showDev = o.showDev;
  if (o.debugKeywords) {
    const set = new Set();
    const list = Array.isArray(o.debugKeywords) ? o.debugKeywords : String(o.debugKeywords).split(',');
    for (const kw of list) {
      const k = String(kw).trim().toLowerCase();
      if (k) set.add(k);
    }
    cfg.debugKeywords = set;
  }

  // 深冻结：配置对象在运行期不可变（file 与各模块规则一并冻结）
  for (const rule of cfg.modules.values()) Object.freeze(rule);
  Object.freeze(cfg.file);
  return Object.freeze(cfg);
}

let config = buildConfig();

/**
 * 读取当前全局配置（冻结对象，运行期不可变）。
 * @returns {Readonly<object>} buildConfig() 产物
 */
export function getLogConfig() {
  return config;
}

/**
 * 重新从环境变量构建配置（热更新；修改环境变量后调用，测试场景有用）。
 * 注意：configureLog() 的编程覆盖仍会叠加在环境变量之上。
 * @returns {Readonly<object>} 新配置
 */
export function reloadLogConfig() {
  config = buildConfig();
  return config;
}

/**
 * 编程方式覆盖全局配置（优先级高于环境变量，热生效）。
 *
 * @param {object} patch 可用键：
 *   - level: 'info'            全局最低级别
 *   - dir: 'logs'              文件目录（仅 Node）
 *   - fileName: 'app'          主日志文件名前缀（仅 Node）
 *   - ext: '.log'              文件扩展名（仅 Node）
 *   - fileDate: true|false     文件名是否带日期后缀（仅 Node）
 *   - dateDir: true|false      日期作为子目录 logs/2026-09-12/app.log（仅 Node）
 *   - subdir: 'auto'|'名'|false  模块子目录：'auto'/true = 按 tag 首段自动分类；字符串 = 固定目录名（仅 Node）
 *   - fileError: true|false|'自定义前缀'  错误文件开关/命名（仅 Node）
 *   - keepDays: 30             滚动日志保留天数，0 关闭清理（仅 Node）
 *   - fileSuffix: 'pid'|'名'   文件名后缀：'pid' = 进程号；字符串原样；'' 无（仅 Node）
 *   - maxStr: 2000             单字段字符串长度上限（字符数），0 关闭截断
 *   - file: true|false|{name?,dir?,ext?,date?,dateDir?,subdir?,error?,keepDays?,suffix?}  文件总开关或文件配置对象（合并）
 *   - console: true|false      控制台总开关
 *   - pretty: true|false       控制台彩色可读 / JSON 行
 *   - showDev: true|false      dev 专属输出显示开关
 *   - debugKeywords: 'a,b'|['a'] debug/trace 白名单
 * @returns {object} 新配置
 *
 * @example
 *   configureLog({ level: 'warn', file: { name: 'server', date: false, ext: '.txt' } });
 */
export function configureLog(patch = {}) {
  runtimeOverrides = { ...runtimeOverrides, ...patch };
  config = buildConfig();
  return config;
}

/**
 * tag 是否命中单个关键词（按路径段匹配，任一命中即可）：
 * - 关键词为 '*' 或 'all'：全部放行
 * - tag === 关键词
 * - tag 以 "关键词." 开头（关键词是其路径祖先，如 auth → auth.session）
 * - tag 包含 ".关键词."（段匹配，如 auth → framework.auth.session）
 * - tag 以 ".关键词" 结尾
 * - 关键词以 '*' 结尾：按前缀通配，如 'firewall.*' → firewall.engine
 * @param {string} tag - 模块标签（点分路径，如 'framework.auth.session'）
 * @param {string} kw - 单个关键词（'*'/'all' 全放行；'前缀*' 前缀通配）
 * @returns {boolean} 是否命中
 */
export function tagMatchesKeyword(tag, kw) {
  if (kw === '*' || kw === 'all') return true;
  if (kw.endsWith('*')) return tag.startsWith(kw.slice(0, -1));
  return tag === kw || tag.startsWith(`${kw}.`) || tag.includes(`.${kw}.`) || tag.endsWith(`.${kw}`);
}

/**
 * 判断某个 tag 的 debug/trace 是否被关键词白名单放行。
 * @param {string} tag - 模块标签
 * @param {Set<string>} keywords - 关键词集合（含 '*'/'all' 时全部放行）
 * @returns {boolean} 任一关键词命中即为 true；集合为空恒为 false
 */
export function isDebugTagEnabled(tag, keywords) {
  if (!keywords || keywords.size === 0) return false;
  if (keywords.has('*') || keywords.has('all')) return true;
  for (const kw of keywords) {
    if (!kw) continue;
    if (tagMatchesKeyword(tag, kw)) return true;
  }
  return false;
}

/**
 * 匹配模块级覆盖规则（LOG_LEVEL_<NAME> 等）。
 * 多个规则命中时取关键词最长（最具体）的那个。
 * @param {string} tag - 模块标签
 * @param {Map<string, object>} modules - collectModuleRules 产物（关键词 → 规则）
 * @returns {object|null} 命中的规则 { level?, console?, file? }；无命中返回 null
 */
export function matchModuleRule(tag, modules) {
  if (!modules || modules.size === 0) return null;
  let best = null;
  let bestLen = -1;
  for (const [kw, rule] of modules) {
    if (!tagMatchesKeyword(tag, kw)) continue;
    if (kw.length > bestLen) {
      best = rule;
      bestLen = kw.length;
    }
  }
  return best;
}
