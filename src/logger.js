/**
 * Logger 核心：console 兼容的变参签名 + tag 化 debug 白名单 + 实例级配置
 *
 * 用法（**公开入口只有 createLogger(tag, asGlobal)，配置一律走 config()**）：
 *   import { createLogger } from 'wb-logkit';
 *   const log = createLogger('auth.session');
 *
 *   log.info('用户登录', { userId: 1 });        // 对象入 data
 *   log.warn('配置缺失，使用默认值: %s', key);   // 变参自动拼接
 *   log.error('查询失败', err);                 // Error 自动提取 stack
 *   log.debug('缓存未命中', cacheKey);          // 仅当 LOG_DEBUG 关键词命中 tag 才输出
 *
 *   // 实例级配置（优先级高于模块级环境变量与全局配置），可随时热更新、可链式：
 *   log.config({
 *     level: 'debug',            // 本模块最低级别
 *     console: true,             // 本模块控制台开关
 *     consoleLevel: 'warn',      // 本模块控制台通道级别（只打 warn+）
 *     file: {                    // 给对象即开启本模块文件通道（Node）
 *       name: 'pay',             //   独立文件 logs/pay-YYYY-MM-DD.log
 *       level: 'all'             //   文件记全量（含 debug/trace）
 *     },
 *     debug: true                // 本模块 debug 免关键词直接输出
 *   });
 *
 * 矩阵控制（两个正交维度，任意级别任意组合，顺序无关）：
 *   log.always.error(...)        必输
 *   log.dev.info(...)            仅开发
 *   log.prod.error(...)          仅生产
 *   log.file.info(...)           只写文件不进控制台
 *
 * 门控语义（重要）：全局 `level` 管的是「默认行为」，**显式配置的通道级别优先**。
 * 例：写了 `file.level: 'all'`，即使全局 level=info，debug/trace 也会进文件。
 *
 * @author yijiu2025
 * @since 2026-09-10
 */
import { LEVELS, getLogConfig, isDebugTagEnabled, levelPasses, matchModuleRule, parseLevelOpt } from './config.js';
import { getLogContext } from './context.js';
import { writeRawStderr, warnOnce } from './degraded.js';
import { CORE_RECORD_KEYS, RESERVED_KEYS } from './record-schema.js';
import { safeStringify } from './safe-stringify.js';
import { sanitizeForLog } from './sanitize.js';
import { consoleTransport, fileTransport } from './transports.js';

/** 超长字符串截断后的标记模板（%d 会被替换为原始长度） */
const TRUNCATE_MARK = '…(len=%d)';

/**
 * 发送选项（`_emit` / `_emitInner` 的第三参；传 `true` 等价 `{ force: true }`）。
 * @typedef {object} EmitOpts
 * @property {boolean} [force=false] 必输：绕过 LOG_LEVEL 与 LOG_DEBUG 门控
 * @property {'dev'|'prod'|null} [env=null] 环境门控；null = 不限环境
 * @property {boolean} [fileOnly=false] 只写文件、不刷控制台
 */

/**
 * 生成当前时间的本地时区 ISO 8601 字符串（如 2026-09-13T23:30:00.123+08:00）。
 * 与文件滚动日期（本地时区）保持同一基准，避免跨午夜时文件名与内容时间对不上。
 * @returns {string} 含时区偏移的本地 ISO 时间串（可被 new Date() 直接解析）
 */
function localIsoTime() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  );
}

/**
 * 递归截断 record 中的超长字符串（外部输入兜底防护，防单条日志撑爆文件）。
 * @param {object} obj - 日志记录对象（调用前刚组装完，无外部引用，允许原地修改）
 * @param {number} max - 单字段字符串长度上限；<=0 时跳过截断
 * @param {number} [depth=4] - 递归深度限制（防深层嵌套对象遍历过深）
 * @returns {object} 截断后的同一 record（原地修改）
 */
