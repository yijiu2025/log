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
 * - LOG_ERROR_FILE    错误文件开关，默认 on；off = 不单独写错误文件；也可填自定义前缀
 * - LOG_KEEP_DAYS     滚动日志保留天数，默认 30；0 = 关闭过期清理
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

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/** 三态布尔：未配置返回 null（用于 LOG_DEV 覆盖） */
function parseBoolOpt(value) {
  if (value === undefined || value === null || value === '') return null;
  return parseBool(value, null);
}

function parseKeywords(raw, set) {
  if (!raw) return;
  for (const part of String(raw).split(',')) {
    const kw = part.trim().toLowerCase();
    if (kw) set.add(kw);
  }
}

/** 兼容旧的 DEBUG_XXX=true 调试开关：DEBUG_AUTH=true → 关键词 auth */
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
    // 错误文件：默认另写；LOG_ERROR_FILE=off 或实例 file.error=false 关闭；字符串 = 自定义前缀
    error: parseBoolOpt(env.LOG_ERROR_FILE) ?? true,
    // 保留天数：滚动日志过期自动清理（只删匹配命名模式的文件）；LOG_KEEP_DAYS=0 关闭
    keepDays: (() => {
      const raw = parseInt(env.LOG_KEEP_DAYS, 10);
      return Number.isFinite(raw) && raw >= 0 ? raw : 30;
    })()
  };

  const cfg = {
    level: Object.hasOwn(LEVELS, rawLevel) ? rawLevel : 'info',
    debugKeywords: keywords,
    modules,
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
  if (typeof o.fileError === 'boolean' || typeof o.fileError === 'string') {
    cfg.file.error = o.fileError;
  }
  if (typeof o.console === 'boolean') cfg.consoleEnabled = o.console;
  if (typeof o.file === 'boolean') cfg.fileEnabled = o.file;
  if (o.file && typeof o.file === 'object') {
    cfg.file = { ...cfg.file, ...o.file };
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

  return Object.freeze(cfg);
}

let config = buildConfig();

export function getLogConfig() {
  return config;
}

/** 热更新配置（修改环境变量后调用，测试场景有用） */
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
 *   - fileError: true|false|'自定义前缀'  错误文件开关/命名（仅 Node）
 *   - keepDays: 30             滚动日志保留天数，0 关闭清理（仅 Node）
 *   - file: true|false|{name?,dir?,ext?,date?,error?,keepDays?}  文件总开关或文件配置对象（合并）
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
 */
export function tagMatchesKeyword(tag, kw) {
  if (kw === '*' || kw === 'all') return true;
  if (kw.endsWith('*')) return tag.startsWith(kw.slice(0, -1));
  return tag === kw || tag.startsWith(`${kw}.`) || tag.includes(`.${kw}.`) || tag.endsWith(`.${kw}`);
}

/** 判断某个 tag 的 debug/trace 是否被关键词白名单放行 */
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
 * @returns {object|null} { level?, console?, file? }
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
