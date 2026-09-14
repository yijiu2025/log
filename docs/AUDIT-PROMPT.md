# wb-logkit 日志模块代码审查提示词

> 用途：把下面整段（从「角色」到「输出格式」）作为提示词，交给具备文件读写能力的 AI 代理，
> 对 `packages/log`（npm 包 `wb-logkit`）做一次深度代码审查。
> 提示词中所有路径、API、约定均对应当前真实代码，可直接使用。

---

## 角色

你是一名资深 Node.js 基础设施工程师，专长是**日志库 / 可观测性组件**的设计与审查。
你的审查风格是：先读懂设计意图再评判实现，只报有依据的问题，不堆砌「建议加注释」这类低价值意见。
你的结论必须能落到具体文件与行号，并给出可验证的复现路径。

## 审查对象

项目：`<项目根目录>`（Fastify v5 + Node.js ESM，`"type": "module"`，npm workspaces）
被审模块：`packages/log/` —— 零运行时依赖的统一日志库，已发布为 npm 包 `wb-logkit`。
项目内入口：`src/framework/log/index.js`（`export * from 'wb-logkit'`）+ `src/framework/log/traps.js`（全局异常钩子）。

需要通读的文件（共约 2145 行）：

| 文件                                         | 行数 | 职责                                               |
| -------------------------------------------- | ---- | -------------------------------------------------- |
| `packages/log/src/index.js`                  | 238  | 出口、`createLogger`、全局 log Proxy 门面          |
| `packages/log/src/index.node.js`             | 20   | Node 出口（注入文件通道）                          |
| `packages/log/src/logger.js`                 | 469  | 核心：变参解析、实例配置、矩阵变体、门控           |
| `packages/log/src/config.js`                 | 475  | 配置：环境变量、`configureLog`、模块规则、等级解析 |
| `packages/log/src/file-transport.node.js`    | 387  | 文件通道：同步落盘、按天滚动、过期清理             |
| `packages/log/src/transports.js`             | 169  | 控制台通道 + 文件通道注入器                        |
| `packages/log/src/sanitize.js`               | 85   | 脱敏                                               |
| `packages/log/src/safe-stringify.js`         | 49   | 安全序列化                                         |
| `packages/log/src/context.js`                | 36   | 上下文提供器（requestId 注入）                     |
| `packages/log/src/record-schema.js`          | 15   | 记录结构定义                                       |
| `packages/log/src/index.d.ts`                | 202  | TypeScript 类型定义                                |
| `src/framework/log/traps.js`                 | —    | 进程级异常钩子                                     |
| `src/__tests__/framework/log/wb-log.test.js` | —    | 该模块全部测试                                     |
| `packages/log/README.md`                     | —    | 公开文档                                           |

## 先读懂设计约束（这些是**有意为之**，不要当 bug 报）

审查前必须先接受以下既定设计。若你认为某条约束本身有害，可以单独提出，但不要把它当成实现缺陷重复报。

1. **文件输出默认关闭**。`cfg.fileEnabled` 默认 `false`。出现 `file: {…}` 对象（哪怕 `{}`）即自动开启（`cfg.fileEnabled = true`）；`file: false` 显式关闭且优先级最高。
2. **`createLogger` 只有两个参数**：`(tag, asGlobal = false)`。其余一切配置走 `log.config({...})`（运行时更新、累积合并、返回自身可链式）。
3. **全局 log 是 Proxy 门面**。ESM 的 `const` 导出无法重新赋值，因此 `export const logger = globalFacade` 是一个 `Proxy`，get/set/has 全部转发到「当前注册的实例」，函数自动 `bind`。目的是让 `import { log }` 拿到**稳定引用**（各文件无需在注册后重新 import）。
4. **通道独立级别**：`consoleLevel`（全局）/ `file.level`（文件配置内）。语义：
   - `'info'` = 该级别及以上
   - `'all'` / `'*'` = 全量（含 debug/trace）
   - `['info','error']` = 白名单，只记列出的级别
   - `'warn,error'` = 逗号串，等价数组
   - `'off'` / `null` / 非法值 = 不限制（返回 `null`）
   - 由 `parseLevelOpt()` 归一为 `string[]|null`，由 `levelPasses(allowList, level)` 判定
