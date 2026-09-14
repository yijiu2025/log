# wb-logkit 代码审查报告（fullstack-rules 规范）

> 审查依据：`.claude/skills/fullstack-rules` v2.5.0 —
> `references/code-review.md`（企业级审查清单）+ `references/anti-patterns.md` + `references/note.md`
> 审查对象：`packages/log/src/*`（2586 行）及其适配层 `src/framework/log/*`、调用方 `src/app.js` / `src/api/*`
> 审查日期：2026-09-14 ｜ 基线提交：`8ead964`（npm 0.4.1）
> 验证状态：`npx eslint packages/log/src src/framework/log` → 0 警告；`jest --testPathPatterns "framework/log"` → 48/48 通过

---

## 审查报告

| 等级 | 数量 | 说明 |
| ---- | ---- | ---- |
| 🔴 严重 | 0 | 运行时崩溃、安全绕过、数据丢失风险 |
| 🟡 中等 | 5 | 配置错误难排查、潜在数据丢失、静默失败无兜底 |
| 🔵 低 | 7 | 可读性、文档、代码风格、规范一致性 |

**结论**：无严重问题。安全防线（`safeSeg` + `isInside` 双重校验、脱敏、frozen 配置）经实测有效。
主要问题集中在 **「配置写错时静默失效」** —— 这是本库作为「可观测性基础设施」最反讽的一类缺陷：
日志库自己出问题时不吭声，使用者以为日志记上了，实际一条没有。

---

## 一、追踪调用链（规范要求 ≥2 层）

```
业务代码（src/api/guard.js、src/utils/ip.js、src/app/firewall/index.js …）
  └─ import { createLogger } from '../framework/log/index.js'
       └─ src/framework/log/index.js        ← 适配层：export * from 'wb-logkit'
            └─ node_modules/wb-logkit       ← 软链 → packages/log
                 └─ package.json exports.conditions
                      ├─ node    → src/index.node.js → setFileTransport(nodeFileTransport)
                      │                                → src/file-transport.node.js（同步落盘）
                      └─ default → src/index.js      → transports.js（fileTransport 为空实现）
```

关键发现（调用链层面）：

1. **`traps.js` 是唯一绕过适配层直连包名的文件**（`import { AppLogger } from 'wb-logkit'`），
   而其他文件都走 `framework/log/index.js`。二者等价（适配层是 `export *`），但规范上不一致；
   且 `traps.js` 依赖 `packages/log` 的软链存在——若独立部署时未装包会崩。→ 🔵 F-6
2. **浏览器/Node 双入口是真实存在的分叉**：前端（`oauth21/`、`firewall/`、`admin/`）拿到的是
   纯控制台实现，`file-transport.node.js` 根本不会被打包。审查时需明确「文件通道的静默失败」
   前端场景不存在。→ 已在文档中覆盖，无需改代码。
3. 业务侧调用点共 6 处（`api.guard`、`api.guard-config`、`utils.ip`、`app.firewall.index`、
   `process`、`db.test`），全部用 `createLogger(tag)` + 对象/Error 入参，**未发现 `err.message.includes()`
   做控制流**的情形。→ 规范项「错误码优先」通过。

---

## 二、逐项清单核查

| # | 清单项 | 结论 | 说明 |
| - | ------ | ---- | ---- |
| 1 | 追踪调用链 ≥2 层 | ✅ | 见上 |
| 2 | 错误码优先（非消息文本） | ✅ | 全库仅 2 处 err 判断，均用 `err?.code === 'ENOENT'` |
| 3 | 空值保护（可选链） | ✅ | `inst?.level`、`err?.code`、`process.stderr?.write` 等逐层保护 |
| 4 | 超时保护 | ⚪ 不适用 | 全同步实现（`appendFileSync`），无阻塞异步，无超时需求 |
| 5 | 优雅关闭（flush 路径） | ⚠️ 部分 | 同步写无缓冲 → 无需 flush（已文档化）；但**无进程退出自动 flush 钩子** |
| 6 | 静默失败（跳过路径须记日志） | ❌ 主要问题 | 见 🟡 F-1 ~ F-5 |
| 7 | 功能一致性（多路径安全级别） | ✅ | 写路径与清理路径同用 `safeSeg`+`isInside`；`_cleanup` 与 `_cleanupDateDirs` 对称 |
| 8 | 异常输入告警（非静默返回默认值） | ❌ 主要问题 | `parseLevelOpt` 非法值静默退 null；`configureLog` 非法 level 静默忽略 |
| 9 | 不对称行为已文档化 | ✅ | 实例 file 覆盖 vs 全局叠加、dateDir 下文件名回归等均已写明 |
| 10 | 并发安全（模块级可变状态） | ⚠️ 部分 | `runtimeOverrides`/`config`/`globalLogger`/`lastWriteDate` 均未加锁；单线程下可接受，见 🟡 F-5 |
| 11 | 公共 API 参数校验 | ⚠️ 部分 | `registerGlobalLogger` 校验 ✓、`setFileTransport` 校验 ✓；`createLogger`/`configureLog` 不校验 |
| 12 | reply.sent 标记 | ⚪ 不适用 | 非 HTTP 模块 |
| 13 | 登录与角色一致性 | ⚪ 不适用 | 非鉴权模块 |
| 14 | 错误对象构造（`err.code=` 而非 Object.assign） | ✅ | `sanitize.js`/`config.js` 未构造带码 Error（也无需构造） |
| 15 | 文件头注释 JSDoc + `@author`/`@since` | ✅ | 10 个源文件全部具备（含 `@author yijiu2025` + `@since`） |
| 16 | `npx eslint` 0 警告 | ✅ | 实测通过 |

