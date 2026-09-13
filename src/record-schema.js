/**
 * 日志记录的保留字段定义（logger 与 transports 共用，单一事实来源）
 *
 * - CORE_RECORD_KEYS：记录核心字段，context provider 等外部注入绝不覆盖
 * - RESERVED_KEYS：核心字段 + 常用上下文字段；业务 data 命中时整体让位到 data 键下
 *
 * @author yijiu2025
 * @since 2026-09-13
 */

/** 记录核心字段（注入时受保护，不可被覆盖） */
export const CORE_RECORD_KEYS = new Set(['t', 'level', 'tag', 'msg', 'err']);

/** 保留字段：业务 data 命中任一键时，整个 data 包一层放到 record.data 下 */
export const RESERVED_KEYS = new Set(['t', 'level', 'tag', 'msg', 'err', 'requestId', 'userId']);
