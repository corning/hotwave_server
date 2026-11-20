/**
 * 上游（模型/网关）错误 → 用户可读文案
 *
 * 目标：
 *  - 额度/限流这类"环境问题"给明确说明与恢复时间，而不是把原始 JSON 抛给用户
 *  - 其它错误保留原始信息（截断），便于定位根因
 */

export function formatUpstreamError(raw: string): string {
  // 模型额度用尽（火山方舟/DeepSeek 等常见形态）
  if (/AccountQuotaExceeded|usage quota/i.test(raw)) {
    // 只取到时间与其时区为止（后面通常还跟着升级建议之类的长句）
    const reset = raw.match(/reset at ([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?: [+-][0-9]{4})?)/i)?.[1]?.trim();
    return reset
      ? '模型额度已用尽，将于 ' + reset + ' 重置；期间聊天与定时简报不可用。'
      : '模型额度已用尽，请稍后再试（期间聊天与定时简报不可用）。';
  }

  // 通用限流
  if (/429|TooManyRequests|rate limit/i.test(raw)) {
    return '模型请求过于频繁（限流），请稍后重试。';
  }

  // 认证/凭据问题
  if (/401|invalid api key|unauthorized/i.test(raw)) {
    return '模型凭据无效，请检查 .env 中的 API Key。';
  }

  return '服务异常：' + raw.slice(0, 120);
}
