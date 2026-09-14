# wb-logkit 注释审查报告（JSDoc + 文件头）

> 审查范围：仅限 **JSDoc 注释与文件头注释** 的正确性、完整性与一致性。
> 审查方法：逐文件通读全部 11 个源码文件的文件头与逐符号 JSDoc，与实现逐条对照。
> 审查日期：2026-09-14 · 基线版本：`wb-logkit@0.4.1`（`fe50ce7`）

## 0. 结论摘要

- 综合评级：**6.5/10**（扣分全部来自「注释与实现不符」与「缺失」，与代码逻辑无关）
- **P1：6 项**（注释描述了不存在的行为 / 与实现直接矛盾，会误导使用者）
- **P2：9 项**（关键符号缺 JSDoc、`@param` 缺描述、格式断裂）
- **P3：4 项**（措辞、类型标注精度）
- 一句话总评：文件头注释的组织**很好**（有「快速上手 + 环境变量 + 设计意图」三段式，信息密度高），
  但**没有跟上 0.4.0/0.4.1 两轮 API 变更**——这正是最危险的一类注释问题：文档说了旧行为，
  使用者照着写会踩坑。最该先修的是 `config.js` 的 `parseBool` 注释错位 + `index.js` / `logger.js`
  文件头残留的两参对象写法。

## 1. 问题清单

### [P1-1] `parseBool` 的 JSDoc 挂在 `LEVEL_ORDER` 上方，且 `parseBool` 本身完全无注释

- 位置：`packages/log/src/config.js:56-62`（注释）→ `:63`（`LEVEL_ORDER`）→ `:127`（真正的 `parseBool`）
- 现象：一段写得很完整的 `parseBool` JSDoc（`@param value` / `@param defaultValue` / `@returns boolean`）
  被夹在 `LEVELS` 与 `LEVEL_ORDER` 之间。`LEVEL_ORDER` 自己的单行注释在其**下方**、
  `parseBool` 函数定义却跑到了 60 行之后，中间还隔着 `parseLevelOpt` 与 `levelPasses`。
- 影响：
  - IDE 悬停 `LEVEL_ORDER` 时显示的是「解析宽松布尔值」——**错误提示**；
  - IDE 悬停 `parseBool` 时**无任何提示**（它是最核心的布尔解析器，被 6 处调用）；
  - 生成 API 文档时会把这段注释绑到 `LEVEL_ORDER` 上。
- 建议修法：把该 JSDoc 移到 `parseBool` 定义正上方，并为 `LEVEL_ORDER` 保留其单行注释。

### [P1-2] `index.js` 文件头示例使用已废弃的两参对象写法

- 位置：`packages/log/src/index.js:29`
- 现象：
  ```js
  const log = createLogger('pay', { level: 'debug', file: { name: 'pay' } });
  ```
  但 `createLogger` 自 0.4.0 起**只有两个参数** `(tag, asGlobal)`，第二参是 `boolean`。
  按注释写会把一个对象当成 `asGlobal` 传入，`asGlobal === true` 判定失败 → 不注册全局，
  且 `{ level, file }` 被**静默丢弃**（`createLogger` 内部 `new AppLogger(tag || 'app', null)` 硬编码 `null`）。
- 影响：照着文件头抄代码的人会得到「配置不生效」且无任何报错——最难排查的一类问题。
- 建议修法：改为 `createLogger('pay').config({ level: 'debug', file: { name: 'pay' } });`

### [P1-3] `logger.js` 文件头「实例级配置」示例同样是废弃写法

- 位置：`packages/log/src/logger.js:13-20`
- 现象：同样是两参对象写法（`createLogger('pay', { level, console, file, debug })`），
  且注释文案「实例级配置（优先级高于模块级环境变量与全局配置）」暗示这是推荐入口。
- 影响：同上。该文件是 `AppLogger` 的实现，注释与构造函数签名（`constructor(tag, options = null)`）
  本身不矛盾，但**与推荐的公开入口 `createLogger` 矛盾**。
