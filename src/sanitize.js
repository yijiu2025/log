/**
 * 日志脱敏工具
 *
 * 防止敏感数据（密码、token、密钥）泄露到日志中
 *
 * @author yijiu2025
 * @since 2026-08-17
 */

/** 需要脱敏的字段名模式 */
const SENSITIVE_PATTERNS = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /authorization/i,
  /cookie/i,
  /credential/i,
  // key(s) 后不能紧跟小写字母：命中 key/apiKey/primaryKey/keyId，放过 keyword/keyboard 等误伤
  /keys?(?![a-z])/i
];

/** 脱敏占位符 */
const MASK = '***';

/**
 * 对对象进行日志脱敏（递归，返回副本，不修改入参）。
 *
 * 命中敏感模式的键其值替换为 `'***'`；嵌套对象/数组递归处理。
 * 超过深度限制的节点整体替换为 `'[maxDepth]'` 字符串占位符 ——
 * 绝不透传未脱敏的原始对象，防止深层敏感字段绕过脱敏泄露。
 *
 * 注意：只处理对象/数组参数的**字段**，`msg` 字符串不做脱敏
 * （外部输入请先截断再入日志）。
 *
 * @param {*} obj - 要脱敏的值；非对象原样返回
 * @param {number} [depth=3] - 剩余递归深度；归零时返回 '[maxDepth]'
 * @returns {*} 脱敏后的副本：对象返回新对象、数组返回新数组、
 *          深度耗尽返回字符串 '[maxDepth]'、非对象原样返回
 */
function sanitizeForLog(obj, depth = 3) {
  if (!obj || typeof obj !== 'object') return obj;
  if (depth <= 0) return '[maxDepth]';

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForLog(item, depth - 1));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitive(key)) {
      result[key] = MASK;
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeForLog(value, depth - 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 判断字段名是否命中敏感模式（任一模式命中即视为敏感）。
 * @param {string} key - 字段名
 * @returns {boolean} true = 需要打码为 '***'
 */
function isSensitive(key) {
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(key));
}

/**
 * 脱敏 URL 中的敏感参数
 * @param {string} url - URL 字符串
 * @returns {string} 脱敏后的 URL
 */
function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return url;
  // 脱敏 query 参数中的敏感字段
  return url.replace(/([?&])(password|token|secret|key)=([^&]*)/gi, '$1$2=***');
}

/**
 * 脱敏 User-Agent（保留浏览器类型，去掉详细版本）
 * @param {string} ua - User-Agent 字符串
 * @returns {string} 脱敏后的 UA
 */
function sanitizeUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return ua;
  // 只保留前 100 个字符
  return ua.length > 100 ? ua.substring(0, 100) + '...' : ua;
}

export { sanitizeForLog, sanitizeUrl, sanitizeUserAgent };
