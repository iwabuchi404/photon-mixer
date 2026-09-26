// KamoX 動作確認ヘルパー（ローカル検証用・コミットしない想定でもOK）
// 使い方: node scripts/kamox-check.mjs <command> [args...]
const BASE = 'http://localhost:3014';

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'run') {
  // run <file.js>: 複数文をファイルから実行（evaluate が単一式しか受けないため eval 経由）
  const { readFileSync } = await import('node:fs');
  const code = readFileSync(args[0], 'utf8');
  const r = await api('/playwright/evaluate', { script: `eval(${JSON.stringify(code)})` });
  console.log(JSON.stringify(r.data ?? r, null, 1));
} else if (cmd === 'eval') {
  const r = await api('/playwright/evaluate', { script: args.join(' ') });
  console.log(JSON.stringify(r.data ?? r, null, 1));
} else if (cmd === 'shot') {
  const r = await api('/check-ui', {});
  const d = r.data ?? r;
  console.log('screenshot:', d.screenshot);
  console.log('errors:', JSON.stringify(d.errors));
} else if (cmd === 'logs') {
  const r = await api('/logs');
  const d = r.data ?? r;
  for (const e of d.runtime ?? []) console.log('[rt]', e.level, e.message);
  for (const [k, v] of Object.entries(d.pages ?? {})) {
    for (const e of v) console.log(`[${k}]`, e.level, e.message);
  }
} else if (cmd === 'drag') {
  // drag x1 y1 x2 y2 [steps]
  const [x1, y1, x2, y2, steps = 20] = args.map(Number);
  await api('/playwright/mouse', { action: 'move', x: x1, y: y1 });
  await api('/playwright/mouse', { action: 'down', x: x1, y: y1, button: 'left' });
  for (let i = 1; i <= steps; i++) {
    await api('/playwright/mouse', {
      action: 'move',
      x: x1 + ((x2 - x1) * i) / steps,
      y: y1 + ((y2 - y1) * i) / steps,
    });
  }
  await api('/playwright/mouse', { action: 'up', x: x2, y: y2, button: 'left' });
  console.log('dragged', x1, y1, '->', x2, y2);
} else if (cmd === 'click') {
  const r = await api('/playwright/element', { selector: args[0], action: 'click' });
  console.log(JSON.stringify(r.data ?? r));
} else if (cmd === 'fill') {
  const r = await api('/playwright/element', { selector: args[0], action: 'fill', value: args[1] });
  console.log(JSON.stringify(r.data ?? r));
} else if (cmd === 'text') {
  const r = await api('/playwright/element', { selector: args[0], action: 'textContent' });
  console.log(JSON.stringify(r.data ?? r));
} else if (cmd === 'wait') {
  await api('/playwright/wait', { timeout: Number(args[0] ?? 500) });
  console.log('waited');
} else {
  console.log('commands: eval <js> | shot | logs | drag x1 y1 x2 y2 [steps] | click <sel> | fill <sel> <v> | text <sel> | wait <ms>');
}