- 建议修法：文件头改为「一律用 `config()`」并给出 `.config({...})` 示例；保留「构造函数也接受
  options（供内部/高级用法）」的说明。

### [P1-4] `AppLogger` 构造函数 JSDoc 的 `options` 键清单严重过时

- 位置：`packages/log/src/logger.js:186-194`
- 现象：`@param options` 只列了 `{ name?, dir?, ext?, date?, error? }`，**缺** 0.2.0 起新增的
  `dateDir` / `subdir` / `keepDays` / `suffix`，缺 0.4.0 起新增的 `file.level`，
  也缺 `consoleLevel`。
- 影响：`index.d.ts` 里 `LoggerOptions.file` 是完整的 9 个键，与这里的 5 个不一致 ——
  **同一份配置有两套互相矛盾的说明**，以哪个为准取决于用户读的是 .js 还是 .d.ts。
- 建议修法：与 `index.d.ts` 的 `LoggerOptions` 对齐，并在注释里注明「与 index.d.ts 保持同步」。

### [P1-5] `index.js` 文件头「环境变量」段落的 `LOG_FILE=true` 与默认值矛盾

- 位置：`packages/log/src/index.js:47`
- 现象：文件头写
  ```
  LOG_CONSOLE=true / LOG_FILE=true   通道开关
  ```
  但自 0.4.0 起 `LOG_FILE` **默认 false**（`config.js:285` `parseBool(env.LOG_FILE, false)`），
  且 `config.js` 自己的文件头（`:30`）已正确标注 **默认 false**。两处文件头互相矛盾。
- 影响：使用者会以为「不配就写文件」，与「默认不写文件」的核心设计相悖。
- 另外该段还漏了 `LOG_CONSOLE_LEVEL` / `LOG_FILE_LEVEL` / `LOG_DATE_DIR` / `LOG_SUBDIR` /
  `LOG_KEEP_DAYS` / `LOG_FILE_SUFFIX` / `LOG_MAX_STR` / `LOG_DEV` 等 0.2.0~0.4.0 新增变量。
- 建议修法：`LOG_FILE` 标注默认 false，并按 `config.js` 的清单补齐（至少补齐新增的关键项）。

### [P1-6] `index.d.ts` 文件头的包名写成 `wb-log`

- 位置：`packages/log/src/index.d.ts:2` — `* wb-log 类型定义（Node / 浏览器通用）`
- 现象：包名早已改为 `wb-logkit`（历史遗留自 `@qirly/wb-log` 时期）。
- 影响：类型文件顶部是 IDE 悬停包类型时最显眼的一行，包名错误会让人怀疑装了错包。
- 建议修法：改为 `wb-logkit`。

> 排查说明：已全量搜索 `src/` 下的裸 `wb-log`（负向断言 `wb-log` 后不接 `kit`），
> 仅 `index.d.ts:2` 一处残留，其余文件均为 `wb-logkit`。

### [P2-1] `LEVEL_ORDER` 缺少独立 JSDoc 块

- 位置：`packages/log/src/config.js:63`
- 现象：只有一行 `/** ... */` 单行注释，没有 `@type`。它是公开导出（`index.d.ts:169` 已声明），
  但注释说明了「用途（白名单展开用）」却没说明「是冻结数组、只读」。

### [P2-2] `LEVELS` 的注释未说明取值范围约束

- 位置：`packages/log/src/config.js:46`
- 现象：`/** 级别数值：越小越详细 */` —— 正确但过简。`LEVELS` 是公开导出，
  且 `parseLevelOpt` 依赖它做「该级别及以上」的过滤，取值必须是**升序单调**的
  （`LEVEL_ORDER` 的排序依赖此性质）。这个不变量没有任何注释声明。

### [P2-3] `parseBoolOpt` / `parseSubdirOpt` 的 `@param` 未说明与 `parseBool` 的关系

