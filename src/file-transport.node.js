/**
 * Node 文件通道：JSON 行、按天滚动、文件命名全可配、过期自动清理
 *
 * 仅由 index.node.js（Node 入口）注入；浏览器不会打包此文件。
 *
 * 同步写入（appendFileSync）：本库面向中小服务量级，同步开销可忽略，
 * 换取进程崩溃不丢日志 + 写入立即可见（测试/退出语义简单）。
 *
 * 文件命名（可经全局 configureLog({ file }) 或实例 file:{...} 覆盖）：
 *   <name>[-YYYY-MM-DD]<ext>        主日志（全部级别）
 *   <errorBase>[-YYYY-MM-DD]<ext>   错误文件（warn 及以上；error:false 关闭，
 *                                   error:'自定义前缀' 指定名称；默认规则：
 *                                   全局默认前缀时为 error，自定义前缀 name 时为 <name>-error）
 *
 * 保留天数（keepDays，默认 30）：
 *   每天首次写入时清理目录中"日志命名模式"的过期文件（按文件名中的日期判断，
 *   只删除与当前写入模式匹配的 <前缀>-YYYY-MM-DD<ext>，不碰任何其他文件）。
 *   keepDays: 0 或 false 关闭清理。
 *
 * @author yijiu2025
 * @since 2026-09-11
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** 本地日期字符串 YYYY-MM-DD（用于文件滚动） */
function fileDateString() {
  return new Date().toLocaleDateString('sv-SE');
}

/** 错误文件前缀：显式字符串 > 全局默认前缀（沿用旧约定 error）> 自定义 name（<name>-error） */
function resolveErrorBase(errorOpt, name, isGlobalDefaultName) {
  if (typeof errorOpt === 'string') return errorOpt;
  if (isGlobalDefaultName) return 'error';
  return `${name}-error`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class NodeFileTransport {
  constructor() {
    /** 已确认存在的目录（避免每条日志都 mkdirSync） */
    this.dirsCreated = new Set();
    /** @type {Set<string>} 本次进程内已执行过清理的目录+前缀（每天最多一次） */
    this.cleanedKeys = new Set();
    /** 上次写入的日期（用于触发跨天清理） */
    this.lastWriteDate = '';
  }

  _append(dir, filename, line) {
    const absDir = path.resolve(process.cwd(), dir);
    if (!this.dirsCreated.has(absDir)) {
      fs.mkdirSync(absDir, { recursive: true });
      this.dirsCreated.add(absDir);
    }
    fs.appendFileSync(path.join(absDir, filename), line);
  }

  /**
   * 清理目录中过期的滚动日志文件（只删匹配 <前缀>-YYYY-MM-DD<ext> 命名模式的文件）。
   * 任何异常静默（清理失败不影响写入）。
   * @param {string} dir 日志目录
   * @param {string[]} bases 要清理的文件名前缀列表（主日志 + 错误文件）
   * @param {string} ext 扩展名
   * @param {number} keepDays 保留天数（<=0 关闭）
   */
  _cleanup(dir, bases, ext, keepDays) {
    if (!keepDays || keepDays <= 0) return;
    const cutoffStr = new Date(Date.now() - keepDays * 86400000).toLocaleDateString('sv-SE');

    const absDir = path.resolve(process.cwd(), dir);
    let files;
    try {
      files = fs.readdirSync(absDir);
    } catch {
      return; // 目录不存在或不可读：跳过
    }

    const patterns = bases.map(base => ({
      base,
      re: new RegExp(`^${escapeRegExp(base)}-\\d{4}-\\d{2}-\\d{2}${escapeRegExp(ext)}$`)
    }));

    for (const file of files) {
      const hit = patterns.find(p => p.re.test(file));
      if (!hit) continue;
      const dateStr = file.slice(hit.base.length + 1, hit.base.length + 11);
      if (dateStr >= cutoffStr) continue; // 未过期
      try {
        fs.unlinkSync(path.join(absDir, file));
      } catch {
        /* 删除失败（占用/权限）：留待下次 */
      }
    }
  }

  /**
   * @param {object} record
   * @param {object} cfg getLogConfig() 结果
   * @param {boolean} [sync=false] 兼容参数（本通道本就同步写入）
   * @param {object|null} [fileOpts=null] 实例级文件配置 { name?, dir?, ext?, date?, error?, keepDays? }
   */
  write(record, cfg, sync = false, fileOpts = null) {
    if (!cfg.fileEnabled) return;
    const gf = cfg.file ?? {};
    const dir = fileOpts?.dir ?? gf.dir ?? 'logs';
    const name = fileOpts?.name ?? gf.name ?? 'app';
    const ext = fileOpts?.ext ?? gf.ext ?? '.log';
    const useDate = fileOpts?.date ?? gf.date ?? true;
    const dateSuffix = useDate ? `-${fileDateString()}` : '';
    const errorOpt = fileOpts?.error ?? gf.error ?? true;
    const keepDays = fileOpts?.keepDays ?? gf.keepDays ?? 30;
    const isGlobalDefaultName = !fileOpts?.name && (gf.name ?? 'app') === 'app';

    const mainFile = `${name}${dateSuffix}${ext}`;
    const errBase = resolveErrorBase(errorOpt, name, isGlobalDefaultName);

    const line = JSON.stringify(record) + '\n';
    try {
      this._append(dir, mainFile, line);
      if ((record.level === 'warn' || record.level === 'error' || record.level === 'fatal') && errorOpt !== false) {
        this._append(dir, `${errBase}${dateSuffix}${ext}`, line);
      }

      // 过期清理：仅在按天滚动模式下有意义；跨天重置账本，每个目录+前缀组合清一次
      const today = fileDateString();
      if (useDate) {
        if (today !== this.lastWriteDate) {
          this.lastWriteDate = today;
          this.cleanedKeys.clear();
        }
        const cleanKey = `${dir}|${name}|${errBase}|${ext}`;
        if (!this.cleanedKeys.has(cleanKey)) {
          this.cleanedKeys.add(cleanKey);
          this._cleanup(dir, [name, errBase], ext, keepDays);
        }
      }
    } catch {
      // 文件通道失败静默（控制台通道仍然工作）
    }
  }

  /** 兼容保留：同步写入无缓冲，无需刷盘 */
  close() {}
}

export const nodeFileTransport = new NodeFileTransport();