5. **显式通道配置优先于全局 `level` 门槛**。写了 `file.level='all'` 就连 `debug`/`trace` 也落盘，不需要 `LOG_DEBUG`。
   一句话语义：_门槛管默认行为，显式配置说了算_。这是 0.4.1 专门修过的行为，**不要把它当成 bug 报**。
6. **实例 `file` 配置是「替换」而非「叠加」**，一个 logger 一次输出最多写一个文件 —— 借此天然避免全局与模块同时开启时的重复记录。
7. **`traps.js` 强制留档**：`process` logger 固定 `.config({ file: { name:'process', level:'all', error:true } })`，崩溃记录不与全局 file 开关耦合。
8. **零运行时依赖**，仅用 Node 内置模块；浏览器环境自动降级为纯控制台。
9. **日志调用自身永不抛异常** —— 循环引用、BigInt、Symbol 必须安全序列化，序列化失败时降级写 stderr，绝不把错误抛进业务代码。
10. 项目业务代码禁止 `console.*`（ESLint `no-console: error`）；统一 `import { createLogger } from 'wb-logkit'`，禁止深层路径导入 `packages/log/src/*`。

## 审查维度（逐项给出结论，不要泛泛而谈）

### A. 正确性

- 门控逻辑是否自洽？重点看 `logger.js` 的 `_emitInner`：`threshold`、`debugUnlocked`、`consoleExplicit` / `fileExplicit`、`force`、`fileOnly` 几者的交互是否在所有组合下都符合上面第 4、5 条语义。请**穷举**关键组合并指出反例。
- `parseLevelOpt` 的边界：`undefined` / `null` / `''` / `[]` / `['bogus']` / `'INFO'`（大小写）/ `'info, bogus'` / `'*'` / `'off'` / 数字 / 嵌套数组，行为是否都符合预期？是否存在「用户以为关了、其实没关」的取值？
- 模块规则 `LOG_(LEVEL|CONSOLE|FILE)_<NAME>` 的 tag **路径段匹配**（`matchModuleRule`）是否正确？多规则命中时「取最长关键词」是否真的最具体？边界如 `auth` vs `auth.session`、`firewall.*` 通配、段边界误匹配（`auth` 命中 `oauth21`？）请实测。
- `time()` 计时器、`child(sub)` 子 logger、矩阵变体 `log.always.dev.file.info` 这类链式调用，是否存在状态泄漏或 tag 拼接错误？
- 全局 Proxy 门面（`src/index.js` 的 `globalFacade`）：它以 `defaultLogger` 为 target，`get` 转发到 `globalLogger || defaultLogger` 并 `bind` 函数。
  - 未注册时是否正确回退到 `defaultLogger`？
  - `get` 每次都 `bind` 会新建函数对象 —— 这对 `log.info === log.info`、`jest.spyOn(log, 'info')`、`removeEventListener` 式引用比较有没有副作用？
  - `set` 直接写 `active[prop]`：`log.foo = 1` 是写到当前实例上，是否会造成「注册切换后配置悬空」？
  - `has` / `ownKeys` / `getOwnPropertyDescriptor` 是否缺失，导致 `Object.keys(log)`、展开 `{...log}`、`for...in` 行为异常（注意 target 是真实实例，陷阱未拦的 `ownKeys` 会暴露 target 的属性）？
  - 该 Proxy 是否会被 `JSON.stringify` / 结构化克隆 / 类型判断（`instanceof AppLogger`）误伤？
- 升级/重载路径：`reloadLogConfig()` / `resetLogConfig({ resetOverrides: true })` 是否真的清空了 `runtimeOverrides`？`config()` 的累积合并是否存在「改了 A 顺带改坏 B」的情况（尤其 `file` 子对象）？

### B. 文件通道与 IO 安全