- 位置：`packages/log/src/config.js:132-140`、`:142-159`
- 现象：`parseBoolOpt` 的返回值写的是 `{boolean|null}` 且说明「null = 未配置」，
  但没有点出它与 `parseBool(value, defaultValue)` 的差别只在于「未配置时不回退默认值」。
  两者相邻且名称高度相似，使用者极易混用。
- 建议：在 `parseBoolOpt` 注释里补一句「区别于 `parseBool`：本函数不接收默认值，
  未配置时返回 null 交由调用方用 `??` 决定」。

### [P2-4] `logger.js` 的 `_variant` 返回值类型标注不准确

- 位置：`packages/log/src/logger.js:231`
- 现象：`@returns {Function} 可调用变体：fn(...args) = info 级；fn.trace~fn.fatal 指定级别；
  fn.always / fn.dev / fn.prod / fn.file 为 getter，返回组合后的新变体`
  —— 描述是对的，但 `@returns` 标的是 `{Function}`，而实际是「函数 + 挂载了 10 个属性」
  的可调用对象，且四个门控属性是 `Object.defineProperty` 定义的 **getter**（`:246-253`，
  `enumerable: false`）。
- 影响：使用者若做 `Object.keys(log.always)` 或 `JSON.stringify` 会得到空 —— 注释未提示
  「四个门控属性不可枚举」。
- 建议：`@returns` 改为 `{LogVariant}`（与 `index.d.ts` 的 `LogVariant` 对齐），并注明门控属性为不可枚举 getter。

### [P2-5] `_emit` / `_emitInner` 的 `opts` 类型标注重复且冗长

- 位置：`packages/log/src/logger.js:340`、`:367`
- 现象：两处都写 `@param {object|boolean} [opts={}] true=强制输出；或 { force, env, fileOnly }`。
  `_emit` 的默认值确实是 `{}`，但 `_emitInner` 通过
  `typeof opts === 'boolean' ? { force: opts } : (opts ?? {})` 兼容了 boolean，
  默认值写作 `{}` 也可接受，只是两处描述完全重复。
- 建议：抽出 `@typedef {object} EmitOpts` 统一定义，两处 `@param {EmitOpts|boolean} [opts]` 引用。

### [P2-6] `file-transport.node.js` 的 `write()` JSDoc 缺参数描述

- 位置：`packages/log/src/file-transport.node.js:311-318`
- 现象：
  ```
  @param {object} record        ← 无描述
  @param {object} cfg getLogConfig() 结果
  @param {boolean} [sync=false] 兼容参数（本通道本就同步写入）
  @param {object|null} [fileOpts=null] 实例级文件配置
  ```
  `record` 完全没有描述；`fileOpts` 的键清单漏了 `level`（0.4.0 新增）。
- 另外 `sync` 参数名保留但无实际作用，注释已说明「兼容参数」，这点是好的。
- 建议：补 `record` 描述、补 `fileOpts.level`。

### [P2-7] `NodeFileTransport` 类本身没有类级 JSDoc

- 位置：`packages/log/src/file-transport.node.js:145`
- 现象：`class NodeFileTransport {` 上方无任何注释，直接是文件头结束后的一串私有函数。
  类的职责、生命周期（单例、由 `index.node.js` 注入）、`dirs`/`cleanedKeys`/`lastWriteDate`
  三个缓存字段的语义只在 `constructor` 内部的单行注释里零散出现。
- 建议：补类级 JSDoc，说明「单例、由 index.node.js 注入、非线程安全（单进程内有效）」。

### [P2-8] `close()` 的 JSDoc 未说明「为何是空实现」

- 位置：`packages/log/src/file-transport.node.js:380-384`
- 现象：`/** 兼容保留：同步写入无缓冲，无需刷盘。 */` —— 说明了「无需刷盘」，
  但没说明**为什么保留这个方法**（`transports.js` 的 `fileTransport` 契约要求有 `close()`）。
  单看这个方法会以为是可以删的死代码。

