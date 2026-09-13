/**
 * 日志输出通道：控制台（pretty / JSON，通用）+ 文件（仅 Node，动态加载）
 *
 * - 控制台：Node 开发环境彩色人类可读，production 输出单行 JSON；浏览器用 console.* 降级
 * - 文件：仅 Node；浏览器环境自动为空实现（前端复用时零配置可用）
 * - fatal/error 走 stderr（Node），其余走 stdout
 * - 文件流惰性创建（首次写入时），按日期变化自动滚动，进程退出时同步刷盘
 *
 * @author yijiu2025
 * @since 2026-09-11
 */

import { RESERVED_KEYS } from './record-schema.js';
import { safeStringify } from './safe-stringify.js';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

const LEVEL_COLORS = { trace: 90, debug: 90, info: 32, warn: 33, error: 31, fatal: 35 };
const RESET = '\x1b[0m';

/** 本地时间 HH:mm:ss.SSS（用于 pretty 输出） */
function prettyTime(iso) {
  const d = new Date(iso);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function useColor() {
  // 仅真实 TTY 上色；管道/重定向（isTTY 为 undefined）不输出 ANSI，
  // 避免污染 docker/pm2/日志收集端的纯文本与 JSON 日志
  return isNode && process.stdout?.isTTY === true;
}

function paint(text, code, enabled) {
  if (!enabled || !code) return text;
  return `\x1b[${code}m${text}${RESET}`;
}

/* ------------------------------------------------------------------ */
/* 控制台通道（通用）                                                   */
/* ------------------------------------------------------------------ */

/** 组装 data/err 的紧凑展示串（pretty 模式用） */
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
   * @param {object} record 结构化日志记录
   * @param {object} cfg getLogConfig() 结果
   */
  write(record, cfg) {
    if (!cfg.consoleEnabled) return;
    try {
      const isError = record.level === 'error' || record.level === 'fatal';
      const line = cfg.pretty ? formatPretty(record) : safeStringify(record);
      if (isNode) {
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

let fileTransport = {
  write() {},
  close() {}
};

/**
 * 注入文件通道实现（仅 Node 入口调用；浏览器保持空实现）
 * @param {{write: Function, close: Function}} transport
 */
export function setFileTransport(transport) {
  if (transport && typeof transport.write === 'function') {
    fileTransport = transport;
  }
}

/* ------------------------------------------------------------------ */
/* 原始 stdout 出口（CLI 人机交互输出 / 浏览器 console 降级）             */
/* ------------------------------------------------------------------ */

/** 无时间戳/级别装饰的原始输出，供 CLI 工具打印面向用户的结果 */
function stdout(text) {
  if (isNode) {
    process.stdout.write(String(text) + '\n');
  } else {
    const c = globalThis.console;
    (c.log ?? c.error).call(c, String(text));
  }
}

export { consoleTransport, fileTransport, stdout, isNode };