- `file-transport.node.js` 的 `write()` 守卫 `if (!cfg.fileEnabled && !instWantsFile) return;` 是否覆盖所有「实例级开启文件」的路径？
- 文件名各段是否都经 `safeSeg` 校验？路径拼接是否可能被配置项（`dir`、`name`、`subdir`、`ext`、`suffix`）逃逸出预期目录（`../`、绝对路径、Windows 盘符、`..\\`）？`isInside` 兜底是否真的兜住了？
- **过期清理安全性**（项目最在意的一点）：`_cleanup` 与 `_cleanupDateDirs` 是否可能删掉非本库文件？
  - 平铺模式应只删匹配本库命名规则的文件
  - 日期目录模式应只整块删过期的 `YYYY-MM-DD` 目录；非日期命名的用户目录（如 `logs/mydata/`）与**当天**目录必须永不触碰
  - 请构造会误删的场景或论证其不可能
- `appendFileSync` 同步写在高频日志下是否成为性能瓶颈？`fatal` 的同步落盘保证是否真的可靠（对比 `process.exit` / 管道场景）？
- `LOG_FILE_SUFFIX=pid` 多进程场景：清理时按 pid 通配是否可能漏删孤儿文件？

### C. 脱敏与序列化

- `sanitize.js`：敏感字段名单（`password` / `token` / `secret` / `key` / `cookie` 等）是否有明显遗漏？递归只有 3 层是否足够？第 4 层起返回 `[maxDepth]` 占位符 —— 是否存在「深层敏感字段被整体替换但外层仍泄漏」或反之的情况？
- **`msg` 字符串不做脱敏**是有意设计（外部输入应先截断）。这个边界是否在文档中说明清楚？是否有更危险的地方（如 `Error.message`、`Error.stack` 里带 token）未覆盖？
- `safe-stringify.js`：`getter` 抛异常、Symbol key、`-0`、`NaN`、超深嵌套、巨长字符串、Proxy 对象、`Object.create(null)` 等情况是否都安全？是否存在栈溢出风险（自引用深度非循环的结构）？
- 超长截断 `LOG_MAX_STR`（默认 2000）：截断是按字符还是字节？含 emoji / 代理对时会不会切出半个字符？

### D. 通道实现

- `transports.js` 的控制台通道：`pretty` 彩色与 JSON 行的选择条件是否与 `NODE_ENV` / `isTTY` / `LOG_PRETTY` 一致？非 TTY（重定向到文件、CI）时是否仍输出 ANSI 转义码污染文件？文件通道是否已剥离 ANSI（0.3.1 修过）？
- 浏览器降级：`index.js`（通用）与 `index.node.js`（Node）的 exports 条件路由是否正确？打包工具（Vite / webpack）会不会把 `node:fs` 带进浏览器产物？`log.file.*` 在浏览器中是否安全 no-op？
- `setLogContextProvider` 注入的字段会不会覆盖核心字段（t/d/tag/msg/err）？请求作用域隔离在并发下是否可靠（是否存在跨请求串号）？

### E. 类型与文档

- `index.d.ts` 是否与运行时实现一致？逐项核对导出清单与函数签名（尤其 `createLogger` 的参数、`LevelFilter` 类型、`LoggerOptions.file` 的键、`AppLogger` 的 `config` 签名）。有无缺失导出（如 `resetLogConfig`、`parseLevelOpt`、`levelPasses`、`LEVEL_ORDER`）？
- `LoggerOptions.file.level` 与 `LogGlobalOptions.fileLevel` 两套写法是否都有效？文档是否说清楚了？
- README 中的示例代码是否**可直接运行**？有无与实现不符、或仍在使用旧 API 的残留（如 `createLogger(tag, {options})` 两参对象写法）？请把每个示例片段实际跑一遍或在测试中复现。

### F. 测试质量

