const WEBHOOK_URL = process.env.DINGTALK_WEBHOOK_URL;
const ADMIN_URL = process.env.GLOBALCALL_BASE_URL || '';
const ALERT_SUMMARY = process.env.ALERT_SUMMARY || '';

if (!WEBHOOK_URL) {
  console.error('Missing required env: DINGTALK_WEBHOOK_URL');
  process.exit(1);
}

const detailLine = ALERT_SUMMARY
  ? `近五分钟内\n\n${ALERT_SUMMARY.split('|').map(s => `- ${s}`).join('\n')}`
  : '- 监控脚本执行失败告警：无法查询 Global Call 使用日志（API 异常或请求超时）';

const payload = {
  msgtype: 'markdown',
  markdown: {
    title: 'Global Call 监控告警',
    text: [
      '### ⚠️ Global Call 监控告警',
      '',
      detailLine,
      '',
      `[查看日志](${ADMIN_URL})`,
    ].join('\n'),
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
