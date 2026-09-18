/**
 * 上游响应头白名单过滤
 *
 * 移植自 sub2api internal/util/responseheaders：转发到下游客户端时
 * 只放行安全/有语义的响应头，防止上游（Anthropic/Cloudflare）的
 * 内部头（如 cf-*、server、内部追踪头等）泄漏给客户端。
 *
 * content-length / transfer-encoding / connection 由 HTTP 层自动
 * 处理，不在白名单内；content-encoding 由调用方按既有 skipHeaders
 * 约定处理（解压后不能回传原编码头）。
 */

const ALLOWED_HEADERS = new Set([
  'content-type',
  'content-language',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'vary',
  'date',
  'x-request-id',
  'retry-after',
  'location',
  'www-authenticate',
  // Codex/Responses 类客户端用它判断推理 token 是否已计入 usage
  'x-reasoning-included'
])

// 允许透传的响应头前缀（限流家族）
const ALLOWED_PREFIXES = ['x-ratelimit-', 'anthropic-ratelimit-']

// 明确剔除的 hop-by-hop / 编码相关头
const FORCE_REMOVE = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'content-encoding'
])

function isAllowed(lowerKey) {
  if (FORCE_REMOVE.has(lowerKey)) {
    return false
  }
  if (ALLOWED_HEADERS.has(lowerKey)) {
    return true
  }
  return ALLOWED_PREFIXES.some((p) => lowerKey.startsWith(p))
}

/**
 * 过滤上游响应头，返回可回写给客户端的子集（保留原始大小写）。
 */
function filterResponseHeaders(headers) {
  const out = {}
  if (!headers || typeof headers !== 'object') {
    return out
  }
  for (const [key, value] of Object.entries(headers)) {
    if (isAllowed(key.toLowerCase())) {
      out[key] = value
    }
  }
  return out
}

/**
 * 判断某个响应头是否允许回写给客户端。
 */
function isResponseHeaderAllowed(key) {
  return isAllowed(String(key || '').toLowerCase())
}

module.exports = { filterResponseHeaders, isResponseHeaderAllowed }
