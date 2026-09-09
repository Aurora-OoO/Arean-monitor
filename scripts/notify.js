const WEBHOOK_URL = process.env.DINGTALK_WEBHOOK_URL;
const ADMIN_URL = process.env.ADMIN_URL || 'https://your-global-call-url/';
const ALERT_SUMMARY = process.env.ALERT_SUMMARY || '';

if (!WEBHOOK_URL) {
  console.error('Missing required env: DINGTALK_WEBHOOK_URL');
  process.exit(1);
}

const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');

const detailLine = ALERT_SUMMARY
  ? `**异常模型：** ${ALERT_SUMMARY}`
  : '**详情：** 监控脚本执行失败（API 异常或请求超时）';

const payload = {
  msgtype: 'markdown',
  markdown: {
    title: '模型异常告警',
    text: [
      '### ⚠️ 模型异常告警',
      '',
      `**检测时间：** ${now}`,
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