function truncateStrings(obj, max, depth = 4) {
  if (max <= 0 || depth <= 0 || !obj || typeof obj !== 'object') return obj;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string') {
      if (v.length > max) obj[k] = v.slice(0, max) + TRUNCATE_MARK.replace('%d', String(v.length));
    } else if (v && typeof v === 'object') {
      truncateStrings(v, max, depth - 1);
    }
  }
  return obj;
}

/**
 * 判断值是否为可展开合并进 data 的普通对象。
 * @param {*} value - 任意值
 * @returns {boolean} true = null/数组/Error/Date 之外的纯对象（可浅合并）
 */
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
 * - Error      → err（取第一个，后续 Error 并入 data._extra_errors）
 * - 普通对象   → 浅合并进 data（递归脱敏）
 * - Date/数组  → 序列化为字符串
 * - 其他       → 空格拼接到 msg
 *
 * **不做 printf 风格插值**：与 `console.log('a %s', b)` 不同，本库不解析 `%s`/`%d` 占位符，
 * `%s` 会原样出现在 msg 里（需要格式化请先自行 `util.format` 或模板字符串）。
 *
 * @param {Array} args - 日志方法的原始变参（如 log.info('a', {b:1}, err) 的 arguments）
 * @returns {{msg: string, data: object, err: (Error|undefined)}} msg 为拼接后的消息
 *          （无显式消息且带 Error 时取 err.message），data 为脱敏合并后的业务字段，err 取第一个 Error
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
      // safeStringify：数组元素含循环引用/BigInt 时 JSON.stringify 会抛异常
      parts.push(safeStringify(sanitizeForLog(arg)));
      continue;
    }
    parts.push(String(arg));
  }

  let msg = parts.join(' ');
  if (!msg && err) msg = err.message;
  return { msg, data, err };
}

/**
 * 组装最终 record：固定字段在前，业务 data 命中保留键时整体让位到 data 键下；
 * ctx（requestId/userId 等）注入但绝不覆盖核心字段；最后做超长字符串兜底截断。
 * @param {string} tag - 模块标签（点分路径，如 'auth.session'）
 * @param {string} level - 本条日志级别
 * @param {string} msg - 解析后的消息
 * @param {object} data - 解析合并后的业务数据（已脱敏）
 * @param {Error|undefined} err - 第一个 Error 实参
 * @returns {object} 完整日志记录 { t, level, tag, msg, ...data|data, ...ctx, err? }
 */
function buildRecord(tag, level, msg, data, err) {
  const ctx = getLogContext();
  const record = { t: localIsoTime(), level, tag, msg };

  let payload = data;
  for (const key of Object.keys(data)) {
    if (RESERVED_KEYS.has(key)) {
      payload = { data };
      break;
    }
  }
  Object.assign(record, payload);

  // ctx 注入（requestId/userId 等）：核心字段受保护，绝不被外部 provider 覆盖
  for (const [k, v] of Object.entries(ctx)) {
    if (!CORE_RECORD_KEYS.has(k)) record[k] = v;
  }

  if (err) {
    record.err = {
      name: err.name,
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {})
    };
  }
  // 超长字符串兜底截断（外部输入防护；maxStr<=0 关闭）
  return truncateStrings(record, getLogConfig().maxStr ?? 2000);
}

