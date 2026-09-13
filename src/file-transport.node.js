/**
 * Node 文件通道：JSON 行、按天滚动、目录分层、文件命名全可配、过期自动清理
 *
 * 仅由 index.node.js（Node 入口）注入；浏览器不会打包此文件。
 *
 * 同步写入（appendFileSync）：本库面向中小服务量级，同步开销可忽略，
 * 换取进程崩溃不丢日志 + 写入立即可见（测试/退出语义简单）。
 *
 * ── 目录布局（三种，可组合）─────────────────────────────────
 *   平铺（默认）          logs/app-2026-09-12.log
 *   日期目录 dateDir      logs/2026-09-12/app.log
 *   模块子目录 subdir     logs/firewall/app-2026-09-12.log
 *   两者组合              logs/2026-09-12/firewall/app.log
 *
 *   dateDir=true 时日期由"文件名后缀"变为"子目录"，文件名回归 <name><ext>。
 *   subdir 为字符串时用该固定名；为 true 时用 tag 首段（framework.auth.x → framework）。
 *
 * ── 文件命名 ────────────────────────────────────────────────
 *   <name>[-suffix][-YYYY-MM-DD]<ext>        主日志（全部级别）
 *   <errorBase>[-suffix][-YYYY-MM-DD]<ext>   错误文件（warn 及以上；error:false 关闭，
 *                                            error:'自定义前缀' 指定名称；默认规则：
 *                                            全局默认前缀时为 error，自定义前缀 name 时为 <name>-error）
 *   suffix：LOG_FILE_SUFFIX / 实例 file.suffix；'pid' = 进程号（多进程部署防行交错），
 *   其他字符串原样使用。文件名各段均经 safeSeg 白名单校验（拒绝路径分隔符与 ..），
 *   且所有写/删目标路径都经 isInside 包含性校验，绝不越出配置的日志目录。
 *
 * ── 保留天数（keepDays，默认 30）────────────────────────────
 *   每天首次写入时清理过期的日志文件（按文件名中的日期判断）：
 *   - 平铺模式：只删匹配 <前缀>[-后缀]-YYYY-MM-DD<ext> 的文件；
 *     pid 后缀模式下按数字段通配，连走其他进程遗留的过期孤儿文件
 *   - 日期目录模式：只删日期目录（整目录移除），不碰目录内非本库文件
 *   绝不涉及任何不符合本库命名规则的路径。keepDays: 0 或 false 关闭清理。
 *
 * @author yijiu2025
 * @since 2026-09-11
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { safeStringify } from './safe-stringify.js';

/** 本地日期字符串 YYYY-MM-DD（用于文件滚动，与 record.t 的本地时区基准一致） */
function fileDateString() {
  return new Date().toLocaleDateString('sv-SE');
}

/**
 * 文件名各段的白名单校验：拒绝路径分隔符与 ..，防止配置项把路径拼出受限目录。
 * 不合法时回退到 fallback（本库配置来自 env/编程入参，正常使用不会触发）。
 * @param {string} value 原始段值
 * @param {string} [fallback=''] 校验失败时的回退值
 * @returns {string}
 */
function safeSeg(value, fallback = '') {
  const s = String(value ?? '');
  if (!s) return fallback;
  if (/[/\\]/.test(s) || s.includes('..')) return fallback;
  return s;
}

/**
 * 包含性校验：target 必须严格位于 parent 目录内部（不含 parent 本身）。
 * 所有动态拼接的写/删目标路径在落盘前必须通过此检查，杜绝 ../ 越界。
 * @param {string} parent 父目录（绝对路径）
 * @param {string} target 目标路径（绝对路径）
 * @returns {boolean}
 */