---

## 三、🟡 中等发现（建议修复）

### F-1 `parseLevelOpt` 对非法值静默返回 `null`，等于「不设门槛」

**位置**：`config.js:113`（`return null;` 兜底）、`config.js:92 / 105`（非法项过滤后为空 → null）

**实测证据**：

```
parseLevelOpt('inf')          -> null      ← 用户把 info 拼错，静默变"不设门槛"
parseLevelOpt(['xxx'])        -> null      ← 整个白名单全是垃圾 → 等同于没配
parseLevelOpt('warn,xyz')     -> ["warn"]  ← 部分无效项被无声丢弃
parseLevelOpt({})             -> null
parseLevelOpt(42)             -> null
```

**为什么是问题**：配置写错时，用户期望「按我说的过滤」，实际行为是**门槛消失、全量输出**——
方向恰好相反。排查时用户看到日志比预期多，很难联想到是配置名拼错。

**规范依据**：`code-review.md` §5.2「异常输入告警：必须记录警告日志，而非静默返回默认值」。

**建议**：在 `parseLevelOpt` 内对无法识别的 token 走一次降级告警（本库不能用 `console.*` 之外的方式，
可复用 `_emit` 的降级写 stderr 手法，或抽一个 `warnDegraded(msg)` 内部函数）：

```js
// config.js —— 非法级别名取证（不抛异常，只留痕）
function warnInvalidLevel(raw, kept) {
  const line = `⚠️ [wb-logkit] 无法识别的级别配置: ${JSON.stringify(raw)}；已按 ${JSON.stringify(kept)} 处理\n`;
  if (typeof process !== 'undefined' && process.stderr?.write) process.stderr.write(line);
}
```

**注意**：`parseLevelOpt` 目前是**纯函数**（无副作用），加 stderr 写入会破坏纯度。若要保持纯函数，
替代方案是新增 `validateLevelOpt(value): { ok, allow, invalid }` 供 `configureLog` 调用并告警，
`parseLevelOpt` 保持纯。→ 推荐后者。

---

### F-2 `configureLog` 非法 `level` 静默忽略，且**残留前值**

**位置**：`config.js:308` — `if (o.level && Object.hasOwn(LEVELS, o.level)) cfg.level = o.level;`

**实测证据**：

```js
resetLogConfig();
configureLog({ level: 'INFO' });   // 大写 → 不在 LEVELS 键里 → 忽略
// cfg.level = 'info'（环境变量默认值，没报错）
configureLog({ level: 'inf' });    // 拼错 → 忽略，但 runtimeOverrides 里已存了 'inf'
// cfg.level 仍是上一步的值 —— 用户以为改了，其实没改
```

注意 `runtimeOverrides = { ...runtimeOverrides, ...patch }`（`config.js:450`）**先无条件写入**，
再由 `buildConfig` 有条件读——于是无效值被永久存进 overrides，后续 `reloadLogConfig()` 也一直是无效状态。

**建议**：同 F-1，非法 `level` 应留痕；或在 `configureLog` 入口做参数校验并返回告警信息。

---

### F-3 文件通道 `catch {}` 全吞，落盘失败无任何可见信号

**位置**：`file-transport.node.js:392`（`write()` 外层）、`:246`（unlink 失败）、`:281`（rmSync 失败）