export class AppLogger {
  /**
   * 创建模块 logger 实例（一般经 `createLogger(tag, asGlobal)` 创建，而非直接 new）。
   *
   * @param {string} [tag='app'] 模块标签（一般是点分路径，如 'auth.session'）
   * @param {LoggerOptions|null} [options=null] 实例级配置（优先级最高）。
   *        键定义以 `index.d.ts` 的 `LoggerOptions` 为单一事实来源，此处为摘要：
   *   - level: 'info'                    本模块最低级别
   *   - console: true|false              本模块控制台开关
   *   - consoleLevel: 'warn'|'all'|[]    本模块控制台通道级别（覆盖全局 consoleLevel）
   *   - file: true|false|{...}           本模块文件开关 / 独立文件配置（仅 Node）
   *       · 给**对象即开启**本模块文件通道（即使全局未开启文件）
   *       · 与全局 file 是**覆盖**关系而非叠加，因此不会重复写两份
   *       · 对象键：name（默认 = tag）/ dir / ext / date / dateDir / subdir /
   *         level（文件通道级别）/ keepDays / error / suffix
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
   * 运行时更新本实例配置（清空变体缓存后立即生效）。
   * @param {object} [patch={}] 同构造函数 options 的部分字段
   * @returns {AppLogger} 自身，可链式调用
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
   * 结构（对应 `index.d.ts` 的 `LogVariant`）：
   * - `fn(...args)` 等价 `fn.info(...args)`
   * - `fn.trace` / `fn.debug` / `fn.info` / `fn.warn` / `fn.error` / `fn.fatal` 指定级别
   * - `fn.always` / `fn.dev` / `fn.prod` / `fn.file` 为**不可枚举 getter**
   *   （`Object.defineProperty` + `enumerable: false`），返回组合后的新变体；
   *   因此 `Object.keys(fn)` / `JSON.stringify(fn)` 不会列出它们。
   *
   * 变体按 `env|force|fileOnly` 三元组缓存于 `_variantCache`，
   * 同一组合重复访问返回同一函数对象。
   *
   * @param {'dev'|'prod'|null} env - 环境门控；null = 不限环境
   * @param {boolean} force - true = 必输（绕过 LOG_LEVEL 与 LOG_DEBUG 门控）
   * @param {boolean} fileOnly - true = 只写文件、不进控制台
   * @returns {LogVariant} 可调用变体（函数 + 6 个级别方法 + 4 个不可枚举门控 getter）
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

  /**
   * 派生子 logger（继承本实例配置）。
   * @param {string} sub - 子段名，如 createLogger('auth').child('session') → tag 'auth.session'
   * @returns {AppLogger} 新实例（options 浅拷贝，互不影响）
   */
  child(sub) {
    return new AppLogger(`${this.tag}.${sub}`, this.options ? { ...this.options } : null);
  }

  /**
   * 追踪级日志：最详细；门控同 debug（LOG_DEBUG 关键词白名单 + LOG_LEVEL 门槛）。
   * @param {...*} args - 变参，解析规则见 parseArgs
   * @returns {void}
   */
  trace(...args) {
    this._emit('trace', args);
  }

  /**
   * 调试日志：仅当 LOG_DEBUG 关键词命中本 tag（或实例 debug:true）时输出。
   * @param {...*} args - 变参，解析规则见 parseArgs
   * @returns {void}
   */
  debug(...args) {
    this._emit('debug', args);
  }

  /**
   * 信息日志：默认级别，受 LOG_LEVEL 门槛控制。
   * @param {...*} args - 变参，解析规则见 parseArgs
   * @returns {void}
   */
  info(...args) {
    this._emit('info', args);
  }

  /**
   * 警告日志：同时写入错误文件（Node）。
   * @param {...*} args - 变参，解析规则见 parseArgs
   * @returns {void}
   */
  warn(...args) {
    this._emit('warn', args);
  }

  /**
   * 错误日志：走 stderr（Node），同时写入错误文件。
   * @param {...*} args - 变参，Error 实参自动提取 name/message/stack
   * @returns {void}
   */
  error(...args) {
    this._emit('error', args);
  }

  /**
   * 最严重级别：进程级故障，必输（绕过全部门控），文件通道同步写避免崩溃丢失。
   * @param {...*} args - 变参，解析规则见 parseArgs
   * @returns {void}
   */
  fatal(...args) {
    this._emit('fatal', args, { force: true });
  }

  /**
   * 计时工具。
   * @param {string} [label='timer'] - 计时标签（进 msg）
   * @returns {Function} 结束函数：调用时以 info 级输出 { ms: 耗时 }
   * @example const done = log.time('dbQuery'); ... ; done(); // 自动 info 耗时
   */
  time(label = 'timer') {
    const start = Date.now();
    return () => this.info(label, { ms: Date.now() - start });
  }

