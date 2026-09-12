/**
 * wb-log — 统一日志库（Node / 浏览器通用，零运行时依赖）
 *
 * ════════════════════════════════════════════════════════════════
 *  快速上手
 * ════════════════════════════════════════════════════════════════
 *   import { createLogger } from '@qirly/wb-log';
 *   const log = createLogger('auth.session');   // tag 建议 = 文件路径点分
 *
 *  零配置快捷用法（不建 logger，直接打印）：
 *   import { log } from '@qirly/wb-log';
 *   log.info('...'); log.error('...');           // tag='app'，跟随全局配置
 *   log.config({ level: 'debug' });              // 也可对默认 logger 做配置
 *
 *   log.info('用户登录', { userId });           // 常规日志
 *   log.warn('缓存降级', err);                  // 警告
 *   log.error('查询失败', err);                 // 错误（自动 stack）
 *   log.debug('缓存未命中', key);               // 调试：需 LOG_DEBUG=auth 或实例 debug:true
 *   log.fatal('进程级故障', err);               // 同步落盘（Node）
 *
 *  输出控制矩阵（两个正交维度，任意级别任意组合，顺序无关）：
 *   log.always.error('...')     必输（无视 LOG_LEVEL / LOG_DEBUG / 环境）
 *   log.dev.info('...')         仅开发环境（NODE_ENV !== 'production'，LOG_DEV 可覆盖）
 *   log.prod.error('...')       仅生产环境
 *   log.dev.always.info('...')  组合：仅开发 + 必输
 *   log.file.info('...')        只写文件、不刷控制台（留档，仅 Node）
 *
 *  实例级配置（优先级最高）：
 *   const log = createLogger('pay', { level: 'debug', file: { name: 'pay' } });
 *   log.config({ level: 'warn' });              // 运行时更新
 *
 *  全局编程配置：
 *   import { configureLog } from '@qirly/wb-log';
 *   configureLog({ level: 'warn', fileName: 'server', debugKeywords: ['auth'] });
 *
 *  CLI 工具面向用户的结果输出用 stdout（无时间戳装饰）：
 *   import { logStdout as stdout } from '@qirly/wb-log';
 *   stdout('✔ 完成');
 *
 * ════════════════════════════════════════════════════════════════
 *  环境变量（Node）
 * ════════════════════════════════════════════════════════════════
 *   LOG_LEVEL=info                     全局最低级别
 *   LOG_DEBUG=auth,redis,firewall.*    debug/trace 白名单；'*' 放开全部
 *   LOG_DIR=logs                       文件目录
 *   LOG_FILE_NAME=app                  主日志文件名前缀
 *   LOG_CONSOLE=true / LOG_FILE=true   通道开关
 *   LOG_PRETTY=true                    控制台彩色可读
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
  configureLog,
  isDebugTagEnabled,
  tagMatchesKeyword,
  matchModuleRule
} from './config.js';
import { setLogContextProvider } from './context.js';
import { stdout } from './transports.js';
import { sanitizeForLog, sanitizeUrl, sanitizeUserAgent } from './sanitize.js';

/**
 * 创建带模块 tag 的 logger（推荐入口）
 * @param {string} [tag] 模块标签，如 'auth.session'
 * @param {object} [options] 实例级配置 { level?, console?, file?, debug? }
 */
export function createLogger(tag, options = null) {
  return new AppLogger(tag || 'app', options);
}

/** 全局默认 logger（脚本/兜底场景用） */
export const logger = createLogger('app');

/**
 * 零配置快捷入口：`import { log } from '@qirly/wb-log'` 直接打印，
 * 无需 createLogger（等价于默认 logger，tag='app'，跟随全局配置）。
 */
export { logger as log };

export { stdout as logStdout, stdout };
export {
  getLogConfig,
  reloadLogConfig,
  configureLog,
  isDebugTagEnabled,
  tagMatchesKeyword,
  matchModuleRule,
  setLogContextProvider
};
export { sanitizeForLog, sanitizeUrl, sanitizeUserAgent };
export { AppLogger };

/**
 * 兼容旧 API：`import Logger from '@qirly/wb-log'` 后 Logger.info(...) 静态调用。
 * 内部委托给默认 logger（tag='app'）。
 */
class Logger {
  /**
   * 记录认证/授权事件（保留原签名）
   * @param {Object} ctx 兼容的请求上下文对象
   * @param {Object} options 日志选项
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

  static info(message, ...rest) {
    logger.info(message, ...rest);
  }

  static warn(message, ...rest) {
    logger.warn(message, ...rest);
  }

  static error(message, ...rest) {
    logger.error(message, ...rest);
  }

  static debug(...rest) {
    logger.debug(...rest);
  }

  static always(...rest) {
    logger.always(...rest);
  }

  static dev(...rest) {
    logger.dev(...rest);
  }

  static prod(...rest) {
    logger.prod(...rest);
  }
}

export { Logger };
export default Logger;