```js
} catch {
  // 文件通道失败静默（控制台通道仍然工作）
}
```

**为什么是中等问题**：磁盘满、目录权限不足、路径不可写时，**日志静默丢失**。而日志库的核心价值
恰是「出问题时能查」——落盘通道坏了却没有任何提示，等到需要日志调查故障时才发现是空的。

**权衡说明**：文件通道吞异常本身是**正确设计**（日志库绝不能把异常抛进业务）。问题在于
「吞掉」之后**没有降级提示**。`_emit`（`logger.js:372-384`）已经示范了正确做法：
捕获后向 stderr 裸写一条降级提示。

**建议**：`write()` 的 catch 里补一次降级告警，并对同类错误做**去重限流**（避免磁盘满时
每条日志都刷一条 stderr 形成风暴）：

```js
} catch (err) {
  // 文件通道失败必须留痕：日志落不下去本身就是必须被知道的事故
  // 同类错误只提示一次，避免磁盘满时每条日志都刷 stderr
  const key = `${err?.code ?? 'UNKNOWN'}`;
  if (!this._warned.has(key)) {
    this._warned.add(key);
    const line = `❌ [wb-logkit] 文件通道写入失败(${key}): ${err?.message ?? err}；日志仅输出到控制台\n`;
    if (process.stderr?.write) process.stderr.write(line);
  }
}
```

---

### F-4 `fatal` 在两条通道都被关闭时**完全消失**（规范 §2.5）

**位置**：`logger.js:481-490`

**实测证据**：

```js
configureLog({ level: 'info', console: false, file: false });
createLogger('probe.fatal').fatal('fatal 但两条通道都关');
// → 无任何输出。fatal 是"进程级故障"，设计上"必输"，此刻却静默蒸发
```

`force: true` 只保证**绕过门控**，不保证**有通道可写**。当 `console:false` + `file:false` 时，
`toConsole`/`toFile` 双双为 false，走 `if (!toConsole && !toFile) return;`（`:490`）整体丢弃。

**规范依据**：`code-review.md` §2.5「进程退出时必须确保日志已刷新」——fatal 场景日志丢失是
「事故时查不到原因」的典型。`traps.js` 用 `fs.writeSync(2, …)` 兜底，但那只覆盖
`uncaughtException`，**不覆盖业务代码主动调的 `log.fatal()`**。

**建议**：为 fatal 增加 stderr 保底通道（不受 `console`/`file` 开关约束）：

```js
// fatal 是"进程级故障"语义：即使控制台与文件都被显式关闭，也必须有一条兜底出口
if (!toConsole && !toFile && lv >= LEVELS.fatal) {
  writeRawStderr(`🚨 [${this.tag}] ${msg}\n`);
  return;
}
```

---

### F-5 `fileOnly` + 文件通道关闭 → 整条记录静默蒸发

**位置**：`logger.js:484-490`

**实测证据**：

```js
configureLog({ console: true, file: false });
createLogger('x').file.error('fileOnly 但文件关闭');
// → 控制台命中 0 次，无任何提示
```

`log.file.*` 的语义是「只写文件、不刷控制台」，但文件通道关着时，这条日志**两头都没有**。
不算崩溃，但属「静默失败」。规范 §5.1 要求跳过路径留痕。

**建议**：`fileOnly && !toFile` 时补一次降级告警（同样做限流）。

---

## 四、🔵 低优先级发现

