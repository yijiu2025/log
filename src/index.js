/**
 * wb-logkit — 统一日志库（Node / 浏览器通用，零运行时依赖）
 *
 * ════════════════════════════════════════════════════════════════
 *  快速上手
 * ════════════════════════════════════════════════════════════════
 *   import { createLogger } from 'wb-logkit';
 *   const log = createLogger('auth.session');   // tag 建议 = 文件路径点分
 *
 *   log.info('用户登录', { userId });           // 常规日志（对象并入 data）
 *   log.warn('缓存降级', err);                  // 警告
 *   log.error('查询失败', err);                 // 错误（自动提取 stack）
 *   log.debug('缓存未命中', key);               // 调试：需 LOG_DEBUG 关键词或实例 debug:true
 *   log.fatal('进程级故障', err);               // 必输 + 同步落盘（Node）
 *
 *  ⚠️ createLogger **只有两个参数**：(tag, asGlobal)。其余配置一律走 config()。
 *
 *   // ① 注册为全局 log（入口文件执行一次），其他文件直接 import { log }
 *   createLogger('app', true);
 *
 *   // ② 单模块配置（运行时热更新，可链式）
 *   createLogger('pay').config({ level: 'debug', file: { name: 'pay', level: 'all' } });
 *
 *  零配置快捷用法（不建 logger，直接用全局 log；未注册时 tag='app'）：
 *   import { log } from 'wb-logkit';
 *   log.info('...'); log.error('...');           // 跟随全局配置
 *   log.config({ level: 'debug' });              // 也可对全局 log 做配置
 *
 *  输出控制矩阵（两个正交维度，任意级别任意组合，顺序无关）：
 *   log.always.error('...')     必输（无视 LOG_LEVEL / LOG_DEBUG / 环境）
 *   log.dev.info('...')         仅开发环境（NODE_ENV !== 'production'，LOG_DEV 可覆盖）
 *   log.prod.error('...')       仅生产环境
 *   log.dev.always.info('...')  组合：仅开发 + 必输
 *   log.file.info('...')        只写文件、不刷控制台（留档，仅 Node）
 *
 *  CLI 工具面向用户的结果输出用 stdout（无时间戳装饰）：
 *   import { logStdout as stdout } from 'wb-logkit';
 *   stdout('✔ 完成');
 *
 * ════════════════════════════════════════════════════════════════
 *  环境变量（Node）
 * ════════════════════════════════════════════════════════════════
 *   LOG_LEVEL=info                     全局最低级别
 *   LOG_DEBUG=auth,redis,firewall.*    debug/trace 白名单；'*' 放开全部
 *   LOG_CONSOLE=true                   控制台开关（默认 true）
 *   LOG_CONSOLE_LEVEL=warn             控制台通道级别（默认跟随 LOG_LEVEL）
 *   LOG_FILE=false                     文件开关（**默认 false = 不写文件**，需显式开启）
 *   LOG_FILE_LEVEL=all                 文件通道级别（默认跟随 LOG_LEVEL）
 *   LOG_DIR=logs                       文件目录
 *   LOG_FILE_NAME=app                  主日志文件名前缀
 *   LOG_FILE_EXT=.log                  文件扩展名
 *   LOG_FILE_DATE=true                 文件名日期后缀（off = 单文件）
 *   LOG_DATE_DIR=false                 日期作为子目录 logs/2026-09-12/app.log
 *   LOG_SUBDIR=auto                    模块子目录：auto = 按 tag 首段分类；或固定目录名
 *   LOG_ERROR_FILE=true                错误文件开关（off 关闭；或自定义前缀）
 *   LOG_KEEP_DAYS=30                   滚动日志保留天数（0 = 不清理）
 *   LOG_FILE_SUFFIX=pid                文件名后缀：pid = 进程号（多进程防行交错）
 *   LOG_MAX_STR=2000                   单字段字符串长度上限（0 = 关闭截断）
 *   LOG_PRETTY=true                    控制台彩色可读
 *   LOG_DEV=true                       dev 专属输出显示开关
 *   LOG_LEVEL_AUTH=info                模块级级别覆盖
 *   LOG_CONSOLE_REDIS=off              模块级控制台开关
 *   LOG_FILE_CLI=false                 模块级文件开关
 *
 * 浏览器环境自动降级：无文件通道，控制台经 console.* 输出，其余能力一致。
 *
 * @author yijiu2025
 * @since 2026-09-11
 */
import { AppLogger } from './logger.js';
import {
  getLogConfig,
  reloadLogConfig,
  resetLogConfig,
  configureLog,
  isDebugTagEnabled,
  tagMatchesKeyword,
  matchModuleRule
} from './config.js';
import { setLogContextProvider } from './context.js';
import { safeStringify } from './safe-stringify.js';
import { stdout } from './transports.js';
import { sanitizeForLog, sanitizeUrl, sanitizeUserAgent } from './sanitize.js';

