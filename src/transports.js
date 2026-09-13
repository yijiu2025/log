/**
 * 日志输出通道：控制台（pretty / JSON，通用）+ 文件（仅 Node，动态加载）
 *
 * - 控制台：Node 开发环境彩色人类可读，production 输出单行 JSON；浏览器用 console.* 降级
 * - 文件：仅 Node；浏览器环境自动为空实现（前端复用时零配置可用）
 * - fatal/error 走 stderr（Node），其余走 stdout
 * - 文件通道由 Node 入口（index.node.js）经 setFileTransport 注入，本文件不直接依赖 node:fs
 *
 * @author yijiu2025
 * @since 2026-09-11
 */
import { RESERVED_KEYS } from './record-schema.js';
import { safeStringify } from './safe-stringify.js';

/** 运行环境是否为 Node（浏览器为 false，文件通道与 fd 直写均按此降级） */
const isNode = typeof process !== 'undefined' && !!process.versions?.node;

/** 各日志级别的 ANSI 颜色码（无色时 paint 直接返回原文） */
const LEVEL_COLORS = { trace: 90, debug: 90, info: 32, warn: 33, error: 31, fatal: 35 };
const RESET = '\x1b[0m';

/**
 * 本地时间 HH:mm:ss.SSS（用于 pretty 输出）。
 * @param {string} iso - record.t 的 ISO 8601 时间串（含时区偏移）
 * @returns {string} 如 '14:05:09.123'（按本地时区解析展示）
 */
function prettyTime(iso) {
  const d = new Date(iso);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * 是否启用 ANSI 颜色：仅真实 TTY 上色；管道/重定向（isTTY 为 undefined）
 * 不输出 ANSI，避免污染 docker/pm2/日志收集端的纯文本与 JSON 日志。
 * @returns {boolean} Node 且 stdout 为交互式终端时 true；浏览器恒为 false
 */
function useColor() {
  return isNode && process.stdout?.isTTY === true;
}

/**
 * 按 ANSI 颜色码包裹文本。
 * @param {string} text - 原文
 * @param {number} code - ANSI 颜色码（0 视为无色）
 * @param {boolean} enabled - 颜色总开关（useColor() 结果）
 * @returns {string} enabled 且 code 非 0 时返回 '\x1b[<code>m…\x1b[0m'，否则原样返回 text
 */
function paint(text, code, enabled) {
  if (!enabled || !code) return text;
  return `\x1b[${code}m${text}${RESET}`;
}

/**
 * 组装 record 中除保留字段外的业务数据展示串（pretty 模式用）。
 * @param {object} record - 结构化日志记录（buildRecord 的产物）
 * @returns {string} 有业务数据时返回其紧凑 JSON 串；无则返回 ''；
 *          record.err 无 stack 时追加 ' err={...}'（有 stack 的由 formatPretty 换行独立展示）
 */
function buildExtraPayload(record) {
  const payload = {};
  for (const [k, v] of Object.entries(record)) {
    if (!RESERVED_KEYS.has(k)) payload[k] = v;
  }
  let str = Object.keys(payload).length ? safeStringify(payload) : '';
  if (record.err && !record.err.stack) {
    str = `${str ? `${str} ` : ''}err=${safeStringify(record.err)}`;
  }
  return str;
}

/**
 * 组装 pretty 模式的人类可读单行（含 ANSI 颜色，受 useColor 控制）。
 * @param {object} record - 结构化日志记录 { t, level, tag, msg, err?, requestId?, ...data }
 * @returns {string} 格式：'HH:mm:ss.sss LEVEL [tag] msg (req:id) {data}'；
 *          record.err.stack 存在时堆栈另起一行（红色）追加在末尾
 */
function formatPretty(record) {
  const color = useColor();
  const lvl = paint(record.level.toUpperCase().padEnd(5), LEVEL_COLORS[record.level] || 0, color);
  const tag = paint(`[${record.tag}]`, 36, color);
  const time = paint(prettyTime(record.t), 90, color);
  const reqId = record.requestId !== undefined ? paint(` (req:${record.requestId})`, 90, color) : '';
  const extra = buildExtraPayload(record);
  const head = `${time} ${lvl} ${tag} ${record.msg ?? ''}${reqId}`;
  const extraStr = extra ? ` ${paint(extra, 2, color)}` : '';
  if (record.err?.stack) {
    return `${head}${extraStr}\n${paint(String(record.err.stack), 31, color)}`;
  }
  return `${head}${extraStr}`;
}

const consoleTransport = {
  /**
   * 控制台通道写入口：pretty 人类可读 / 非 pretty 单行 JSON。
   * 任何异常静默（输出通道失败绝不影响业务）。
   * @param {object} record - 结构化日志记录（buildRecord 的产物）
   * @param {object} cfg - getLogConfig() 的全局配置（读 consoleEnabled / pretty）
   * @returns {void}
   */
  write(record, cfg) {
    if (!cfg.consoleEnabled) return;
    try {
      const isError = record.level === 'error' || record.level === 'fatal';
      const line = cfg.pretty ? formatPretty(record) : safeStringify(record);
      if (isNode) {
        // error/fatal 走 stderr，便于运维按流分级重定向；其余走 stdout
        const target = isError ? process.stderr : process.stdout;
        target.write(line + '\n');
      } else {
        // 浏览器降级：error/fatal 走 console.error（红字 + 堆栈面板），其余 console.log
        const c = globalThis.console;
        const fn = isError ? (c.error ?? c.log) : (c.log ?? c.error);
        fn.call(c, line);
      }
    } catch {
      // 输出通道失败绝不影响业务
    }
  }
};

/* ------------------------------------------------------------------ */
/* 文件通道（默认空实现；Node 入口 index.node.js 注入真实实现）          */
/* ------------------------------------------------------------------ */

/**
 * 文件通道句柄。浏览器环境保持空实现（写文件调用全部退化为 no-op）；
 * Node 入口经 setFileTransport 注入 NodeFileTransport。
 * @type {{write: Function, close: Function}}
 */
let fileTransport = {
  /** no-op 占位：浏览器无文件通道 */
  write() {},
  /** no-op 占位：同步写入无缓冲，无需刷盘 */
  close() {}
};

/**
 * 注入文件通道实现（仅 Node 入口 index.node.js 启动时调用一次）。
 * @param {{write: Function, close: Function}} transport - 文件通道实现；
 *        write(record, cfg, sync, fileOpts)，close() 供进程退出前调用。
 *        非法入参（缺 write 方法）静默忽略，保持原通道不变。
 * @returns {void}
 */
export function setFileTransport(transport) {
  if (transport && typeof transport.write === 'function') {
    fileTransport = transport;
  }
}

/* ------------------------------------------------------------------ */
/* 原始 stdout 出口（CLI 人机交互输出 / 浏览器 console 降级）             */
/* ------------------------------------------------------------------ */

/**
 * 无时间戳/级别装饰的原始输出，供 CLI 工具打印面向用户的结果（区别于日志流）。
 * @param {*} text - 任意值，经 String() 转换后输出，自动补换行
 * @returns {void}
 */
function stdout(text) {
  if (isNode) {
    process.stdout.write(String(text) + '\n');
  } else {
    const c = globalThis.console;
    (c.log ?? c.error).call(c, String(text));
  }
}

export { consoleTransport, fileTransport, stdout, isNode };