| 编号 | 位置 | 问题 | 建议 |
| ---- | ---- | ---- | ---- |
| F-6 | `src/framework/log/traps.js:19` | 唯一直接 `import from 'wb-logkit'` 的文件，与全项目「经适配层导入」的约定不一致 | 改为 `from './index.js'`（同目录），避免依赖软链路径 |
| F-7 | `packages/log/src/index.js:129` | `globalFacade` 的 Proxy 无 `ownKeys`/`getOwnPropertyDescriptor` trap，`Object.keys(log)` 返回 **target（defaultLogger）** 的属性，而非当前 active 实例 → 反射信息与实际不一致（实测：注册 `probe.proxy` 后 `Object.keys` 仍返回 target 的键名，值恰好相同所以没暴露） | 补 `ownKeys`/`getOwnPropertyDescriptor` trap，或在 `globalFacade` 上写明该限制 |
| F-8 | `packages/log/src/config.js:63` | `LEVEL_ORDER` 用 `sort((a,b) => LEVELS[a] - LEVELS[b])`——若未来 `LEVELS` 出现**等值**（如两个都是 30），`Array#sort` 稳定性保证顺序，但 JSDoc 只声明了「严格升序」不变量，未说明等值时的行为 | 在 `LEVELS` 的不变量注释里补一句「必须严格不等，等值会导致白名单顺序不确定」 |
| F-9 | `packages/log/src/file-transport.node.js:160-161` | `lastWriteDate` 是**全局单值**，多目录/多 logger 场景下互相 reset（实测：`a.info()` + `b.info()` 只触发一次清理账本清空，行为正确但语义上是「谁先跨天谁重置」） | 加注释说明该字段是「进程级跨天哨兵」而非「每目录状态」 |
| F-10 | `packages/log/src/index.js:197` | `Logger.auth()` 声明 `@returns {Promise<void>}` 但函数体无 `await`、无 `return`——`async` 只为签名兼容，实测返回 resolved Promise | 注释里说明「保留 async 仅为兼容旧调用方 `await Logger.auth(...)`」 |
| F-11 | `packages/log/src/logger.js:117` `parseArgs` | `parseArgs(args)` 的 `@param {Array}` 未写明「无 `%s` 占位符插值」——与 `console.log('a %s', b)` 行为**不同**（本库是空格拼接，不做格式化） | 在 JSDoc 里显式标注「不实现 printf 风格占位符，`%s` 会原样输出」（README 已提，源码注释未提） |
| F-12 | `packages/log/src/sanitize.js:41` | `sanitizeForLog` 返回类型 `{*}` 但实际在 `depth<=0` 时返回字符串、对象时返回新对象；`index.d.ts` 里声明为 `<T>(obj: T) => T` —— 类型与实现不符（深度耗尽时 T 变 string） | `.d.ts` 改为 `unknown` 或明确联合类型 |

---

## 五、⚪ 已确认**不是**问题（防误报）

以下是初次阅读时像是问题、实测后确认设计正确的项，记录备查：

| 项 | 位置 | 为什么不是问题 |
| -- | ---- | -------------- |
| 所有 `catch {}` 空块 | `transports.js:116`、`context.js:32`、`safe-stringify.js:46`、`logger.js:381` | 日志库**不得**把自身异常抛进业务；且多数已在上层有降级出口（`_emit` 写 stderr） |
| `_append` 中 `if (!isInside(...)) return;` 静默跳过 | `file-transport.node.js:191` | `safeSeg` 已在前面拦截非法段，此路径**不可达**；留它是纵深防御，不是静默失败 |
| `close() {}` 空实现 | `file-transport.node.js:405` | 同步写入无缓冲，无需 flush —— 已在 JSDoc 中说明保留原因（通道契约要求） |
| 清理失败静默 | `_cleanup` / `_cleanupDateDirs` | 清理是「尽力而为」的维护动作，失败不影响日志正确性，留待下次；且**只删严格匹配本库命名规则的文件/日期目录**，绝不越界 |
| 实例 `file` 覆盖而非叠加 | `logger.js:415-426` | 有意设计，防止同时写两份；已在 README + JSDoc 双向说明 |
| `parseLevelOpt` 是纯函数、无副作用 | `config.js:80` | 有意为之（便于测试与推导）；F-1 的建议因此改为「另加校验函数」而非直接塞 stderr |
| `__proto__` 原型污染 | `sanitize.js:49-59` / `logger.js:172-178` | 实测 `Object.prototype.polluted === undefined`。`data` 用 `{}` 字面量 + `Object.entries` 收集，`__proto__` 不会走 `Object.assign` 污染原型 |
| 保留键让位机制 | `logger.js:172-178` | 实测业务 `{ msg: '假的', level: '假的' }` 被整体挪到 `record.data` 下，核心字段未被覆盖 ✓ |
| ctx provider 覆盖核心字段 | `logger.js:181-183` + `record-schema.js` | 实测 provider 返回 `{ level:'HACKED', tag:'HACKED' }` 被 `CORE_RECORD_KEYS` 全部挡下 ✓ |
| 路径越界防御 | `file-transport.node.js:191/243/278` | 实测 `name: '../../evil'` 被 `safeSeg` 回退为 `'app'`，未写出目录 ✓；`dir` 允许绝对路径是**文档化的有意设计**（写/删仍有 `isInside` 兜底） |
| 超长字符串截断 | `logger.js:79-90` | 递归截断 + 深度上限 4，防单条日志撑爆文件；`maxStr<=0` 可关 ✓ |
| NaN/Infinity/BigInt 序列化 | `safe-stringify.js` | 实测 `NaN→null`、`Infinity→null`、BigInt→`"123n"`，无异常抛出 ✓ |