function isInside(parent, target) {
  const rel = path.relative(parent, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 错误文件前缀：显式字符串 > 全局默认前缀（沿用旧约定 error）> 自定义 name（<name>-error） */
function resolveErrorBase(errorOpt, name, isGlobalDefaultName) {
  if (typeof errorOpt === 'string') return safeSeg(errorOpt, 'error');
  if (isGlobalDefaultName) return 'error';
  return `${name}-error`;
}

/**
 * 解析文件名后缀段（主日志与错误文件名共用）。
 * @param {string|boolean} [suffixOpt] ''/undefined 无后缀；'pid'/true = 进程号；其他字符串原样
 * @returns {string} 如 '-12345' / '-alpha' / ''
 */
function resolveSuffixPart(suffixOpt) {
  if (!suffixOpt) return '';
  if (suffixOpt === 'pid' || suffixOpt === true) {
    return `-${process.pid}`;
  }
  return safeSeg(`-${String(suffixOpt)}`);
}

/** 后缀是否为进程号模式（清理时按数字段通配，连走过期孤儿文件） */
function isPidSuffix(suffixOpt) {
  return suffixOpt === 'pid' || suffixOpt === true;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class NodeFileTransport {
  constructor() {
    /** 相对目录 → 已确认创建的绝对路径（避免每条日志都 resolve + mkdirSync） */
    this.dirs = new Map();
    /** @type {Set<string>} 本次进程内已执行过清理的目录+前缀（每天最多一次） */
    this.cleanedKeys = new Set();
    /** 上次写入的日期（用于触发跨天清理） */
    this.lastWriteDate = '';
  }

  /**
   * 相对目录 → 绝对路径（带缓存）。
   * 仅写入路径使用：首次访问时创建目录并缓存；清理路径不走这里
   * （目录不存在时静默跳过，不应产生 mkdir 副作用）。
   */
  _abs(dir) {
    let absDir = this.dirs.get(dir);
    if (!absDir) {
      absDir = path.resolve(process.cwd(), dir);
      fs.mkdirSync(absDir, { recursive: true });
      this.dirs.set(dir, absDir);
    }
    return absDir;
  }

  _append(dir, filename, line) {
    const absDir = this._abs(dir);
    const target = path.join(absDir, filename);
    if (!isInside(absDir, target)) return; // 路径越界：丢弃（safeSeg 已保证不会发生）
    try {
      fs.appendFileSync(target, line);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        // 目录被外部删除（如运维手动清空 logs/）：清缓存重建后重试一次
        this.dirs.delete(dir);
        fs.appendFileSync(path.join(this._abs(dir), filename), line);
      } else {
        throw err;
      }
    }
  }

  /**
   * 清理目录中过期的滚动日志文件（只删匹配 <前缀>[-后缀]-YYYY-MM-DD<ext> 命名模式的文件）。
   * 任何异常静默（清理失败不影响写入）。
   * @param {string} dir 日志目录
   * @param {string[]} bases 要清理的文件名前缀列表（主日志 + 错误文件）
   * @param {string} ext 扩展名
   * @param {number} keepDays 保留天数（<=0 关闭）
   * @param {string} [suffixPart=''] 文件名后缀段（如 '-alpha' / '-12345'）
   * @param {boolean} [pidWildcard=false] true = 后缀按数字通配（pid 模式，连走其他进程的过期孤儿文件）
   */
  _cleanup(dir, bases, ext, keepDays, suffixPart = '', pidWildcard = false) {
    if (!keepDays || keepDays <= 0) return;
    const cutoffStr = new Date(Date.now() - keepDays * 86400000).toLocaleDateString('sv-SE');

    const absDir = path.resolve(process.cwd(), dir);
    let files;
    try {
      files = fs.readdirSync(absDir);
    } catch {
      return; // 目录不存在或不可读：跳过
    }

    // 后缀位置固定夹在前缀与日期之间：base[-suffix]-YYYY-MM-DD<ext>
    const suffixPat = suffixPart ? (pidWildcard ? '(?:-\\d+)?' : `(?:${escapeRegExp(suffixPart)})?`) : '';
    const patterns = bases.map(base => ({
      base,
      re: new RegExp(`^${escapeRegExp(base)}${suffixPat}-\\d{4}-\\d{2}-\\d{2}${escapeRegExp(ext)}$`)
    }));

    for (const file of files) {
      const hit = patterns.find(p => p.re.test(file));
      if (!hit) continue;
      // 日期段紧跟"前缀+可选后缀"之后：从后缀通配位向前不好定位，直接取
      // 文件名中前缀之后的第一段 YYYY-MM-DD（正则已保证整体形态合法）
      const dateStart = file.indexOf('-20', hit.base.length);
      const dateStr = dateStart >= 0 ? file.slice(dateStart + 1, dateStart + 11) : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || dateStr >= cutoffStr) continue; // 未过期
      const target = path.join(absDir, file);
      if (!isInside(absDir, target)) continue; // 路径越界防御（readdirSync 结果本应为纯文件名）
      try {
        fs.unlinkSync(target);
      } catch {
        /* 删除失败（占用/权限）：留待下次 */
      }
    }
  }

  /**
   * 日期目录模式下清理过期的日期目录（整目录移除）。
   * 只扫描 <baseDir> 下形如 YYYY-MM-DD 的目录名，且日期早于保留期才删；
   * 目录名不匹配（如用户自建的 other/）一律不动。
   * 整块删除，连同其下所有模块子目录（logs/2020-01-01/a、logs/2020-01-01/b 一并清理）。
   * @param {string} baseDir 基础目录（如 logs）
   * @param {number} keepDays 保留天数（<=0 关闭）
   * @param {string} today 当天日期串（避免误删当天目录）
   */
  _cleanupDateDirs(baseDir, keepDays, today) {
    if (!keepDays || keepDays <= 0) return;
    const cutoffStr = new Date(Date.now() - keepDays * 86400000).toLocaleDateString('sv-SE');
    const dateDirRe = /^\d{4}-\d{2}-\d{2}$/;

    const absBase = path.resolve(process.cwd(), baseDir);
    let entries;
    try {
      entries = fs.readdirSync(absBase, { withFileTypes: true });
    } catch {
      return; // 基础目录不存在：跳过
    }

    for (const ent of entries) {
      if (!ent.isDirectory() || !dateDirRe.test(ent.name)) continue;
      if (ent.name >= cutoffStr) continue; // 未过期（含当天）
      const target = path.join(absBase, ent.name);
      if (!isInside(absBase, target)) continue; // 路径越界防御
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        /* 删除失败（占用/权限）：留待下次 */
      }
    }
  }

  /**
   * 解析模块子目录名（经 safeSeg 白名单校验）。
   * @param {string|true|null} subdir 配置值：字符串=固定名；true=用 tag 首段；null=不分子目录
   * @param {string} tag 该条日志的模块 tag
   * @returns {string|null}
   */
  _resolveSubdir(subdir, tag) {
    if (!subdir) return null;
    if (subdir === true) {
      const seg = safeSeg(
        String(tag || '')
          .split('.')[0]
          .trim()
      );
      return seg || null;
    }
    return safeSeg(String(subdir));
  }

  /**
   * 拼接最终写入目录（相对 cwd）：base / [日期目录] / [模块子目录]
   * @param {string} baseDir 基础目录（如 logs）
   * @param {boolean} dateDir 是否用日期目录
   * @param {string|null} subdir 模块子目录
   * @param {string} today 当天日期串 YYYY-MM-DD
   */
  _buildDir(baseDir, dateDir, subdir, today) {
    const parts = [baseDir];
    if (dateDir) parts.push(today);
    if (subdir) parts.push(subdir);
    return parts.join('/');
  }

  /**
   * @param {object} record
   * @param {object} cfg getLogConfig() 结果
   * @param {boolean} [sync=false] 兼容参数（本通道本就同步写入）
   * @param {object|null} [fileOpts=null] 实例级文件配置
   *        { name?, dir?, ext?, date?, dateDir?, subdir?, error?, keepDays?, suffix? }
   */
  write(record, cfg, sync = false, fileOpts = null) {
    if (!cfg.fileEnabled) return;
    const gf = cfg.file ?? {};
    // dir 是完整路径（允许绝对路径/多级子目录），不做段级白名单；写/删目标仍有 isInside 兜底
    const baseDir = fileOpts?.dir ?? gf.dir ?? 'logs';
    const name = safeSeg(fileOpts?.name ?? gf.name ?? 'app', 'app');
    const ext = safeSeg(fileOpts?.ext ?? gf.ext ?? '.log', '.log');
    const useDate = fileOpts?.date ?? gf.date ?? true;
    const useDateDir = fileOpts?.dateDir ?? gf.dateDir ?? false;
    const subdirOpt = fileOpts?.subdir !== undefined ? fileOpts.subdir : (gf.subdir ?? null);
    const errorOpt = fileOpts?.error ?? gf.error ?? true;
    const keepDays = fileOpts?.keepDays ?? gf.keepDays ?? 30;
    const suffixOpt = fileOpts?.suffix ?? gf.suffix ?? '';
    const isGlobalDefaultName = !fileOpts?.name && (gf.name ?? 'app') === 'app';

    const today = fileDateString();
    const subdir = this._resolveSubdir(subdirOpt, record.tag);
    const dir = this._buildDir(baseDir, useDateDir, subdir, today);

    // 平铺模式：日期作为文件名后缀；日期目录模式：文件名不再带日期
    const dateSuffix = useDate && !useDateDir ? `-${today}` : '';
    const suffixPart = resolveSuffixPart(suffixOpt);
    const mainFile = `${name}${suffixPart}${dateSuffix}${ext}`;
    const errBase = resolveErrorBase(errorOpt, name, isGlobalDefaultName);

    const line = safeStringify(record) + '\n';
    try {
      this._append(dir, mainFile, line);
      if ((record.level === 'warn' || record.level === 'error' || record.level === 'fatal') && errorOpt !== false) {
        this._append(dir, `${errBase}${suffixPart}${dateSuffix}${ext}`, line);
      }

      // 过期清理：仅在按天滚动模式下有意义；跨天重置账本，每个目录+前缀组合清一次
      if (useDate) {
        if (today !== this.lastWriteDate) {
          this.lastWriteDate = today;
          this.cleanedKeys.clear();
        }
        const cleanKey = `${dir}|${name}|${errBase}|${ext}|${suffixPart}`;
        if (!this.cleanedKeys.has(cleanKey)) {
          this.cleanedKeys.add(cleanKey);
          if (useDateDir) {
            this._cleanupDateDirs(baseDir, keepDays, today);
          } else {
            this._cleanup(dir, [name, errBase], ext, keepDays, suffixPart, isPidSuffix(suffixOpt));
          }
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