  /**
   * 统一发送入口：门控判定 → 变参解析 → 组装 record → 分发到各通道。
   * 整体兜底 try/catch：日志库自身故障绝不波及业务代码，失败时向 stderr
   * 裸写一条降级提示（浏览器退回 console.error）。
   * @param {string} level - 日志级别
   * @param {Array} args - 变参数组
   * @param {EmitOpts|boolean} [opts={}] 发送选项；传 true 等价 `{ force: true }`
   * @returns {void}
   */
  _emit(level, args, opts = {}) {
    try {
      this._emitInner(level, args, opts);
    } catch (err) {
      // 尽力向 stderr 裸写一条降级提示；浏览器退回 console.error。
      // 限流到「每错误码一次」——内部异常常是持续性的（如配置对象被写坏），
      // 不限制会把 stderr 刷爆，反而淹没真正有用的信息。
      warnOnce(
        `emit-${err?.name ?? 'Error'}-${err?.code ?? ''}`,
        `❌ [wb-logkit] 日志输出失败(level=${level}): ${err?.message ?? err}\n`
      );
    }
  }

  /**
   * _emit 的实际执行体（异常由 _emit 兜底捕获）。
   *
   * 配置优先级：实例 options > 模块级环境变量规则 > 全局配置。
   * 门控顺序：环境门控（dev/prod）→ debug/trace 门控 → 级别门槛 → 通道级白名单过滤。
   * 其中「显式配置的通道级别（consoleLevel / file.level）」优先级高于全局 level 门槛。
   *
   * 两条通道都被拦下时的兜底（防「日志静默消失」）：
   * - `fatal` 级别 → 无论通道开关如何，裸写一条 stderr（进程级故障不可丢失）
   * - `log.file.*` 但文件通道关闭 → stderr 去重告警一次（配置矛盾，而非正常过滤）
   *
   * @param {string} level - 日志级别
   * @param {Array} args - 变参数组
   * @param {EmitOpts|boolean} [opts={}] 发送选项；传 true 等价 `{ force: true }`
   * @returns {void}
   */
  _emitInner(level, args, opts = {}) {
    const { force = false, env = null, fileOnly = false } = typeof opts === 'boolean' ? { force: opts } : (opts ?? {});

    const cfg = getLogConfig();
    const inst = this.options;

    // 配置优先级：实例 options > 模块级环境变量规则 > 全局配置
    const rule = inst ? null : matchModuleRule(this.tag, cfg.modules);
    const threshold = LEVELS[inst?.level ?? rule?.level ?? cfg.level] ?? LEVELS.info;

    const consoleOn = inst?.console ?? rule?.console ?? cfg.consoleEnabled;
    let fileOn;
    const instFile = inst?.file;
    // fileOpts：传给文件通道的实例级配置。
    // 实例 file: true 时传空对象（不是 null），让运输层知道"实例明确要写文件"，
    // 从而在全局 fileEnabled=false 时依然落盘。
    let fileOpts = null;
    if (instFile === false) {
      fileOn = false;
    } else if (instFile === true) {
      fileOn = true;
      fileOpts = {};
    } else if (instFile && typeof instFile === 'object') {
      fileOn = true;
      fileOpts = instFile;
    } else {
      fileOn = rule?.file ?? cfg.fileEnabled;
    }

    const lv = LEVELS[level];

    // 通道级级别过滤（优先级：实例 > 全局）；null = 不限制
    // 归一为"允许的级别名数组"：'info' → info 及以上；'all' → 全部；
    // ['info','error'] → 仅这两个级别（白名单）
    // 全局值在 config.js 已归一，实例值需现场归一（实例是原始值，可能未解析）
    const consoleAllow =
      inst?.consoleLevel !== undefined ? parseLevelOpt(inst.consoleLevel) : (cfg.consoleLevel ?? null);
    const fileAllow = fileOpts?.level !== undefined ? parseLevelOpt(fileOpts.level) : (cfg.file?.level ?? null);

    // 环境门控：dev/prod 专属输出
    if (env === 'dev' && !cfg.showDev) return;
    if (env === 'prod' && !cfg.isProd) return;

    const consoleExplicit = consoleAllow != null;
    const fileExplicit = fileAllow != null;

    // debug/trace 是否经关键词/实例显式放开：放开时跳过"常规级别门槛"，
    // 因为 LOG_DEBUG 本身就是"我要看调试细节"的明确意图，不该再被门槛拦一次。
    // 但**显式配置**的通道级级别（consoleLevel / file.level）优先级更高，仍然生效。
    let debugUnlocked = false;

    if (!force) {
      if (lv <= LEVELS.debug) {
        // debug/trace 门控：实例 debug 三态 > 关键词白名单（LOG_DEBUG / LOG_DEBUG_<模块>）
        if (inst?.debug === true) {
          debugUnlocked = true;
        } else if (inst?.debug === false) {
          return;
        } else if (isDebugTagEnabled(this.tag, cfg.debugKeywords)) {
          debugUnlocked = true;
        } else if (consoleExplicit || fileExplicit) {
          // 用户显式写了通道级别（如 file.level='all' / consoleLevel='all'），
          // 说明"我明确知道要什么"，交由下面的按通道判定，不再要求关键词
          debugUnlocked = true;
        } else {
          return;
        }
      } else if (lv < threshold && !consoleExplicit && !fileExplicit) {
        // 低于全局门槛且没有任何显式通道级别时，整体丢弃。
        // 只要有显式通道级别（如 file.level='all'），就交由下面的按通道判定——
        // 门槛管的是"默认行为"，不该否掉用户明确写下的配置。
        return;
      }
    }

    // 通道级过滤：
    // - force（always）与 debug 关键词放行，跳过"常规级别门槛"
    // - 但用户**显式配置**的通道级级别（consoleLevel / file.level）优先级更高，仍生效
    //   例：file.level='all' → 即使全局 level=info，debug/trace 也进文件
    const consolePass = consoleExplicit ? levelPasses(consoleAllow, level) : force || debugUnlocked || lv >= threshold;
    const filePass = fileExplicit ? levelPasses(fileAllow, level) : force || debugUnlocked || lv >= threshold;

    let toConsole = consoleOn && consolePass;
    let toFile = fileOn && filePass;

    if (fileOnly) {
      // file 变体：只留档、不刷控制台
      toConsole = false;
    }

    // 两条通道都被过滤掉：无需完整构造 record，但要区分「正常门控过滤」与「配置错误」。
    // - 常规级别过滤（门槛/白名单没放行）属正常行为，静默即可
    // - 以下两种属**配置矛盾**，日志会静默消失，必须留痕（否则用户以为记上了）
    if (!toConsole && !toFile) {
      if (lv >= LEVELS.fatal) {
        // fatal 语义是「进程级故障」，必须有一条保底出口：
        // 即使控制台与文件被双双关闭，也要裸写 stderr（参考 traps.js 的 fd 2 兜底）
        const { msg } = parseArgs(args);
        writeRawStderr(`🚨 [${this.tag}] FATAL ${msg}\n`);
      } else if (fileOnly && !fileOn) {
        // log.file.* 要求写文件，但文件通道是关的 → 两头都没有，属配置矛盾
        warnOnce(
          'file-only-but-file-off',
          `⚠️ [wb-logkit] 调用了 log.file.* 但文件通道未开启，日志已丢弃（tag=${this.tag}）；请开启 file 配置或改用普通级别方法\n`
        );
      }
      return;
    }

    const { msg, data, err } = parseArgs(args);
    const record = buildRecord(this.tag, level, msg, data, err);

    if (toConsole) consoleTransport.write(record, cfg);
    if (toFile) fileTransport.write(record, cfg, level === 'fatal', fileOpts);
  }
}