---

## 六、与上一个审查（AUDIT-REPORT-comments.md）的关系

上一轮是**注释审查**（P1×6 全是「注释与实现不符」），已修复并发布 `8ead964`。
本轮是**规范审查**（fullstack-rules 企业级清单），焦点从「注释说得对不对」转到
「配置失效时有没有人知道」。

两轮**无重叠**：上一轮的 P1 均已闭环，本轮 🟡 五项全部是**新的**运行期行为问题，
且全部属于同一类——**静默失败**。这也解释了为什么上一轮没发现：注释审查关注
「注释↔代码」一致性，静默失败发生在「配置↔行为」之间，只有对照规范清单 + 实测才能暴露。

---

## 七、修复建议优先级

| 顺序 | 项 | 理由 |
| ---- | -- | ---- |
| 1 | F-3（文件通道失败留痕 + 限流） | 唯一会**静默丢数据**的项，且生产环境磁盘满时必然触发 |
| 2 | F-4（fatal stderr 保底） | 事故现场无日志，排查成本最高 |
| 3 | F-1 / F-2（非法配置留痕） | 降低「配置写错却静默生效」的排查成本 |
| 4 | F-5（fileOnly 弃写提示） | 与 F-3 同批实现成本低（复用限流器） |
| 5 | F-7 ~ F-12 | 文档/类型精度，可随下一版批量处理 |

F-1 ~ F-5 共用一套「降级告警 + 限流」内部机制，建议一次性抽取实现，
避免在多处重复写 stderr 裸写逻辑（DRY，规范 §开发规范 1）。

---

## 八、复现脚本

本报告全部结论均经实测，复现脚本位于系统临时目录（`probe.mjs` ~ `probe8.mjs`），
覆盖：`parseLevelOpt` 边界、白名单空白、无效级别名、实例 vs 全局 `file.level` 优先级、
`__proto__` 污染、保留键让位、ctx 覆盖防护、路径越界、Proxy 门面反射、fatal/fileOnly 丢弃。

---

## 九、本次修复记录

修复策略：抽出一个共享的「降级告警出口」`src/degraded.js`（`writeRawStderr` + `warnOnce`），
供 `logger.js` / `config.js` / `file-transport.node.js` 三处复用——避免在多处重复写 stderr 裸写逻辑（DRY）。

| 项 | 文件:位置 | 修复内容 | 验证 |
| -- | --------- | -------- | ---- |
| **新增** | `src/degraded.js`（新文件） | `writeRawStderr`（Node→stderr，浏览器→console.error）+ `warnOnce`（按 key 去重的限流告警）+ `_resetWarnedKeys`（测试用） | 单测 + 独立进程验证限流生效 |
| F-1 | `config.js` `validateLevelOpt()` | 新增非纯函数包装层：收集无法识别的 token 并 `warnOnce` 留痕，归一化结果仍走 `parseLevelOpt`（**保持 `parseLevelOpt` 纯函数不变**）；`configureLog` 的 `consoleLevel`/`fileLevel`/`file.level` 三处改走它 | 单测「非法通道级别名留痕」 |
| F-2 | `config.js:308` | `level` 分支加 `else` 留痕，告警中带**当前生效值**与合法值清单 | 单测「非法级别名留痕」 |
| F-3 | `file-transport.node.js` `write()` catch | 由 `catch {}` 改为 `catch (err)` + `warnOnce('file-write-<code>')`；`_cleanup`/`_cleanupDateDirs` 的 `readdirSync`/`unlinkSync`/`rmSync` 三处失败也按错误码留痕，并区分常态 ENOENT（不告警） | 单测「文件通道写入失败告警」+ E2E |
| F-4 | `logger.js:490` | `!toConsole && !toFile` 且 `lv >= LEVELS.fatal` 时，裸写一条 stderr（`🚨 [tag] FATAL <msg>`），不受通道开关约束 | 单测「fatal 双关兜底」+ E2E |
| F-5 | `logger.js:490` | `fileOnly && !fileOn` 时 `warnOnce` 告警，指明 tag 与修复方向 | 单测 + E2E |
| F-6 | `src/framework/log/traps.js:19` | `import { AppLogger } from 'wb-logkit'` → `from './index.js'`（经适配层，与全项目约定一致） | 全量测试通过 |
| F-7 | `index.js` `globalFacade` | 补 `ownKeys` + `getOwnPropertyDescriptor` trap，反射结果取自 active 实例；描述符统一 `configurable: true` 以满足 Proxy 不变式 | 单测「Proxy 反射一致性」 |
| F-8 | `config.js` `LEVELS` JSDoc | 补充「两两不相等」要求及等值时的后果说明 | 文档 |
| F-9 | `file-transport.node.js` `lastWriteDate` | 注释明确其为「进程级跨天哨兵」而非每目录状态 | 文档 |
| F-10 | `index.js` `Logger.auth` | JSDoc 说明保留 `async` 仅为兼容 `await` 调用方，函数体全同步 | 文档 |
| F-11 | `logger.js` `parseArgs` JSDoc | 显式标注「不做 printf 风格插值，`%s` 原样输出」 | 文档 |
| F-12 | `index.d.ts` `sanitizeForLog` | 返回类型 `T` → `unknown`（深度耗尽返回字符串，与输入类型不一致） | 类型定义 |