### [P2-9] `sanitize.js` 的三处 `@param` 缺 `[可选]` 标记与类型精度

- 位置：`packages/log/src/sanitize.js:29`（`depth` 有默认值 `3` 却未标 `[depth=3]`）
- 另外 `sanitizeForLog` 的 `@returns {object}` 实际在 `depth<=0` 时返回**字符串** `'[maxDepth]'`，
  数组输入时返回**数组**。返回类型标注与实现不符。
- 建议：`@returns {object|string|Array}`，并把 `depth` 标为 `[depth=3]`。

## 2. 已验证无问题清单

| 检查项 | 验证手段 | 结论 |
| --- | --- | --- |
| 文件头「三段式」结构（快速上手 / 环境变量 / 设计意图） | 逐文件通读 11 个文件头 | 结构统一、信息密度高，**保持** |
| `@author` / `@since` 标注 | 全量 grep | 11 个源文件全部具备，无缺失 |
| `config.js` 文件头环境变量清单 | 与 `buildConfig()` 逐项对照 | **准确**，含 0.4.0 的 `LOG_FILE` 默认 false、`LOG_CONSOLE_LEVEL`/`LOG_FILE_LEVEL` |
| `file-transport.node.js` 文件头的目录布局/命名/清理三节 | 与 `write()`/`_cleanup()`/`_cleanupDateDirs()` 对照 | **准确**，「只删本库命名规则文件」「日期目录整块删」与实现一致 |
| `traps.js` 文件头的落盘策略说明 | 与 `log.config({...})` 调用对照 | **准确**，已正确说明「不与全局 file 开关耦合」 |
| `safe-stringify.js` 的降级映射表 | 与 replacer 实现对照 | **完全一致**（`[Circular]`/`123n`/`Symbol(x)`/`[Function: name]`/`[unserializable]`） |
| `record-schema.js` 双常量语义 | 与 `buildRecord`/`buildExtraPayload` 用法对照 | **准确**，`CORE_RECORD_KEYS` vs `RESERVED_KEYS` 的差别说清楚了 |
| `transports.js` 的 TTY 上色策略 | 与 `useColor()` 对照 | **准确**，已说明「管道/重定向不上色」 |
| `context.js` 的解耦意图 | 与 `setLogContextProvider` 用法对照 | **准确** |
| `index.node.js` 的 exports 路由说明 | 与 `package.json` exports 对照 | **准确**，与 `.d.ts` 的双入口一致 |
| 私有函数是否普遍有 JSDoc | 全量 grep `^function` 前置注释 | 除 `parseBool`（见 P1-1）外**全部具备**，且质量高 |

## 3. 设计层面的意见（非缺陷）

1. **文件头承担了过多职责**：`index.js` / `config.js` 的文件头已经是一份速查手册（含用法 + 环境变量表）。
   好处是 `import` 跳进源码立刻有全局视图；坏处是**任何 API 变更都必须同步改文件头**，
   而这次 0.4.0/0.4.1 就漏了（P1-2/P1-3/P1-5）。建议：文件头只保留「一句话职责 + 设计意图 +
   指向 README 的链接」，把用法/环境变量表移出，降低同步负担。
2. **`LoggerOptions` 在 `.d.ts` 与 `.js` 里有两份说明**（P1-4）。建议在 `.js` 侧改为
   `@param {import('./index.d.ts').LoggerOptions} options` 引用，做到单一事实来源。
3. **建议加注释 lint**：本仓库已用 ESLint + Prettier，但都没有校验 JSDoc。可引入
   `eslint-plugin-jsdoc`（至少开 `check-param-names`、`check-tag-names`、`require-param-description`），
   这类「注释错位」「缺描述」问题可在 CI 直接拦住。

## 4. 测试补强建议

