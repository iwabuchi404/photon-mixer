/**
 * HDR / 表示変換の GPU 検証
 *
 * 目的:
 *  1. `displayTransform`（CPU twin）と `fs_display`（WGSL）の**数値一致**を担保する。
 *     docs/plan/hdr-light.md のアーキテクチャ方針「表示変換は純粋関数に集約し
 *     CPU/GPU 同一式で実装し、代表値でのパリティをテスト」が要求する網。
 *     enum index の固定だけでは数式の乖離を防げない。
 *  2. HDR 出力（extended canvas）経路が実際に 1.0 超を出すことを確かめる。
 *  3. クリップ警告（>1=赤 / <0=青）が GPU 側でも出ることを確かめる。
 *  4. HDR 出力 ON 時に、トーンマップ/リニア生が UI 上で無効化されることを確かめる。
 *
 * 診断フック `__hdrProbe` が fs_display をオフスクリーンに 1 パス実行して読み戻す。
 * canvas を経由しないので「canvas は COPY_SRC 不可」という制約に掻られない。
 *
 * 2 つの SBS で回す:
 *   - SDR: 通常起動。canvas は 8bit（bgra8unorm）でクランプされる
 *   - HDR: `?hdr=1` 強制。canvas は rgba16float で 1.0 超を保持できる
 * HDR 非対応 display でも `?hdr=1` なら rgba16float canvas が受理されるため、
 * HDR 出力経路はどの環境でも検証できる。
 *
 * 前提: `npm run build` 済み（CPU twin は dist/src/color/display.js から読む）。
 * 実行: `node scripts/verify-hdr.mjs`
 */

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe');

const TONEMAP_IDS = ['pbrNeutral', 'agx', 'reinhard', 'none'];
const MODE_IDS = ['transform', 'raw', 'clip'];