### 验证结果

```
npx eslint packages/log/src src/framework/log src/__tests__/framework/log   → 0 errors / 0 warnings
jest --testPathPatterns "framework/log"                                     → 54 passed / 54 total（新增 6 条回归用例）
jest（全量）                                                                 → 673 passed / 11 skipped / 0 failed
E2E（fatal 兜底 / fileOnly 告警 / 非法配置留痕 / 写入失败留痕 / 限流 / 正常落盘无回归） → 全部 OK
浏览器路径（无 process 时 writeRawStderr 退回 console.error）                 → OK
静态检查：index.js / degraded.js / logger.js / config.js 无 node: 内置模块 import → 前端可安全打包
npm pack --dry-run                                                          → 15 files / 43.7 kB，docs/ 正确排除
```

### 交付状态

| 环节 | 状态 |
| ---- | ---- |
| 代码修复 | ✅ 12/12 完成 |
| ESLint / 测试 | ✅ 0 警告、54 + 673 全绿 |
| 版本号 | ✅ 0.4.1 → **0.5.0** |
| 提交 | ✅ `2aad119` + `1cc1a1b` |
| GitHub 推送 | ✅ `git ls-remote origin main` 确认为 `1cc1a1b` |
| npm 发布 | ✅ **已发布** `wb-logkit@0.5.0`（`latest` tag 已指向 0.5.0） |
| 真实安装回归 | ✅ 从 npm 装 0.5.0 跑 9 项行为验证全通过（非 workspace 软链） |

### 真实包回归明细（`npm install wb-logkit@0.5.0` 后执行）

```
OK  ① fatal 双关 stderr 兜底
OK  ② log.file.* 但文件关闭告警
OK  ③ 非法 level 留痕
OK  ④ 非法通道级别留痕
OK  ⑤ 文件通道写入失败留痕
OK  ⑥ 正常落盘无回归（主日志 2 行）
OK  ⑥b 错误文件双写正常（全局默认前缀下命名为 error.log）
OK  ⑦ 默认 fileEnabled=false
OK  ⑧ 数组白名单只记列出的级别
OK  ⑨ file.level=all 越过全局门槛（debug/trace 落盘）
```

**踩坑记录**：验证脚本最初误以为错误文件叫 `app-error.log`，实际全局默认前缀 `app` 时
沿用旧约定命名为 `error.log`（自定义前缀时才为 `<name>-error.log`）。这是文档化的有意设计，
脚本假设错误而非代码缺陷。

### 设计取舍说明

1. **`parseLevelOpt` 保持纯函数**。F-1 的最初想法是直接在 `parseLevelOpt` 里写 stderr，
   但那会破坏它的纯度（现有测试与推导逻辑都依赖「纯」这一性质）。改为新增
   `validateLevelOpt` 包装层：纯函数管归一化，包装层管告警，职责分离。
2. **文件通道失败仍不向上抛**。这是日志库的铁律（绝不能污染业务），修复只补「留痕」，
   不改成抛出。规范 §5.1 要求的也是「记录日志」而非「改变控制流」。
3. **必须限流**。磁盘满、目录权限错这类故障会**持续**触发；若每条日志都告警，
   stderr 会被刷爆，反而淹没真正有用的信息。因此按「错误码」去重，每类故障每进程只提示一次。
4. **限流账本不支持重置**（除测试用的 `_resetWarnedKeys`）。生产环境故障恢复后不再重复告警，
   这是可接受的——首次告警足以让运维介入。