/**
 * 创建带模块 tag 的 logger。
 *
 * **只有两个参数**：tag、是否注册为全局。所有其他配置一律走 `config()`。
 *
 *   1. `createLogger('pay')`        —— 普通实例，本文件内使用
 *   2. `createLogger('pay', true)`  —— **注册为全局 log**：
 *        注册后其他文件直接 `import { log }` 即可用这个实例，无需再 createLogger。
 *        放在入口文件（index.js / app.js）头部执行一次。
 *        全局 log 是单例，后注册的覆盖先注册的。
 *
 *   之后一律用 config() 做配置（可随时运行时改）：
 *     const log = createLogger('pay');
 *     log.config({ level: 'info', file: { name: 'pay', level: 'all' } });
 *
 * @param {string} [tag='app'] 模块标签，如 'auth.session'
 * @param {boolean} [asGlobal=false] true = 注册为全局 log
 * @returns {AppLogger} logger 实例（级别方法 + always/dev/prod/file 变体 + config/child/time）
 * @example
 *   // app.js 头部：注册全局
 *   createLogger('app', true);
 *   // 其他文件：直接使用，无需再创建
 *   import { log } from 'wb-logkit';
 *   log.info('...');
 */
export function createLogger(tag, asGlobal = false) {
  const instance = new AppLogger(tag || 'app', null);
  if (asGlobal === true) registerGlobalLogger(instance);
  return instance;
}

/** 全局已注册的 logger（null = 未注册，回退到默认 logger） */
let globalLogger = null;

/** 默认 app logger：未注册全局时 log 指向它 */
const defaultLogger = new AppLogger('app');

/**
 * 全局 log 门面：始终把属性读写委托给"当前全局实例"。
 *
 * 为什么用 Proxy 而不是直接导出实例：ESM 的 `const` 导出无法重新赋值，
 * 而注册通常是后发生的（app.js / index.js 头部）。Proxy 让 `import { log }`
 * 拿到的引用永久有效，且注册、`log.config()` 运行时改写都能实时反映。
 */
const globalFacade = new Proxy(defaultLogger, {
  get(_target, prop) {
    const active = globalLogger || defaultLogger;
    const value = active[prop];
    return typeof value === 'function' ? value.bind(active) : value;
  },
  set(_target, prop, value) {
    const active = globalLogger || defaultLogger;
    active[prop] = value;
    return true;
  },
  has(_target, prop) {
    return prop in (globalLogger || defaultLogger);
  }
});

/**
 * 把某个 logger 注册为全局 log（`import { log }` 拿到它）。
 * 之后对实例调用 `.config()` 会实时反映到全局 log（同一个对象）。
 * @param {AppLogger} instance
 * @returns {AppLogger} 传入的实例
 */
export function registerGlobalLogger(instance) {
  if (!instance || typeof instance.info !== 'function') return instance;
  globalLogger = instance;
  return instance;
}

/** 返回当前全局 log 实例（未注册时为默认 app logger） */
export function getGlobalLogger() {
  return globalLogger || defaultLogger;
}

/** 全局默认 logger（脚本/兜底场景用，tag='app'） */
export const logger = globalFacade;

/**
 * 零配置快捷入口：`import { log } from 'wb-logkit'` 直接打印，
 * 无需 createLogger（等价于默认 logger，tag='app'，跟随全局配置）。
 */
export { logger as log };

export { stdout as logStdout, stdout };
export {
  getLogConfig,
  reloadLogConfig,
  resetLogConfig,
  configureLog,
  isDebugTagEnabled,
  tagMatchesKeyword,
  matchModuleRule,
  setLogContextProvider
};
export { sanitizeForLog, sanitizeUrl, sanitizeUserAgent };
export { safeStringify };
export { AppLogger };

/**
 * 兼容旧 API：`import Logger from 'wb-logkit'` 后 Logger.info(...) 静态调用。
 * 内部委托给默认 logger（tag='app'）。
 */
class Logger {
  /**
   * 记录认证/授权事件（保留原签名）
   * @param {Object} ctx - 兼容的请求上下文对象（读取 state.clientInfo / request.id）
   * @param {object} [options] - 日志选项 { event, uid, appId, details }
   * @returns {Promise<void>}
   */
  static async auth(ctx, { event, uid, appId, details = {} } = {}) {
    const { ip, region, city } = ctx?.state?.clientInfo || {};
    const location = region ? `${region}-${city}` : 'Unknown';
    const requestId = ctx?.request?.id;
    logger.info(`[AuthLog] ${event}`, {
      type: 'AUTH',
      event,
      uid: uid || 'Guest',
      appId: appId || 'N/A',
      requestId,
      ip,
      location,
      details
    });
  }

  /** 信息日志（委托给默认 logger） */
  static info(message, ...rest) {
    logger.info(message, ...rest);
  }

  /** 警告日志（委托给默认 logger） */
  static warn(message, ...rest) {
    logger.warn(message, ...rest);
  }

  /** 错误日志（委托给默认 logger） */
  static error(message, ...rest) {
    logger.error(message, ...rest);
  }

  /** 调试日志：需 LOG_DEBUG 关键词命中 'app'（委托给默认 logger） */
  static debug(...rest) {
    logger.debug(...rest);
  }

  /** 必输日志：绕过全部门控（委托给默认 logger） */
  static always(...rest) {
    logger.always(...rest);
  }

  /** 仅开发环境输出（委托给默认 logger） */
  static dev(...rest) {
    logger.dev(...rest);
  }

  /** 仅生产环境输出（委托给默认 logger） */
  static prod(...rest) {
    logger.prod(...rest);
  }
}

export { Logger };
export default Logger;
