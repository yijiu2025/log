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
import { warnOnce } from './degraded.js';

/**
 * 生成当天本地日期串 YYYY-MM-DD（用于文件滚动命名，与 record.t 本地时区基准一致）。
 * @returns {string} 如 '2026-09-13'（sv-SE locale 恰好输出 ISO 格式）
 */
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

/**
 * 解析错误文件前缀。
 * @param {boolean|string} errorOpt - 配置值：true = 按默认规则；字符串 = 自定义前缀
 * @param {string} name - 主日志文件名前缀
 * @param {boolean} isGlobalDefaultName - 主前缀是否为全局默认名 'app'（沿用旧约定 error）
 * @returns {string} 错误文件前缀：'error' 或 '<name>-error' 或自定义串（经 safeSeg 校验）
 */
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

/**
 * 后缀是否为进程号模式（清理时按数字段通配，连走过期孤儿文件）。
 * @param {string|boolean} suffixOpt - 配置值
 * @returns {boolean} 'pid' 或 true 时为 true
 */
function isPidSuffix(suffixOpt) {
  return suffixOpt === 'pid' || suffixOpt === true;
}

/**
 * 转义正则元字符（拼接文件名匹配模式用）。
 * @param {string} s - 原始串
 * @returns {string} 元字符全部转义后的串
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ANSI 颜色码（兼容存量业务在 msg 里拼接的 C.* 颜色段；ESC 控制字符为本规则的正当用途） */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * 递归剥离对象字符串字段中的 ANSI 颜色码（原地修改）。
 * 必须在 JSON.stringify 之前做：JSON 会把 ESC 控制字符转义成 \u001b，
 * 序列化后的字符串上正则匹配不到。
 * @param {object} value - 任意对象（record，调用侧私有副本，可原地修改）
 * @param {number} [depth=4] - 递归深度限制
 * @returns {object} 同一对象
 */
function stripAnsiDeep(value, depth = 4) {
  if (depth <= 0 || !value || typeof value !== 'object') return value;
  for (const k of Object.keys(value)) {
    const v = value[k];
    if (typeof v === 'string') {
      value[k] = v.replace(ANSI_RE, '');
    } else if (v && typeof v === 'object') {
      stripAnsiDeep(v, depth - 1);
    }
  }
  return value;
}

/**
 * Node 文件通道实现（单例，非线程/多进程共享——多进程请配 `suffix: 'pid'` 分文件写入）。
 *
 * 职责：把一条 record 转为 JSON 行同步追加到目标文件；按需双写错误文件；
 * 每天首次写入时清理过期日志。所有路径拼接都经 `safeSeg` + `isInside` 双重防线。
 *
 * 由 Node 入口 `index.node.js` 经 `setFileTransport()` 注入到 `transports.js`，
 * 浏览器环境不会加载本文件。任何写入/清理失败**不向上抛**（控制台通道不受影响），
 * 但写入失败会按错误码去重后向 stderr 发一次降级告警（见 `degraded.js`）——
 * 「日志静默丢失」本身就是必须被知道的故障。
 */
class NodeFileTransport {
  constructor() {
    /** 相对目录 → 已确认创建的绝对路径（避免每条日志都 resolve + mkdirSync） */
    this.dirs = new Map();
    /** @type {Set<string>} 本次进程内已执行过清理的目录+前缀（每天最多一次） */
    this.cleanedKeys = new Set();
    /**
     * 进程级跨天哨兵：记录最近一次写入的日期。日期变化即视为跨天，清空
     * `cleanedKeys` 让所有目录重新获得一次清理机会。
     *
     * 注意这是**全局单值**而非「每目录状态」——多个目录/多个 logger 共享它，
     * 因此是「谁先跨天谁触发全局重置」。这是有意设计：跨天只需清空一次账本，
     * 各目录的具体清理由 `cleanedKeys` 按 `dir|name|errBase|ext|suffix` 独立记账。
     */
    this.lastWriteDate = '';
  }

