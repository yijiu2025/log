/**
 * 日志上下文提供器（解耦 auth 模块，避免循环依赖）
 *
 * framework/log 不直接 import auth；由 auth 框架初始化时调用
 * setLogContextProvider 注册提取函数，所有日志自动携带 requestId / userId。
 *
 * @author yijiu2025
 * @since 2026-09-10
 */

let contextProvider = null;

/**
 * 注册日志上下文提供器。
 * @param {() => object|undefined} fn - 返回 { requestId, userId, ... } 的函数，
 *        每次写日志时调用；传非函数（如 null）可注销
 * @returns {void}
 */
export function setLogContextProvider(fn) {
  contextProvider = typeof fn === 'function' ? fn : null;
}

/**
 * 获取当前日志上下文（任何异常都吞掉，绝不影响业务）。
 * @returns {object} provider 返回的上下文对象；未注册/异常/返回值非法时返回 {}
 */
export function getLogContext() {
  if (!contextProvider) return {};
  try {
    const ctx = contextProvider();
    return ctx && typeof ctx === 'object' ? ctx : {};
  } catch {
    // 上下文提取失败静默降级（如 ALS 未初始化）
    return {};
  }
}
