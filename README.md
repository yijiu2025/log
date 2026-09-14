# wb-logkit

> 零依赖、Node / 浏览器通用的统一日志库。分级输出 · 必输/环境/文件矩阵控制 · 关键词调试 · 模块级配置 · 自动脱敏 · 按天/按模块分目录滚动文件。

[![npm version](https://img.shields.io/npm/v/wb-logkit.svg)](https://www.npmjs.com/package/wb-logkit)
[![license](https://img.shields.io/npm/l/wb-logkit.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/wb-logkit.svg)](https://nodejs.org)

## 安装

```bash
npm install wb-logkit
```

- **零运行时依赖**，仅使用 Node 内置模块（浏览器环境自动降级）
- 原生 **ESM**，Node >= 18
- 附带完整 **TypeScript** 类型定义

## 设计原则（重要）

1. **默认只输出控制台，不写文件** —— 不配置就绝不会产生任何日志文件
2. **写文件必须显式开启** —— 在 `configureLog` 或模块的 `config` 里给 `file`
3. **`createLogger` 只有两个参数** —— `tag` + 是否注册为全局；其余配置一律走 `config()`
4. **控制台与文件级别独立** —— 控制台可以安静，文件照样记全量

## 快速开始

```js
import { createLogger } from 'wb-logkit';

// tag 建议 = 文件路径的点分形式，便于按模块过滤
const log = createLogger('auth.session');

log.info('用户登录', { userId: 1 });   // 常规日志（对象自动并入 data）
log.warn('缓存降级', err);             // 警告（Error 自动提取 stack）
log.error('查询失败', err);            // 错误
log.debug('缓存未命中', key);          // 调试：默认静默，需关键词放开
```

### 注册为全局 log

在入口文件（`index.js` / `app.js`）头部执行一次，其他文件即可直接使用：

```js
// app.js —— 只需一次
import { createLogger } from 'wb-logkit';
createLogger('app', true);          // 第二个参数 true = 注册为全局

// 任意其他文件 —— 无需再 createLogger
import { log } from 'wb-logkit';
log.info('直接可用');
```

未注册时 `log` 是一个 tag 为 `app` 的默认实例。全局 log 是单例，**后注册的覆盖先注册的**；
`log` 是稳定引用（Proxy 门面），所以其他文件即使提前 import 也能拿到最新注册的那个。

### 配置一律走 config()

```js
const log = createLogger('pay');

log.config({
  level: 'info',                       // 本模块总级别
  console: true,                       // 控制台开关
  consoleLevel: 'warn',                // 控制台通道级别：只打 warn+
  file: {                              // ← 给 file 即开启本模块文件通道
    name: 'pay',                       //   文件名（默认 = tag）
    level: 'all'                       //   文件记全量（含 debug/trace）
  }
});

// 也可随时改回来
log.config({ file: false });           // 本模块不再写文件
```

`config()` 是**累积合并**的，返回实例本身可链式调用。

## 核心概念

### 1. 六级分档

`trace` · `debug` · `info` · `warn` · `error` · `fatal`

变参签名与 `console.log` 完全兼容；`fatal` 在 Node 下同步落盘，进程崩溃前最后几条日志不丢。

### 2. 矩阵 API — 控制"什么情况下输出"

两个正交维度，任意组合，**顺序无关**：

| 维度 | 取值 | 含义 |
| --- | --- | --- |
| 必要性 | 默认 / `always` | `always` 无视一切门控，必输 |
| 环境 | 任意 / `dev` / `prod` | 仅开发 / 仅生产环境输出 |
| 通道 | 控制台+文件 / `file` | `file` 只写文件、不刷控制台 |

```js
log.always('系统启动完成');               // 必输（= log.always.info(...)）
log.always.error('配置校验失败');          // 必输的 error
log.dev.debug('开发期排查明细');           // 仅开发 + 关键词控制
log.prod.error('生产专用错误提示');        // 仅生产的 error
log.dev.always.info('仅开发的必输信息');   // 组合：log.always.dev.info 同义
log.file.info('详细数据快照');             // 只进文件，不刷屏
log.file.always.error('敏感堆栈留档');     // 组合任意维度
```

### 3. 关键词调试

`debug` / `trace` 默认静默，且**不受全局级别影响**。只调某个模块时，配一个关键词即可：

```bash
LOG_DEBUG=auth            # 命中 auth.session / framework.auth.index 等所有含 auth 段的 tag
LOG_DEBUG=auth,redis      # 多关键词
LOG_DEBUG=firewall.*      # 前缀通配
LOG_DEBUG=*               # 放开全部
```

### 4. 三级配置优先级

**实例配置 > 模块级规则 > 全局配置/环境变量**

```js
// ① 实例级（优先级最高）
const log = createLogger('pay.charge');
log.config({
  level: 'debug',             // 本模块最低级别
  console: true,              // 本模块控制台开关
  file: { name: 'pay' },      // 独立文件：logs/pay-YYYY-MM-DD.log
  debug: true                 // 本模块 debug 免关键词直接输出（false = 强制静默）
});
log.config({ level: 'warn' });  // 运行时热更新，返回自身可链式调用

// ② 模块级（环境变量，无需改代码）
//    LOG_LEVEL_AUTH=info        auth 模块最低级别
//    LOG_CONSOLE_REDIS=off      redis 模块只写文件不进控制台
//    LOG_FILE_CLI=false         cli 模块不写文件

// ③ 全局
import { configureLog } from 'wb-logkit';
configureLog({
  level: 'warn',
  file: { name: 'server', date: false },
  console: true,
  pretty: true,
  showDev: true,
  debugKeywords: ['auth']
});
```

模块级规则命名：`LOG_(LEVEL|CONSOLE|FILE)_<NAME>`，`NAME` 小写、下划线转点分，按 tag **路径段匹配**，多个规则命中取最长关键词（最具体）。

## 日志文件（仅 Node）

文件输出**默认关闭**，三种开启方式（按需选一或叠加）：

```js
// ① 全局开启（推荐，写在 app.js 的 configureLog 里）——所有 logger 一起写文件
configureLog({
  file: {
    name: 'app',      // 文件名前缀，默认 app；不配也算「有 file 配置」，同样开启
    dir: 'logs',      // 目录，不存在自动创建
    ext: '.log',      // 扩展名，如 .txt
    suffix: '',       // 文件名后缀：'pid' = 进程号（多进程防行交错）；或自定义字符串
    date: true,       // 文件名带日期后缀；false = 单文件
    dateDir: false,   // 日期作为子目录：logs/2026-09-12/app.log
    subdir: false,    // 模块子目录：'auto' = 按 tag 首段分类；字符串 = 固定目录名
    level: 'info',    // 文件记录等级：'info' = info 及以上；'all'；['info','error']；'warn,error'
    error: true,      // 错误文件：true 默认名 / false 关闭 / 字符串自定义前缀
    keepDays: 30      // 保留天数，按天自动清理；0 = 永久保留
  }
});

// ② 某个模块单独开启/改为自己的文件（实例配置「替换」全局，不会被记两遍）
createLogger('pay', true).config({
  file: { name: 'pay', subdir: 'auto', level: 'all' }
});

// ③ 只要进程级错误单独留档，不影响其余模块
createLogger('process').config({ file: { name: 'process', level: 'all', error: true } });
```

> **不手动配置也有默认值**：只要出现 `file: {…}` 对象（哪怕 `{}`）就等于开启，其余键全部走默认值。
> 显式关闭用 `file: false`（优先级最高）。

### 文件记录等级 `file.level`

控制哪些级别进文件，与全局 `level`、控制台门槛互相独立：

| 写法 | 含义 |
| --- | --- |
| 不填 | 跟随全局门槛（`level` + debug 解锁） |
| `'info'` | info 及以上 |
| `'all'` / `'*'` | 全量，含 debug/trace |
| `['info','error']` | 白名单：只记这两个级别 |
| `'warn,error'` | 逗号串，等价于数组 |
| `'off'` / `null` | 关闭该 channel |

> **显式配置 > 全局门槛**：只要写了 `file.level`（如 `'all'`），它就**优先于全局 `level`**，连 `debug`/`trace` 也会落盘，不需要再配 `LOG_DEBUG`。
> 全局 `level` 管的是「默认行为」——没写通道级别时才用它。一句话：**门槛管默认，显式配置说了算**。

控制台对应 `consoleLevel`，写法完全一致（全局写在 `configureLog({ consoleLevel })`，单实例写 `createLogger(tag).config({ consoleLevel })`）。

### 避免重复记录

实例 `file` 配置是**替换**而非叠加：一个 logger 一次输出最多写一个文件。

- 全局开了 `file`，模块没有 `file` → 用全局配置
- 模块给了 `file` → 完全用模块的，全局配置对它不再生效（文件、目录、等级全部以模块为准）
- 模块 `file: false` → 该模块不写文件，即使全局开着

### 目录布局（三种，可组合）

默认保持平铺，以上新能力**全部为新增可选**，不改变既有默认行为。

| 模式 | 配置 | 产出 |
| --- | --- | --- |
| ① 平铺（默认） | `{}` | `logs/app-2026-09-12.log` |
| ② 日期目录 | `{ dateDir: true }` | `logs/2026-09-12/app.log` |
| ③ 模块子目录 | `{ subdir: 'auto' }` | `logs/app-2026-09-12.log`、`logs/firewall/app-2026-09-12.log` |
| ④ 日期 + 模块（推的二级） | `{ dateDir: true, subdir: 'auto' }` | `logs/2026-09-12/app.log`、`logs/2026-09-12/firewall/app.log` |

`subdir` 三种取值：

- `false` / 不填 —— 不分子目录
- `'auto'`（或 `true`）—— 自动取 tag 首段作为目录名，`firewall.engine.rule` → `firewall/`
- 固定字符串 —— 该模块全部写入指定目录，如 `{ subdir: 'infra' }`

```js
// 每个模块独立文件 + 按 tag 自动分目录 + 日期二级目录
createLogger('firewall.engine', true).config({ file: { subdir: 'auto' } });
createLogger('oauth21.token',   true).config({ file: { name: 'oauth', subdir: 'auto' } });
configureLog({ file: { dateDir: true } });   // 全局：日期做一级目录
```

产出文件：

| 文件 | 命名规则 | 内容 |
| --- | --- | --- |
| 主日志 | `<name>-YYYY-MM-DD.log` | 全部级别，JSON 行，按天滚动 |
| 错误日志 | `<name>-error-YYYY-MM-DD.log` | warn 及以上 |
| 日期目录模式 | `<dir>/YYYY-MM-DD/<name>.log` | 日期为子目录，文件名不再带日期后缀 |

写入使用 `appendFileSync` 同步落盘，崩溃安全。清理策略：

- **平铺模式**：只删除匹配本库命名规则的过期**文件**
- **日期目录模式**：只删除整块的过期 `YYYY-MM-DD` 目录；非日期命名的目录（如 `logs/mydata/`）和当天目录**永不触碰**

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | info 及以上级别的门槛 |
| `LOG_DEBUG` | 空 | debug/trace 白名单关键词 |
| `LOG_DIR` | `logs` | 日志文件目录 |
| `LOG_FILE_NAME` | `app` | 主日志文件名前缀 |
| `LOG_FILE_EXT` | `.log` | 文件扩展名 |
| `LOG_FILE_DATE` | `true` | 文件名日期后缀（`off` = 单文件） |
| `LOG_DATE_DIR` | `false` | 日期作为子目录（`on` = `logs/2026-09-12/app.log`） |
| `LOG_SUBDIR` | 空 | 模块子目录：`auto`/`true` = 按 tag 首段；或固定目录名 |
| `LOG_ERROR_FILE` | `true` | 错误文件开关 |
| `LOG_KEEP_DAYS` | `30` | 日志保留天数（`0` = 永久保留） |
| `LOG_FILE_SUFFIX` | 空 | 文件名后缀：`pid` = 进程号（多进程部署防行交错）；或自定义字符串 |
| `LOG_MAX_STR` | `2000` | 单字段字符串长度上限（字符数），超长截断加 `…(len=N)` 标记；`0` = 关闭 |
| `LOG_CONSOLE` | `true` | 控制台开关 |
| `LOG_CONSOLE_LEVEL` | 空 | 控制台记录等级：`info` / `all` / `error,warn` / `debug` |
| `LOG_FILE` | `false` | 文件开关（**默认关闭**，需显式开启） |
| `LOG_FILE_LEVEL` | 空 | 文件记录等级：`info` / `all` / `error,warn` / `debug` |
| `LOG_PRETTY` | 非 prod 为 `true` | 控制台彩色可读 / JSON 行 |
| `LOG_DEV` | 随 `NODE_ENV` | dev 专属输出强制开关 |
| `LOG_LEVEL_<NAME>` | — | 模块级最低级别覆盖 |
| `LOG_CONSOLE_<NAME>` | — | 模块级控制台开关 |
| `LOG_FILE_<NAME>` | — | 模块级文件开关（`true` 会同时开启该模块的文件输出） |

## 浏览器使用

包通过 `package.json` 的 `exports` 条件路由自动区分环境（`node` → 含文件通道，`default` → 纯浏览器安全）：

```js
import { createLogger } from 'wb-logkit';

const log = createLogger('app.user');
log.info('hello');                    // 正常输出
log.file.info('仅 Node 生效');         // 浏览器中安全 no-op
```

- 打包安全：`node:fs` 等仅存在于 `index.node.js` 分支，Vite / webpack 不会打包进浏览器产物
- 浏览器控制台：`error` / `fatal` 走 `console.error`（红字），其余走 `console.log`

## 内置能力

- **自动脱敏**：`password` / `token` / `secret` / `key` / `cookie` 等字段递归（3 层）输出为 `***`；超过 3 层的嵌套部分整体替换为 `[maxDepth]` 占位符，绝不透传未脱敏的原始对象（仅作用于对象/数组参数，`msg` 字符串不做脱敏——外部输入请先截断再入日志）
- **永不抛异常**：日志调用自身绝不把错误抛进业务代码——循环引用、BigInt、Symbol 等经 `safeStringify` 安全序列化（`[Circular]` / `123n` / `Symbol(x)`），序列化意外失败时兜底写 stderr 降级提示
- **超长截断**：单字段字符串默认 2000 字符上限（`LOG_MAX_STR` 可调，0 关闭），防单条日志撑爆文件
- **时区一致**：`record.t` 为本地时区 ISO 8601（含偏移量），与文件滚动日期同基准，跨午夜不出现文件名与内容时间错位
- **多进程友好**：`LOG_FILE_SUFFIX=pid` 按进程分文件防行交错，过期清理按数字段通配连走孤儿文件
- **上下文注入**：`setLogContextProvider()` 可注入 `requestId` / `userId`，请求内日志自动携带（核心字段 t/level/tag/msg/err 受保护，不会被 provider 覆盖）
- **Error 提取**：传入 `Error` 自动提取 `message` + `stack`
- **计时器**：`const done = log.time('dbQuery'); ...; done();` 自动输出耗时
- **原始输出**：`import { logStdout as stdout } from 'wb-logkit'` 无时间戳装饰，适合 CLI 结果展示

## API 速查

| 导出 | 说明 |
| --- | --- |
| `createLogger(tag, asGlobal?)` | 创建模块 logger；`asGlobal = true` 同时注册为全局（推荐入口） |
| `log` / `logger` | 全局 logger 门面（未注册时为 tag = `app` 的默认实例） |
| `registerGlobalLogger(instance)` / `getGlobalLogger()` | 手动注册 / 读取当前全局实例 |
| `configureLog(options)` | 全局编程配置（一般只在入口调用一次） |
| `getLogConfig()` / `reloadLogConfig(opts?)` | 读取配置 / 重载环境变量 |
| `resetLogConfig()` | 清空运行时覆盖并重载（测试隔离用） |
| `parseLevelOpt(v)` / `levelPasses(list, level)` / `LEVEL_ORDER` | 等级白名单解析与判定工具 |
| `AppLogger` | logger 类（可 `new` 或继承） |
| `logStdout` / `stdout` | 无装饰原始输出 |
| `setLogContextProvider(fn)` | 注入请求上下文 |
| `sanitizeForLog` / `sanitizeUrl` / `sanitizeUserAgent` | 脱敏工具 |
| `Logger`（默认导出） | 兼容旧 API 的静态调用包装 |

## 源码结构

```
src/
├── index.js                # 通用出口（浏览器安全）
├── index.node.js           # Node 出口（注入文件通道）
├── index.d.ts              # TypeScript 类型定义
├── config.js               # 配置（环境变量 / configureLog / 模块规则 / 关键词匹配）
├── logger.js               # 核心（变参解析、实例配置、矩阵变体、门控）
├── transports.js           # 控制台通道 + 文件通道注入器
├── file-transport.node.js  # Node 文件通道（同步落盘、按天滚动、按天清理）
├── context.js              # 上下文提供器（requestId 注入）
├── safe-stringify.js       # 安全序列化（循环引用/BigInt 永不抛异常）
└── sanitize.js             # 日志脱敏
```

## License

[MIT](./LICENSE) © 2026 yijiu2025
