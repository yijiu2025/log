/**
 * wb-log 类型定义（Node / 浏览器通用）
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** 实例级配置（优先级高于模块级环境变量与全局配置） */
export interface LoggerOptions {
  /** 本模块最低级别（默认跟随全局 LOG_LEVEL / LOG_LEVEL_<模块>） */
  level?: LogLevel;
  /** 本模块控制台开关 */
  console?: boolean;
  /**
   * 本模块文件开关 / 独立文件配置（仅 Node 生效，浏览器忽略）
   * - true：跟随全局通道
   * - false：本模块不写文件
   * - 对象：写独立文件
   *   - name：文件名前缀（生成 `<dir>/<name>[-日期]<ext>`）
   *   - dir：目录（默认跟随全局）
   *   - ext：扩展名（默认 '.log'）
   *   - date：是否带日期后缀（默认 true；false = 单文件不按天滚动）
   *   - error：错误文件开关（默认 true）或自定义前缀字符串
   */
  file?: boolean | {
    name?: string;
    dir?: string;
    ext?: string;
    date?: boolean;
    error?: boolean | string;
  };
  /** true = 本模块 debug/trace 免关键词直通；false = 强制静默 */
  debug?: boolean;
}

/** 日志变体：可调用（= info 快捷）+ 全部级别方法 + 可继续链式组合 */
export interface LogVariant {
  (...args: unknown[]): void;
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
  /** 必输（绕过 LOG_LEVEL / LOG_DEBUG 门控） */
  readonly always: LogVariant;
  /** 仅开发环境（NODE_ENV !== 'production'） */
  readonly dev: LogVariant;
  /** 仅生产环境 */
  readonly prod: LogVariant;
  /** 只写文件、不进控制台（仅 Node） */
  readonly file: LogVariant;
}

export interface AppLogger extends LogVariant {
  /** 模块标签 */
  readonly tag: string;
  /** 运行时更新实例配置（返回自身，可链式） */
  config(patch: LoggerOptions): AppLogger;
  /** 派生子 logger（继承实例配置） */
  child(sub: string): AppLogger;
  /** 计时器：const done = log.time('db'); ...; done(); */
  time(label?: string): () => void;
}

/** 全局编程配置（优先级高于环境变量，热生效） */
export interface LogGlobalOptions {
  level?: LogLevel;
  dir?: string;
  fileName?: string;
  ext?: string;
  fileDate?: boolean;
  fileError?: boolean | string;
  console?: boolean;
  file?: boolean | {
    name?: string;
    dir?: string;
    ext?: string;
    date?: boolean;
    error?: boolean | string;
  };
  pretty?: boolean;
  showDev?: boolean;
  debugKeywords?: string | string[];
}

/** 日志上下文（自动注入每条记录） */
export interface LogContext {
  requestId?: string | number;
  userId?: string | number;
  [key: string]: unknown;
}

export declare function createLogger(tag?: string, options?: LoggerOptions): AppLogger;
export declare const logger: AppLogger;
/** 零配置快捷入口（= 默认 logger，tag 'app'） */
export declare const log: AppLogger;
export declare function configureLog(patch: LogGlobalOptions): Record<string, unknown>;
export declare function getLogConfig(): Readonly<Record<string, unknown>>;
export declare function reloadLogConfig(): Readonly<Record<string, unknown>>;
export declare function setLogContextProvider(fn: () => LogContext | undefined): void;
export declare function isDebugTagEnabled(tag: string, keywords: Set<string>): boolean;
export declare function tagMatchesKeyword(tag: string, kw: string): boolean;
export declare function matchModuleRule(
  tag: string,
  modules: Map<string, object>
): object | null;
export declare function logStdout(text: unknown): void;
export declare const stdout: (text: unknown) => void;
export declare function sanitizeForLog<T>(obj: T, depth?: number): T;
export declare function sanitizeUrl(url: string): string;
export declare function sanitizeUserAgent(ua: string): string;
export declare const AppLogger: new (tag?: string, options?: LoggerOptions | null) => AppLogger;

/** 兼容旧 API：静态调用委托给默认 logger */
declare const LoggerDefault: {
  auth(
    ctx: unknown,
    options?: { event: string; uid?: string; appId?: string; details?: object }
  ): Promise<void>;
  info(message: unknown, ...rest: unknown[]): void;
  warn(message: unknown, ...rest: unknown[]): void;
  error(message: unknown, ...rest: unknown[]): void;
  debug(...rest: unknown[]): void;
  always(...rest: unknown[]): void;
  dev(...rest: unknown[]): void;
  prod(...rest: unknown[]): void;
};
export default LoggerDefault;
export { LoggerDefault as Logger };
