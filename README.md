# wb-log

> 零依赖、Node / 浏览器通用的统一日志库。分级输出 · 必输/环境/文件矩阵控制 · 关键词调试 · 模块级配置 · 自动脱敏 · 按天滚动文件。

[![npm version](https://img.shields.io/npm/v/@qirly/wb-log.svg)](https://www.npmjs.com/package/@qirly/wb-log)
[![license](https://img.shields.io/npm/l/@qirly/wb-log.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/wb-log.svg)](https://nodejs.org)

## 安装

```bash
npm install wb-log
```

- **零运行时依赖**，仅使用 Node 内置模块（浏览器环境自动降级）
- 原生 **ESM**，Node >= 18
- 附带完整 **TypeScript** 类型定义

## 快速开始

```js
import { createLogger } from '@qirly/wb-log';

// tag 建议 = 文件路径的点分形式，便于按模块过滤
const log = createLogger('auth.session');

log.info('用户登录', { userId: 1 });   // 常规日志（对象自动并入 data）
log.warn('缓存降级', err);             // 警告（Error 自动提取 stack）
log.error('查询失败', err);            // 错误
log.debug('缓存未命中', key);          // 调试：默认静默，需关键词放开
```

不想建 logger？直接打印：

```js
import { log } from '@qirly/wb-log';

log.info('直接打印');                  // 等价于 createLogger('app')
log.config({ level: 'debug' });        // 同样支持运行时配置
```

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
const log = createLogger('pay.charge', {
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
import { configureLog } from '@qirly/wb-log';
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

```js
createLogger('pay', {
  file: {
    name: 'pay',      // 文件名前缀（默认跟随全局 app）
    dir: 'logs',      // 目录，不存在自动创建
    ext: '.log',      // 扩展名，如 .txt
    date: true,       // 按天滚动；false = 单文件
    error: true,      // 错误文件：true 默认名 / false 关闭 / 字符串自定义前缀
    keepDays: 30      // 保留天数，按天自动清理；0 = 永久保留
  }
});
```

产出文件：

| 文件 | 命名规则 | 内容 |
| --- | --- | --- |
| 主日志 | `<name>-YYYY-MM-DD.log` | 全部级别，JSON 行，按天滚动 |
| 错误日志 | `<name>-error-YYYY-MM-DD.log` | warn 及以上 |

写入使用 `appendFileSync` 同步落盘，崩溃安全；清理只删除匹配本库命名规则的过期文件。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | info 及以上级别的门槛 |
| `LOG_DEBUG` | 空 | debug/trace 白名单关键词 |
| `LOG_DIR` | `logs` | 日志文件目录 |
| `LOG_FILE_NAME` | `app` | 主日志文件名前缀 |
| `LOG_FILE_EXT` | `.log` | 文件扩展名 |
| `LOG_FILE_DATE` | `true` | 文件名日期后缀（`off` = 单文件） |
| `LOG_ERROR_FILE` | `true` | 错误文件开关 |
| `LOG_KEEP_DAYS` | `30` | 日志保留天数（`0` = 永久保留） |
| `LOG_CONSOLE` | `true` | 控制台开关 |
| `LOG_FILE` | `true` | 文件开关 |
| `LOG_PRETTY` | 非 prod 为 `true` | 控制台彩色可读 / JSON 行 |
| `LOG_DEV` | 随 `NODE_ENV` | dev 专属输出强制开关 |
| `LOG_LEVEL_<NAME>` | — | 模块级最低级别覆盖 |
| `LOG_CONSOLE_<NAME>` | — | 模块级控制台开关 |
| `LOG_FILE_<NAME>` | — | 模块级文件开关 |

## 浏览器使用

包通过 `package.json` 的 `exports` 条件路由自动区分环境（`node` → 含文件通道，`default` → 纯浏览器安全）：

```js
import { createLogger } from '@qirly/wb-log';

const log = createLogger('app.user');
log.info('hello');                    // 正常输出
log.file.info('仅 Node 生效');         // 浏览器中安全 no-op
```

- 打包安全：`node:fs` 等仅存在于 `index.node.js` 分支，Vite / webpack 不会打包进浏览器产物
- 浏览器控制台：`error` / `fatal` 走 `console.error`（红字），其余走 `console.log`

## 内置能力

- **自动脱敏**：`password` / `token` / `secret` / `key` / `cookie` 等字段递归（3 层）输出为 `***`
- **上下文注入**：`setLogContextProvider()` 可注入 `requestId` / `userId`，请求内日志自动携带
- **Error 提取**：传入 `Error` 自动提取 `message` + `stack`
- **计时器**：`const done = log.time('dbQuery'); ...; done();` 自动输出耗时
- **原始输出**：`import { logStdout as stdout } from '@qirly/wb-log'` 无时间戳装饰，适合 CLI 结果展示

## API 速查

| 导出 | 说明 |
| --- | --- |
| `createLogger(tag, options?)` | 创建模块 logger（推荐入口） |
| `log` / `logger` | 全局默认 logger（tag = `app`） |
| `configureLog(options)` | 全局编程配置 |
| `getLogConfig()` / `reloadLogConfig()` | 读取配置 / 重载环境变量 |
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
└── sanitize.js             # 日志脱敏
```

## License

[MIT](./LICENSE) © 2026 yijiu2025