  /**
   * 相对目录 → 绝对路径（带缓存）。
   * 仅写入路径使用：首次访问时创建目录并缓存；清理路径不走这里
   * （目录不存在时静默跳过，不应产生 mkdir 副作用）。
   * @param {string} dir - 相对（或绝对）目录
   * @returns {string} 绝对路径
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

  /**
   * 同步追加一行到目标文件（目录不存在时自动创建；目标被删时自愈重试一次）。
   * @param {string} dir - 相对目录
   * @param {string} filename - 文件名（各段已经 safeSeg 白名单校验）
   * @param {string} line - 完整日志行（含换行符）
   * @returns {void} 写入失败向上抛出（由 write() 的外层 try 统一静默）
   */
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
   *
   * 异常不向上抛（清理失败不影响写入），但**非 ENOENT 的失败**（权限/占用等）
   * 会按错误码去重后向 stderr 留痕一次，避免「以为清理了其实没清」。
   *
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
    } catch (err) {
      // 目录不存在（ENOENT）是常态：该目录本就不该被创建（清理路径不产生 mkdir 副作用）
      // 其余错误（EACCES 等）说明日志目录不可读，留痕以免运维以为清理生效了
      if (err?.code !== 'ENOENT') {
        warnOnce(
          `cleanup-readdir-${err?.code ?? 'UNKNOWN'}`,
          `⚠️ [wb-logkit] 日志目录不可读，跳过过期清理(${err?.code}): ${absDir}\n`
        );
      }
      return;
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
      } catch (err) {
        // 删除失败（文件被占用/权限不足）：留待下次；非 ENOENT 时留痕一次
        if (err?.code !== 'ENOENT') {
          warnOnce(
            `cleanup-unlink-${err?.code ?? 'UNKNOWN'}`,
            `⚠️ [wb-logkit] 过期日志删除失败(${err?.code})，将留待下次清理: ${target}\n`
          );
        }
      }
    }
  }

  /**
   * 日期目录模式下清理过期的日期目录（整目录移除）。
   * 只扫描 <baseDir> 下形如 YYYY-MM-DD 的目录名，且日期早于保留期才删；
   * 目录名不匹配（如用户自建的 other/）一律不动。
   * 整块删除，连同其下所有模块子目录（logs/2020-01-01/a、logs/2020-01-01/b 一并清理）。
   *
   * 与 `_cleanup` 同策略：失败不抛出，但非 ENOENT 的错误会去重留痕一次。
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
    } catch (err) {
      // 基础目录不存在是常态（清理路径不创建目录）；其余错误留痕
      if (err?.code !== 'ENOENT') {
        warnOnce(
          `cleanup-readdir-${err?.code ?? 'UNKNOWN'}`,
          `⚠️ [wb-logkit] 日志基础目录不可读，跳过日期目录清理(${err?.code}): ${absBase}\n`
        );
      }
      return;
    }

    for (const ent of entries) {
      if (!ent.isDirectory() || !dateDirRe.test(ent.name)) continue;
      if (ent.name >= cutoffStr) continue; // 未过期（含当天）
      const target = path.join(absBase, ent.name);
      if (!isInside(absBase, target)) continue; // 路径越界防御
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (err) {
        // 整目录移除失败（占用/权限）：留待下次；留痕一次便于运维发现
        warnOnce(
          `cleanup-rmdir-${err?.code ?? 'UNKNOWN'}`,
          `⚠️ [wb-logkit] 过期日期目录删除失败(${err?.code})，将留待下次清理: ${target}\n`
        );
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
   * 写入入口（由 `logger._emitInner` 调用）。
   *
   * 流程：解析配置（实例 fileOpts 优先于全局 cfg.file）→ 解析目录/文件名 →
   * 剥离 ANSI 颜色码 → 同步追加主日志 → warn+ 双写错误文件 → 触发每日清理。
   *
   * 失败策略：异常**不向上抛**（绝不污染业务与控制台输出），但会按错误码去重后
   * 向 stderr 发一次降级告警（见 `degraded.js`）——文件通道坏掉不能无声无息。
   *
   * @param {object} record - 结构化日志记录（`buildRecord` 产物：{ t, level, tag, msg, ...data }）；
   *        本函数会**原地剥离**其字符串中的 ANSI 颜色码（该对象为本次 emit 私有，安全）
   * @param {object} cfg - `getLogConfig()` 结果（读全局 `fileEnabled` / `file.*`）
   * @param {boolean} [sync=false] 兼容参数（本通道本就同步写入，无实际作用）
   * @param {object|null} [fileOpts=null] 实例级文件配置（优先级最高）；
   *        键：`{ name?, dir?, ext?, date?, dateDir?, subdir?, level?, keepDays?, error?, suffix? }`。
   *        非 null 即为「实例明确要写文件」，全局 `fileEnabled=false` 时依然落盘。
   * @returns {void} 失败静默降级（控制台通道仍工作，stderr 留一条去重告警）
   */
  write(record, cfg, sync = false, fileOpts = null) {
    // 全局文件通道关闭时，仍允许**实例级显式 file 配置**生效（实例优先级最高）：
    //   const log = createLogger('pay'); log.config({ file: { name: 'pay' } });
    // 只有全局关闭且无实例 file 配置时，才整体跳过。
    const instWantsFile = fileOpts !== null && fileOpts !== undefined;
    if (!cfg.fileEnabled && !instWantsFile) return;
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

    // 剥离 ANSI 颜色码：文件保持纯文本 JSONL（全文检索友好）；
    // 控制台通道不受影响（TTY 上 pretty 模式的颜色照常渲染）。
    // record 为本次 emit 私有对象（console 通道已先写完），原地剥离安全
    stripAnsiDeep(record);
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
    } catch (err) {
      // 文件通道失败**必须留痕**：日志落不下去本身就是必须被运维知道的事故
      // （磁盘满 / 目录不可写 / 权限不足）。异常不向上抛（不能污染业务），
      // 但按错误码去重后向 stderr 提示一次，避免磁盘满时每条日志都刷屏。
      warnOnce(
        `file-write-${err?.code ?? 'UNKNOWN'}`,
        `❌ [wb-logkit] 文件通道写入失败(${err?.code ?? 'UNKNOWN'}): ${err?.message ?? err}；日志仅剩控制台通道\n`
      );
    }
  }

  /**
   * 兼容保留：同步写入无缓冲，无需刷盘。
   *
   * 保留原因是 `transports.js` 的文件通道契约要求实现同时提供
   * `write()` 与 `close()`（`setFileTransport` 只校验 `write`，但进程退出前统一
   * 调用 `close()` 的逻辑依赖此方法存在），因此不可删除。
   * @returns {void}
   */
  close() {}
}

export const nodeFileTransport = new NodeFileTransport();
