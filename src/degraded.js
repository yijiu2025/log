/**
 * 降级告警出口：日志库自身出故障时唯一的「留痕」通道
 *
 * 为什么需要独立模块：日志库的职责是记录别人的问题，它自己出故障时**不能沉默**——
 * 但也不能把异常抛进业务代码，更不能用 console.*（全项目 ESLint no-console: error）；
 * 因此统一走 stderr 裸写（浏览器退回 console.error）。
 *
 * 两个使用场景：
 *   1. `_emit` 捕获到内部异常 → 本次日志输出失败
 *   2. 文件通道写入失败 / fatal 无可用通道 → 日志静默丢失
 *
 * 限流：磁盘满、目录不可写等故障会**持续**触发，若每条日志都提示会形成 stderr 风暴，
 * 反而淹没真正有用的信息。因此按「错误标识」去重，同一类故障每进程只提示一次。
 *
 * @author yijiu2025
 * @since 2026-09-14
 */

/** 已提示过的告警标识（按 key 去重，进程内累计） */
const warnedKeys = new Set();

/**
 * 向 stderr 裸写一行降级提示（不抛异常、不做任何门控）。
 *
 * 优先 `process.stderr.write`（Node，同步流，崩溃前也能写出）；
 * 无 process 时退回 `console.error`（浏览器）。
 *
 * @param {string} line - 完整提示行（调用方自行带 emoji 前缀；建议以换行结尾）
 * @returns {void}
 */
export function writeRawStderr(line) {
  try {
    if (typeof process !== 'undefined' && process.stderr?.write) {
      process.stderr.write(line);
    } else {
      globalThis.console?.error?.(line);
    }
  } catch {
    // 连 stderr 都写不了（如 fd 已关闭）：彻底放弃，绝不抛出
  }
}

/**
 * 带限流的降级告警：同一 `key` 每进程只输出一次。
 *
 * @param {string} key - 告警标识（如 `file-ENOSPC` / `fatal-no-channel`），相同标识只提示一次
 * @param {string} line - 提示内容（建议以换行结尾）
 * @returns {boolean} true = 本次实际输出了提示；false = 已被限流跳过
 */
export function warnOnce(key, line) {
  if (warnedKeys.has(key)) return false;
  warnedKeys.add(key);
  writeRawStderr(line);
  return true;
}

/**
 * 清空限流账本（仅供测试使用）。
 * @returns {void}
 */
export function _resetWarnedKeys() {
  warnedKeys.clear();
}