| 场景 | 期望 | 重要性 | 建议测试位置 |
| --- | --- | --- | --- |
| `createLogger('pay', {level:'debug'})` 传对象作第二参 | 当前静默忽略；建议**开发期警告**或断言不抛异常 | 高（P1-2 的根因防回归） | `wb-log.test.js` 全局 log 注册 describe |
| 注释中的每个示例片段 | 可直接运行 | 中 | 可加「文档示例」测试组统一跑 |
| `parseBool` 的 `@param` 行为 | `'1'/'true'/'yes'/'on'` 为 true，其余 false | 中 | config 单测 |

## 5. 优先级路线图

- **立即修（本轮已完成 ✅）**：P1-1 ~ P1-6 + P2-1 ~ P2-9 全部修复
- **下次迭代**：引入 `eslint-plugin-jsdoc`（`check-param-names` / `check-tag-names` / `require-param-description`）；按第 3 节建议精简文件头职责
- **可延后**：把 `.js` 侧 JSDoc 完全改为引用 `.d.ts` 类型（消除双份维护）

## 6. 本次修复记录

| 编号 | 修复内容 | 文件:行 |
| --- | --- | --- |
| P1-1 | `parseBool` JSDoc 归位到其定义正上方；补真值集合说明 | `config.js:126-137` |
| P1-2 | 文件头示例改为 `createLogger('pay').config({...})` | `index.js:4-41` |
| P1-3 | 文件头改为 `log.config({...})` 写法 + 补门控语义段 | `logger.js:1-33` |
| P1-4 | 构造函数 `options` 键清单与 `.d.ts` 对齐（补 consoleLevel / dateDir / subdir / level / keepDays / suffix），并注明单一事实来源 | `logger.js:196-213` |
| P1-5 | 环境变量段 `LOG_FILE=false` 标注默认关闭，并补齐 0.2~0.4 新增的 12 个变量 | `index.js:47-76` |
| P1-6 | 包名 `wb-log` → `wb-logkit`；补「与实现同步」声明 | `index.d.ts:1-6` |
| P2-1 | `LEVEL_ORDER` 注释补「冻结数组，只读」 | `config.js:63` |
| P2-2 | `LEVELS` 补「严格升序单调」不变量说明 | `config.js:46-52` |
| P2-3 | `parseBoolOpt` 补与 `parseBool` 的差异说明 | `config.js:143-152` |
| P2-4 | `_variant` 返回类型改 `{LogVariant}`，说明门控 getter 不可枚举 | `logger.js:243-259` |
| P2-5 | 抽出 `@typedef EmitOpts`，`_emit`/`_emitInner` 共用 | `logger.js:38-46` |
| P2-6 | `write()` 补 `record` 描述、补 `fileOpts.level` | `file-transport.node.js:311-325` |
| P2-7 | 补 `NodeFileTransport` 类级 JSDoc（单例/职责/注入方式/失败静默） | `file-transport.node.js:145-153` |
| P2-8 | `close()` 说明「为何保留」（通道契约要求） | `file-transport.node.js:389-397` |
| P2-9 | `sanitizeForLog` 的 `depth` 标可选、返回类型修正为 `{*}` | `sanitize.js:26-41` |
| 附带 | `configureLog` 的 patch 键清单补齐 `consoleLevel`/`fileLevel`/`file.level`，加「累积合并」说明与 3 个 `@example` | `config.js:406-455` |

### 新增回归测试

`wb-log.test.js` 新增「API 契约：createLogger 只有两个参数，第二参非 true 时不注册全局」，
锁住 P1-2 的根因（第二参传对象 → 不注册全局 + 配置被静默忽略），避免文档再次跑偏时无测试兜底。

### 验证结果

- `wb-log` 测试：**48 passed**（47 → 48）
- 全量测试：**667 passed / 11 skipped**
- ESLint：零告警
- 全量搜索确认 `src/` 下无残留裸 `wb-log`、无废弃两参 `createLogger` 写法