let failures = 0;
const fail = (msg) => { failures++; console.log(`  [NG] ${msg}`); };
const ok = (msg) => { console.log(`  [ok] ${msg}`); };
const skip = (msg) => { console.log(`  (--) ${msg}`); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// SDR 域の代表値
const SDR_CASES = [
  [0, 0, 0],
  [0.02, 0.02, 0.02],
  [0.18, 0.18, 0.18],
  [0.5, 0.5, 0.5],
  [0.9, 0.4, 0.1],
  [1, 1, 1],
];
// HDR 域の代表値（Glow/加算（光）/露出で作りうる光量）
const HDR_CASES = [
  [1.5, 1.5, 1.5],
  [4, 4, 4],
  [4, 1, 0.25],
  [16, 8, 2],
  [64, 32, 8],
];
// クリップ警告。境界の 1.0001 は float16 では 1.0 に丸まるので使わない
//（実パイプラインでも判定できない。1.0 の直上は 1.0009765625 = 1 + 2^-10）。
const CLIP_CASES = [
  [2, 0, 0],        // >1  -> 赤
  [0, 0, 1.5],      // >1  -> 赤
  [-0.5, 0, 0],     // <0  -> 青
  [0, -0.25, 0],    // <0  -> 青
  [0.5, 0.5, 0.5],  // 範囲内 -> 通常表示
  [1, 1, 1],        // ちょうど 1.0 -> 警告しない
];

async function openApp(query) {
  const app = await electron.launch({
    executablePath: electronBin,
    args: [APP_DIR],
    timeout: 30_000,
    env: { ...process.env },
  });
  await new Promise((r) => setTimeout(r, 4500));
  let page = app.windows().find((w) => !w.url().startsWith('devtools://'));
  if (!page) page = await app.firstWindow();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  // electron/main.ts は loadFile('index.html') 固定なので、クエリは navigation で渡す
  if (query) {
    await page.goto(`file:///${path.join(APP_DIR, 'index.html')}${query}`);
    await page.waitForFunction(() => typeof window.__hdrState === 'function', null, { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { app, page, errors };
}

const probe = (page, colors, params) =>
  page.evaluate(async ([c, p]) => window.__hdrProbe(c, p), [colors, params]);

const px = (res, i) => res.values.slice(i * 4, i * 4 + 4);

async function compareWithCpuTwin(page, twin, tonemapId, modeId, ev, hdr, cases) {
  const params = {
    exposure: twin.evToExposure(ev),
    tonemap: TONEMAP_IDS.indexOf(tonemapId),
    mode: MODE_IDS.indexOf(modeId),
    hdr: hdr ? 1 : 0,
  };
  const gpu = await probe(page, cases, params);
  if (!gpu) { fail(`${tonemapId}/${modeId}/ev${ev}/hdr${hdr}: __hdrProbe が使えない`); return; }

  // 8bit フォーマットは 1/255 に量子化されている。float フォーマットは生値。
  const tol = gpu.mode === 'u8' ? 1.5 / 255 : 2e-3;
  let worst = 0;
  for (let i = 0; i < cases.length; i++) {
    const cpu = twin.displayTransform(cases[i], {
      exposure: twin.evToExposure(ev), tonemap: tonemapId, mode: modeId, hdrOut: hdr,
    });
    const got = px(gpu, i);
    for (let ch = 0; ch < 3; ch++) {
      const d = Math.abs(cpu[ch] - got[ch]);
      worst = Math.max(worst, d);
      if (!near(cpu[ch], got[ch], tol)) {
        fail(`${tonemapId}/${modeId}/ev${ev}/hdr${hdr} px${i} ch${ch}: CPU=${cpu[ch].toFixed(6)} GPU=${got[ch].toFixed(6)} 差=${d.toFixed(6)} tol=${tol.toFixed(6)} in=${cases[i]}`);
        return;
      }
    }
  }
  ok(`${tonemapId}/${modeId}/ev${ev}${hdr ? ' HDR出力' : ''}: ${cases.length}値一致（最大差 ${worst.toExponential(2)} / ${gpu.mode}）`);
}

async function runSuite(label, query, wantFloat) {
  console.log(`\n${'='.repeat(60)}\n${label}\n${'='.repeat(60)}`);

  const { app, page, errors } = await openApp(query);
  try {
    const gpuInfo = await page.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter();
      return { hasGPU: !!navigator.gpu, adapter: !!a };
    });
    if (!gpuInfo.hasGPU || !gpuInfo.adapter) throw new Error('WebGPU が利用できません');

    const state = await page.evaluate(() => window.__hdrState());
    console.log('HDR state:', JSON.stringify(state));
    const isFloat = state.format === 'rgba16float';
    console.log('canvas format:', state.format,
      isFloat ? '(float: 1.0超を保持)' : '(8bit: 1/255 に量子化・1.0超は表現不可)');
    if (wantFloat && !isFloat) fail(`${label}: rgba16float canvas が受理されなかった（extended 経路を検証できない）`);

    // CPU twin はビルド成果物から読む（src/ と乖離しないよう build 前提）
    const twin = await import('../dist/src/color/display.js');

    console.log('\n[1] GPU/CPU パリティ（SDR 入力・全トーンマップ x 全モード）');
    for (const t of TONEMAP_IDS) {
      for (const m of MODE_IDS) {
        await compareWithCpuTwin(page, twin, t, m, 0, false, SDR_CASES);
      }
    }

    console.log('\n[2] GPU/CPU パリティ（露出 -6 / -2 / +2 / +6 EV）');
    for (const ev of [-6, -2, 2, 6]) {
      await compareWithCpuTwin(page, twin, 'pbrNeutral', 'transform', ev, false, SDR_CASES);
      await compareWithCpuTwin(page, twin, 'agx', 'transform', ev, false, HDR_CASES);
    }

    console.log('\n[3] GPU/CPU パリティ（HDR 入力・全トーンマップ）');
    for (const t of TONEMAP_IDS) {
      await compareWithCpuTwin(page, twin, t, 'transform', 0, false, HDR_CASES);
    }

    console.log('\n[4] クリップ警告（GPU 側が仕様どおりの色を出すか）');
    {
      const res = await probe(page, CLIP_CASES, { exposure: 1, tonemap: 0, mode: MODE_IDS.indexOf('clip'), hdr: 0 });
      if (!res) {
        fail('clip: __hdrProbe が使えない');
      } else {
        const tol = res.mode === 'u8' ? 1.5 / 255 : 2e-3;
        for (let i = 0; i < CLIP_CASES.length; i++) {
          const expect = twin.displayTransform(CLIP_CASES[i], { exposure: 1, tonemap: 'pbrNeutral', mode: 'clip' });
          const got = px(res, i);
          for (let ch = 0; ch < 3; ch++) {
            if (!near(expect[ch], got[ch], tol)) {
              fail(`clip px${i} in=${CLIP_CASES[i]}: 期待=${expect.map((v) => v.toFixed(3)).join(',')} 実=${got.slice(0, 3).map((v) => v.toFixed(3)).join(',')}`);
            }
          }
        }
        const red = px(res, 0).slice(0, 3);
        near(red[0], 1, tol) && near(red[1], 0, tol) && near(red[2], 0, tol)
          ? ok('>1.0 が赤で出る')
          : fail(`>1.0 が赤でない: ${red.join(',')}`);
        const blue = px(res, 2).slice(0, 3);
        near(blue[2], 1, tol) && near(blue[0], 0, tol)
          ? ok('<0.0 が青で出る')
          : fail(`<0.0 が青でない: ${blue.join(',')}`);
        // ちょうど 1.0 は警告しない（>1.0 が条件）
        notClip(px(res, 5).slice(0, 3), tol, '1.0 ちょうど');
      }
    }

    console.log('\n[5] HDR出力（トーンマップ bypass・1.0 超の保持）');
    if (!isFloat) {
      skip('canvas が 8bit のため 1.0 超を表現できない（HDR suite で検証する）');
    } else {
      const res = await probe(page, HDR_CASES, { exposure: 1, tonemap: TONEMAP_IDS.indexOf('agx'), mode: 0, hdr: 1 });
      if (!res) {
        fail('hdrOut: __hdrProbe が使えない');
      } else {
        const over = HDR_CASES.filter((_, i) => Math.max(...px(res, i).slice(0, 3)) > 1);
        over.length > 0
          ? ok(`${over.length}/${HDR_CASES.length} 値が 1.0 超で出力（例 ${over[0]} → ${px(res, HDR_CASES.indexOf(over[0])).slice(0, 3).map((v) => v.toFixed(3)).join(',')}）`)
          : fail('HDR出力なのに 1.0 超が出ていない（extended OETF が効いていない疑い）');

        // トーンマップがバイパスされていること:
        // AgX なら 4.0 はほぼ 1.0 に潰れるが、HDR出力では「拡張 sRGB(4.0)」が出る
        const four = px(res, 1).slice(0, 3);
        const expected = 1.055 * Math.pow(4, 1 / 2.4) - 0.055;
        near(four[0], expected, 2e-3)
          ? ok(`トーンマップ bypass を確認（4.0 → ${four[0].toFixed(4)} / 期待 ${expected.toFixed(4)}）`)
          : fail(`トーンマップがバイパスされていない: 4.0 → ${four[0].toFixed(4)}（期待 ${expected.toFixed(4)}）`);

        const sdr = await probe(page, [HDR_CASES[1]], { exposure: 1, tonemap: 0, mode: 0, hdr: 0 });
        const sdrVal = px(sdr, 0)[0];
        four[0] > sdrVal
          ? ok(`SDR 出力(${sdrVal.toFixed(3)}) より明るい値が出ている`)
          : fail(`HDR出力が SDR を下回る: hdr=${four[0]} sdr=${sdrVal}`);

        // HDR出力でも負値は 0 に丸める
        const neg = await probe(page, [[-2, 0.5, 4]], { exposure: 1, tonemap: 0, mode: 0, hdr: 1 });
        near(px(neg, 0)[0], 0, 2e-3) ? ok('HDR出力でも負値は 0 に丸める') : fail(`HDR出力の負値が 0 でない: ${px(neg, 0)[0]}`);
      }
    }

    console.log('\n[6] HDR出力 ON/OFF トグルと UI 無効化（誤操作防止）');
    if (!state.capable) {
      skip('HDR 非対応環境のためスキップ');
    } else {
      // localStorage に前回の値が残っているので、明示的にトグルを駆動する
      const readUi = () => page.evaluate(() => ({
        hdr: window.__hdrState().on,
        toneDisabled: document.getElementById('view-tonemap').disabled,
        rawDisabled: [...document.getElementById('view-mode').options].find((o) => o.value === 'raw')?.disabled,
        noteVisible: getComputedStyle(document.getElementById('hdr-note')).display !== 'none',
      }));
      const setHdr = (on) => page.evaluate((want) => {
        const cb = document.getElementById('hdr-output');
        if (cb.checked !== want) { cb.checked = want; cb.dispatchEvent(new Event('change')); }
      }, on);

      await setHdr(true);
      await new Promise((r) => setTimeout(r, 200));
      const on = await readUi();
      on.hdr ? ok('トグルが ON になる') : fail('トグルが ON にならない');
      on.toneDisabled ? ok('ON: トーンマップが disabled') : fail('ON: トーンマップが有効なまま（無効のはず）');
      on.rawDisabled ? ok('ON: リニア生が disabled') : fail('ON: リニア生が有効なまま（無効のはず）');
      on.noteVisible ? ok('ON: 注記が表示される') : fail('ON: 注記が出ていない');

      // クリップ警告は HDR と併用可なので「モード」select 自体は有効なまま
      const modeStillEnabled = await page.evaluate(() => !document.getElementById('view-mode').disabled);
      modeStillEnabled ? ok('ON: 表示モード select は有効なまま（クリップ警告は併用可）') : fail('ON: 表示モードごと無効化されている');

      await setHdr(false);
      await new Promise((r) => setTimeout(r, 200));
      const off = await readUi();
      !off.hdr && !off.toneDisabled && !off.rawDisabled && !off.noteVisible
        ? ok('OFF にするとトグル・UI がすべて復活する')
        : fail(`OFF にしても UI が無効のまま: ${JSON.stringify(off)}`);
    }

    await new Promise((r) => setTimeout(r, 500));
    const realErrors = errors.filter((e) => !/favicon|DevTools|Autofill/i.test(e));
    realErrors.length === 0 ? ok('コンソールエラーなし') : fail(`コンソールエラー: ${realErrors.join(' | ')}`);
  } finally {
    try { await app.close(); } catch { /* already closed */ }
  }
}

function notClip(rgb, tol, what) {
  const isRed = near(rgb[0], 1, tol) && near(rgb[1], 0, tol) && near(rgb[2], 0, tol);
  const isBlue = near(rgb[2], 1, tol) && near(rgb[0], 0, tol);
  isRed || isBlue ? fail(`${what} がクリップ警告色になった: ${rgb.join(',')}`) : ok(`${what} は警告しない`);
}

console.log('PhotonMixer HDR / 表示変換 GPU 検証');
console.log('APP_DIR:', APP_DIR);
try {
  await runSuite('SDR suite（通常起動・canvas は 8bit）', '', false);
  await runSuite('HDR suite（?hdr=1 強制・canvas は rgba16float）', '?hdr=1', true);
  console.log(`\n=== 結果: 失敗 ${failures} 件 ===`);
} catch (e) {
  failures++;
  console.error('検証で例外:', e);
}
process.exit(failures > 0 ? 1 : 0);