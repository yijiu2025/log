/**
 * 安全序列化：永不抛异常的 JSON.stringify 替代
 *
 * JSON.stringify 遇到循环引用、BigInt 会直接抛 TypeError——发生在日志库内部时，
 * 轻则该行日志静默丢失，重则把异常抛进业务代码。本模块保证任何输入都返回字符串：
 * - 循环引用   → '[Circular]'
 * - BigInt     → '123n' 字符串
 * - Symbol     → 'Symbol(x)' 字符串
 * - function   → '[Function: name]'
 * - 其他意外错误 → '[unserializable]'
 *
 * @author yijiu2025
 * @since 2026-09-13
 */

/** JSON.stringify 的降级占位符（顶层返回值兜底用） */
const FALLBACK = '"[unserializable]"';

/**
 * 安全序列化任意值，任何输入都不抛异常
 * @param {*} value 任意值（含循环引用 / BigInt / Symbol）
 * @param {number|string} [space] 缩进，透传给 JSON.stringify
 * @returns {string} JSON 字符串（顶层 undefined 返回 'undefined' 字面量）
 */
export function safeStringify(value, space) {
  const seen = new WeakSet();
  try {
    return (
      JSON.stringify(
        value,
        (key, val) => {
          if (typeof val === 'bigint') return `${val}n`;
          if (typeof val === 'symbol') return val.toString();
          if (typeof val === 'function') {
            return `[Function${val.name ? `: ${val.name}` : ''}]`;
          }
          if (val !== null && typeof val === 'object') {
            if (seen.has(val)) return '[Circular]';
            seen.add(val);
          }
          return val;
        },
        space
      ) ?? 'undefined'
    );
  } catch {
    return FALLBACK;
  }
}
