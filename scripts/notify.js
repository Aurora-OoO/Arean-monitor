const WEBHOOK_URL = process.env.DINGTALK_WEBHOOK_URL;
const ADMIN_URL = process.env.GLOBALCALL_BASE_URL || '';
const ALERT_SUMMARY = process.env.ALERT_SUMMARY || '';

const MAX_TRACE_PAIRS = 3;              // 每个模型最多展示几对排查 ID，避免消息过长
const DRY_RUN = process.env.DINGTALK_DRY_RUN === '1';

if (!WEBHOOK_URL && !DRY_RUN) {
  console.error('Missing required env: DINGTALK_WEBHOOK_URL');
  process.exit(1);
}

// monitor.js 输出的结构化摘要；解析失败时按旧版纯文本兜底
function parseSummary(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && ('models' in parsed || 'volume' in parsed)) {
      return parsed;
    }
  } catch {
    // 非 JSON：接口异常等单行告警
  }
  return null;
}

function renderTracePairs(pairs = []) {
  return pairs
    .slice(0, MAX_TRACE_PAIRS)
    .map(pair => {
      const ids = [];
      if (pair.requestId) ids.push(`request_id ${pair.requestId}`);
      if (pair.traceId) ids.push(`traceId ${pair.traceId}`);
      return ids.length > 0 ? `- ${ids.join(' · ')}` : null;
    })
    .filter(Boolean);
}

function renderModel(m) {
  const lines = [
    `**【${m.typeLabel}】${m.name}**`,
    `- 失败 **${m.errors}** / 总 ${m.total} 次 · 成功率 **${m.successRate}%**（阈值 ${m.threshold}%）`,
  ];
  if (m.errorCode) {
    lines.push(`- 错误码 ${m.errorCode}`);
  }
  lines.push(...renderTracePairs(m.tracePairs));
  return lines.join('\n');
}

function renderMessage() {
  const blocks = ['### ⚠️ Global Call 监控告警'];
  const payload = parseSummary(ALERT_SUMMARY);

  if (payload) {
    const subtitle = [`近 ${payload.lookbackMinutes} 分钟`];
    if (payload.volume) subtitle.push('总调用量偏低');
    if (payload.models?.length > 0) subtitle.push(`${payload.models.length} 个模型异常`);
    blocks.push(`> ${subtitle.join(' · ')}`);

    if (payload.volume) {
      blocks.push(`**平台总调用量异常**\n- 近 ${payload.lookbackMinutes} 分钟仅 ${payload.volume.calls} 次调用（阈值 ${payload.volume.threshold} 次）`);
    }

    for (const m of payload.models ?? []) {
      blocks.push(renderModel(m));
    }
  } else {
    const fallback = ALERT_SUMMARY || `监控脚本执行失败告警：无法查询 Global Call 使用日志（API 异常或请求超时）`;
    blocks.push(fallback.split('|').map(s => `- ${s.trim()}`).join('\n'));
  }

  if (ADMIN_URL) {
    blocks.push(`[查看日志](${ADMIN_URL})`);
  }
  return blocks.join('\n\n');
}

const text = renderMessage();

if (DRY_RUN) {
  console.log('--- DingTalk markdown (dry run) ---');
  console.log(text);
  process.exit(0);
}

const payload = {
  msgtype: 'markdown',
  markdown: {
    title: 'Global Call 监控告警',
    text,
  },
};

console.log('Sending DingTalk alert ...');

const res = await fetch(WEBHOOK_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

const body = await res.text();
console.log(`DingTalk response: ${res.status} ${body}`);

if (!res.ok) {
  console.error('Failed to send DingTalk alert.');
  process.exit(1);
}

console.log('Alert sent successfully.');
