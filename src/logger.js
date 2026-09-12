/**
 * Logger 核心：console 兼容的变参签名 + tag 化 debug 白名单 + 实例级配置
 *
 * 用法：
 *   import { createLogger } from 'wb-logkit';
 *   const log = createLogger('auth.session');
 *
 *   log.info('用户登录', { userId: 1 });        // 对象入 data
 *   log.warn('配置缺失，使用默认值: %s', key);   // 变参自动拼接
 *   log.error('查询失败', err);                 // Error 自动提取 stack
 *   log.debug('缓存未命中', cacheKey);          // 仅当 LOG_DEBUG 关键词命中 tag 才输出
 *
 * 实例级配置（优先级高于模块级环境变量与全局配置）：
 *   const log = createLogger('pay', {
 *     level: 'debug',            // 本模块最低级别
 *     console: true,             // 本模块控制台开关
 *     file: { name: 'pay' },     // 本模块独立文件 logs/pay-YYYY-MM-DD.log（Node）
 *     debug: true                // 本模块 debug 免关键词直接输出
 *   });
 *   log.config({ level: 'warn' });   // 运行时更新，返回自身可链式
 *
 * 矩阵控制（两个正交维度，任意级别任意组合，顺序无关）：
 *   log.always.error(...)        必输
 *   log.dev.info(...)            仅开发
 *   log.prod.error(...)          仅生产
 *   log.file.info(...)           只写文件不进控制台
 *
 * @author yijiu2025
 * @since 2026-09-10
 */
import { LEVELS, getLogConfig, isDebugTagEnabled, matchModuleRule } from './config.js';
import { getLogContext } from './context.js';
import { sanitizeForLog } from './sanitize.js';
import { consoleTransport, fileTransport } from './transports.js';

const RESERVED_KEYS = new Set(['t', 'level', 'tag', 'msg', 'err', 'requestId', 'userId']);

/** 是否为可展开合并的普通对象 */
function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Error) &&
    !(value instanceof Date)
  );
}

/**
 * 解析 console 风格的变参 → { msg, data, err }
 * - Error      → err（取第一个，后续 Error 并入 data._errN）
 * - 普通对象   → 浅合并进 data（递归脱敏）
 * - Date/数组  → 序列化为字符串
 * - 其他       → 空格拼接到 msg
 */
function parseArgs(args) {
  const parts = [];
  const data = {};
  let err;

  for (const arg of args) {
    if (arg instanceof Error) {
      if (!err) {
        err = arg;
      } else {
        data._extra_errors = data._extra_errors || [];
        data._extra_errors.push({ name: arg.name, message: arg.message });
      }
      continue;
    }
    if (arg === undefined || arg === null) {
      parts.push(String(arg));
      continue;
    }
    if (isPlainObject(arg)) {
      Object.assign(data, sanitizeForLog(arg));
      continue;
    }
    if (arg instanceof Date) {
      parts.push(arg.toISOString());
      continue;
    }
    if (Array.isArray(arg)) {
      parts.push(JSON.stringify(sanitizeForLog(arg)));
      continue;
    }
    parts.push(String(arg));
  }

  let msg = parts.join(' ');
  if (!msg && err) msg = err.message;
  return { msg, data, err };
}

/** 组装最终 record：固定字段在前，业务 data 冲突时整体让位到 data 键下 */
function buildRecord(tag, level, msg, data, err) {
  const ctx = getLogContext();
  const record = { t: new Date().toISOString(), level, tag, msg };

  let payload = data;
  for (const key of Object.keys(data)) {
    if (RESERVED_KEYS.has(key)) {
      payload = { data };
      break;
    }
  }
  Object.assign(record, payload);
  Object.assign(record, ctx);

  if (ctx.requestId !== undefined) record.requestId = ctx.requestId;
  if (ctx.userId !== undefined && record.userId === undefined) record.userId = ctx.userId;
  if (err) {
    record.err = {
      name: err.name,
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {})
    };
  }
  return record;
}

export class AppLogger {
  /**
   * @param {string} tag 模块标签（一般是点分路径，如 'auth.session'）
   * @param {object} [options] 实例级配置（优先级最高）
   *   - level: 'info'                    本模块最低级别
   *   - console: true|false              本模块控制台开关
   *   - file: true|false|{...}           本模块文件开关 / 独立文件配置（仅 Node）
   *       { name?, dir?, ext?, date?, error? }
   *       name: 文件名前缀；dir: 目录；ext: 扩展名（默认 .log）
   *       date: 是否带日期后缀（默认 true，false = 单文件不滚动）
   *       error: 错误文件开关（默认 true）或自定义前缀字符串
   *   - debug: true|false                true=本模块 debug 免关键词；false=强制静默
   */
  constructor(tag = 'app', options = null) {
    this.tag = tag;
    this.options = options ? { ...options } : null;
    this._variantCache = new Map();

    // 环境变体（可调用 = info 快捷；携带全部级别方法，可继续链式组合）：
    //   log.always(...) / log.always.error(...)
    //   log.dev(...)    / log.dev.debug(...)
    //   log.prod(...)   / log.prod.warn(...)
    //   log.file(...)   / log.file.error(...)   —— 只写文件、不进控制台
    this.always = this._variant(null, true, false);
    this.dev = this._variant('dev', false, false);
    this.prod = this._variant('prod', false, false);
    this.file = this._variant(null, false, true);
  }