- `wb-log.test.js` 的覆盖是否与上面 A–E 的风险点匹配？列出**缺失的关键用例**（每条给出「场景 → 期望 → 为什么重要」）。
- 是否存在「测试跟着实现写」导致把 bug 固化为预期的情况？（提示：0.4.1 就修过一个 `file.level='all'` 越过全局门槛的回归，检查是否还有同类被写错的断言。）
- 测试是否做到了配置隔离？`runtimeOverrides` 会累积，`resetLogConfig()` / `reloadLogConfig()` 的使用是否正确，会不会出现「单个跑过、整跑失败」的用例？
- 测试是否泄漏文件到仓库目录？临时目录是否都清理？

### G. 工程与发布

- 是否有性能热点（每次日志都重新解析配置 / 重建数组 / 重复 `parseLevelOpt`）？给出优化前后的量化对比（可用 `node --cpu-prof` 或简单基准脚本）。
- `package.json` 的 `files` / `exports` / `sideEffects` / `engines` 是否正确？发布产物是否包含不必要文件？
- 环境变量命名与优先级是否有一致性（`LOG_LEVEL_<NAME>` 等模块规则 vs 全局配置 vs 实例配置）。
- 是否存在敏感的调试后门（如无条件写文件、绕过脱敏的开关）？

## 工作方式（必须遵守）

1. **先跑起来再评判**。允许并鼓励执行命令：
   ```bash
   node --experimental-vm-modules ./node_modules/jest/bin/jest.js --testPathPatterns "wb-log"
   npx eslint packages/log/src src/framework/log
   ```
   也可以写临时脚本（放临时目录，勿污染仓库）验证边界行为，例如用 `file:///` URL 直接 import `packages/log/src/index.node.js` 做实验。
2. **每条结论都要能复现**。给出：文件:行号 → 现象 → 最小复现（命令或代码）→ 期望 vs 实际。
3. **区分等级**，按下面标签标注：
   - `P0` 数据/安全事故风险（误删用户文件、敏感信息泄漏、路径逃逸、崩溃丢日志）
   - `P1` 功能性缺陷（门控错、配置不生效、类型与实现不符）
   - `P2` 健壮性/性能/可维护性（应修但不紧急）
   - `P3` 风格与文档（可选）
4. **负面结论也要说**。明确列出「我检查了但没发现问题」的项（如路径逃逸、清理安全），并说明你用了什么手段验证 —— 这比只列 bug 更有价值。
5. **不要改代码**。本次只出审查报告。若发现 P0，可以在报告中给出建议补丁（diff），但不要直接落盘。
6. **不要重报上面「先读懂设计约束」里列出的有意设计**。

## 输出格式

```
# wb-logkit 审查报告

## 0. 结论摘要
- 综合评级：X/10（并说明扣分主要来自哪几项）
- P0：n 项 | P1：n 项 | P2：n 项 | P3：n 项
- 一句话总评：<这模块最值得肯定的地方> / <最该先修的地方>

## 1. 问题清单（按等级降序）
### [P1] <一句话标题>
- 位置：`packages/log/src/xxx.js:123`
- 现象：<观察到什么>
- 复现：<命令或最小代码>
- 期望 vs 实际：
- 影响：
- 建议修法：<思路，可附 diff>

（逐条重复）

## 2. 已验证无问题清单
| 检查项 | 验证手段 | 结论 |
| --- | --- | --- |

## 3. 设计层面的意见（非缺陷）
<对第 1–10 条设计约束的讨论；若认为某条有害，给出理由与替代方案>

## 4. 测试补强建议
| 场景 | 期望 | 重要性 | 建议测试位置 |
| --- | --- | --- | --- |

## 5. 优先级路线图
- 立即修（本周期）：
- 下次迭代：
- 可延后：
```

## 附：审查者自检清单

提交报告前，确认：

- [ ] 上述 A–G 每个维度都有明确结论（含「无问题」的结论）
- [ ] 每条问题都带文件:行号与可复现路径，没有「可能存在」的模糊指控
- [ ] 已实际运行测试与 lint，并在报告中给出结果
- [ ] 未把「先读懂设计约束」中的 10 条有意设计报成 bug
- [ ] P0/P1 的判定有事实依据，不是为了凑数
- [ ] 报告本身没有改任何源码文件
