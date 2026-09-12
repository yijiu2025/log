/**
 * wb-log Node 入口：静态注入文件通道（按天滚动、过期清理）
 *
 * package.json exports 按 conditions 路由：
 *   - Node（require/import）→ 本文件：带文件通道的完整能力
 *   - 浏览器/其他 → ./index.js：纯控制台实现（无 node: 依赖）
 *
 * 直接引用文件路径时：Node 环境请 import 本文件（或经 src/framework/log 适配层），
 * 浏览器 import './index.js'。
 *
 * @author yijiu2025
 * @since 2026-09-12
 */
import { nodeFileTransport } from './file-transport.node.js';
import { setFileTransport } from './transports.js';

setFileTransport(nodeFileTransport);

export * from './index.js';
export { default } from './index.js';