  /**
   * 运行时更新本实例配置（返回自身，可链式）
   * @param {object} patch 同构造函数 options
   * @example log.config({ level: 'warn', file: { name: 'audit' } });
   */
  config(patch = {}) {
    this.options = { ...(this.options ?? {}), ...patch };
    this._variantCache.clear();
    return this;
  }

  /**
   * 构建"环境变体"：一个可调用对象（默认 info 级），同时携带全部级别方法，
   * 以及 always/dev/prod/file 组合选择器（顺序无关，后选覆盖前者）。
   *
   * @param {'dev'|'prod'|null} env 环境门控；null = 不限环境
   * @param {boolean} force true = 必输（绕过 LOG_LEVEL 与 LOG_DEBUG 门控）
   * @param {boolean} fileOnly true = 只写文件、不进控制台
   */
  _variant(env, force, fileOnly) {
    const key = `${env ?? '*'}|${force ? 1 : 0}|${fileOnly ? 1 : 0}`;
    const cached = this._variantCache.get(key);
    if (cached) return cached;

    const emit = (level, args) => this._emit(level, args, { force, env, fileOnly });

    const fn = (...args) => emit('info', args);
    for (const lv of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      fn[lv] = (...args) => emit(lv, args);
    }
    for (const gate of ['always', 'dev', 'prod', 'file']) {
      Object.defineProperty(fn, gate, {
        enumerable: false,
        get: () => {
          if (gate === 'always') return this._variant(env, true, fileOnly);
          if (gate === 'file') return this._variant(env, force, true);
          return this._variant(gate, force, fileOnly); // dev / prod
        }
      });
    }

    this._variantCache.set(key, fn);
    return fn;
  }

  /** 派生子 logger：createLogger('auth').child('session') → tag 'auth.session'（继承实例配置） */
  child(sub) {
    return new AppLogger(`${this.tag}.${sub}`, this.options ? { ...this.options } : null);
  }

  trace(...args) {
    this._emit('trace', args);
  }

  /** 调试日志：仅当 LOG_DEBUG 关键词命中本 tag（或实例 debug:true）时输出 */
  debug(...args) {
    this._emit('debug', args);
  }

  info(...args) {
    this._emit('info', args);
  }

  warn(...args) {
    this._emit('warn', args);
  }

  error(...args) {
    this._emit('error', args);
  }

  /** 最严重级别：进程级故障，文件通道同步写避免丢失 */
  fatal(...args) {
    this._emit('fatal', args, { force: true });
  }

  /**
   * 计时工具
   * @example const done = log.time('dbQuery'); ... ; done(); // 自动 info 耗时
   */
  time(label = 'timer') {
    const start = Date.now();
    return () => this.info(label, { ms: Date.now() - start });
  }

  /**
   * @param {string} level
   * @param {Array} args
   * @param {object|boolean} [opts] true=强制输出；或 { force, env, fileOnly, sync }
   */
  _emit(level, args, opts = {}) {
    const {
      force = false,
      env = null,
      fileOnly = false,
      sync = false
    } = typeof opts === 'boolean' ? { force: opts } : (opts ?? {});

    const cfg = getLogConfig();
    const inst = this.options;

    // 配置优先级：实例 options > 模块级环境变量规则 > 全局配置
    const rule = inst ? null : matchModuleRule(this.tag, cfg.modules);
    const threshold = LEVELS[inst?.level ?? rule?.level ?? cfg.level] ?? LEVELS.info;

    const consoleOn = inst?.console ?? rule?.console ?? cfg.consoleEnabled;
    let fileOn;
    const instFile = inst?.file;
    if (instFile === false) {
      fileOn = false;
    } else if (instFile === true || (instFile && typeof instFile === 'object')) {
      fileOn = true;
    } else {
      fileOn = rule?.file ?? cfg.fileEnabled;
    }
    const fileOpts = instFile && typeof instFile === 'object' ? instFile : null;

    // 环境门控：dev/prod 专属输出
    if (env === 'dev' && !cfg.showDev) return;
    if (env === 'prod' && !cfg.isProd) return;

    if (!force) {
      // debug/trace 门控：实例 debug 三态 > 关键词白名单（LOG_DEBUG / LOG_DEBUG_<模块>）
      if (LEVELS[level] <= LEVELS.debug) {
        if (inst?.debug === true) {
          // 实例显式放开，直通
        } else if (inst?.debug === false) {
          return;
        } else if (!isDebugTagEnabled(this.tag, cfg.debugKeywords)) {
          return;
        }
      } else if (LEVELS[level] < threshold) {
        return;
      }
    }

    const { msg, data, err } = parseArgs(args);
    const record = buildRecord(this.tag, level, msg, data, err);

    if (fileOnly) {
      // file 变体：只留档、不刷控制台（受文件开关约束）
      if (fileOn) fileTransport.write(record, cfg, sync || level === 'fatal', fileOpts);
      return;
    }
    if (consoleOn) consoleTransport.write(record, cfg);
    if (fileOn) fileTransport.write(record, cfg, sync || level === 'fatal', fileOpts);
  }
}
