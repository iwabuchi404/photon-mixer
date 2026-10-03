/**
 * 表示変換テスト（露出・トーンマップ・OETF）。
 * 各演算子が単調・[0,1]有界で、黒→0・露出が効くことを検証する。
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import {
  evToExposure, tonemap, linearToDisplaySrgb, displayTransform, clampViewEV,
  CLIP_OVER_RED, CLIP_UNDER_BLUE,
  VIEW_EV_MIN, VIEW_EV_MAX, TONEMAP_IDS, DISPLAY_MODE_IDS,
  type TonemapId, type DisplayModeId, type RGB,
} from '../src/color/display.js';

const inRange01 = (rgb: RGB) => rgb.every(v => v >= -1e-6 && v <= 1 + 1e-6);
const approx = (a: number, b: number, e = 1e-6) => Math.abs(a - b) <= e;

describe('evToExposure', () => {
  test('EV0=×1, +1=×2, -1=×0.5', () => {
    assert.ok(Math.abs(evToExposure(0) - 1) < 1e-9);
    assert.ok(Math.abs(evToExposure(1) - 2) < 1e-9);
    assert.ok(Math.abs(evToExposure(-1) - 0.5) < 1e-9);
    assert.ok(Math.abs(evToExposure(2) - 4) < 1e-9);
  });
});

describe('enum インデックスの一貫性', () => {
  test('TONEMAP_IDS / DISPLAY_MODE_IDS の順序が固定', () => {
    assert.deepStrictEqual(TONEMAP_IDS, ['pbrNeutral', 'agx', 'reinhard', 'none']);
    assert.deepStrictEqual(DISPLAY_MODE_IDS, ['transform', 'raw', 'clip']);
  });

  test('未知の id は indexOf で -1 になる（WGSL 側 i32(-0.5)=0 で化けるため入力側で弾く）', () => {
    // 検算: uniform に -1 が入ると fs_display の分岐が 0（= 先頭）に落ちる
    assert.strictEqual(TONEMAP_IDS.indexOf('aces' as TonemapId), -1);
    assert.strictEqual(DISPLAY_MODE_IDS.indexOf('clipWarning' as never), -1);
  });
});

describe('表示露出 EV の範囲', () => {
  test('UI(.pmx検証)と単一の出所(-6..+6)を共有する', () => {
    assert.strictEqual(VIEW_EV_MIN, -6);
    assert.strictEqual(VIEW_EV_MAX, 6);
  });

  test('clampViewEV は範囲外を丸める', () => {
    assert.strictEqual(clampViewEV(0), 0);
    assert.strictEqual(clampViewEV(6), 6);
    assert.strictEqual(clampViewEV(-6), -6);
    assert.strictEqual(clampViewEV(1000), VIEW_EV_MAX);
    assert.strictEqual(clampViewEV(-1000), VIEW_EV_MIN);
  });
});

describe('トーンマップ各演算子', () => {
  for (const id of TONEMAP_IDS) {
    test(`${id}: 黒は黒`, () => {
      const out = tonemap([0, 0, 0], id);
      assert.ok(out.every(v => Math.abs(v) < 1e-3), `${id} black=${out}`);
    });

    test(`${id}: HDR入力でも [0,1] に収まる`, () => {
      for (const v of [0.5, 1, 4, 16, 64]) {
        assert.ok(inRange01(tonemap([v, v, v], id)), `${id} v=${v}`);
      }
    });

    test(`${id}: グレースケールで単調増加`, () => {
      let prev = -1;
      for (const v of [0, 0.1, 0.25, 0.5, 1, 2, 4, 8]) {
        const out = tonemap([v, v, v], id)[0];
        assert.ok(out >= prev - 1e-6, `${id} not monotonic at v=${v} (${out} < ${prev})`);
        prev = out;
      }
    });
  }

  test('none は単純クランプ', () => {
    assert.deepStrictEqual(tonemap([0.3, 1.5, -0.2], 'none'), [0.3, 1, 0]);
  });

  test('reinhard: x/(1+x)', () => {
    const out = tonemap([1, 3, 0], 'reinhard');
    assert.ok(Math.abs(out[0] - 0.5) < 1e-9);
    assert.ok(Math.abs(out[1] - 0.75) < 1e-9);
    assert.strictEqual(out[2], 0);
  });

  test('pbrNeutral: 低輝度はほぼ素通し（しきい値以下は無圧縮）', () => {
    const out = tonemap([0.3, 0.3, 0.3], 'pbrNeutral');
    // startCompression(0.76) 未満 → ほぼ入力どおり（offset 0.04 補正のみ）
    assert.ok(out.every(v => Math.abs(v - 0.3) < 0.05), `out=${out}`);
  });
});

describe('linearToDisplaySrgb', () => {
  test('露出を上げると表示値が上がる（none/中間値）', () => {
    const lo = linearToDisplaySrgb([0.2, 0.2, 0.2], evToExposure(0), 'none');
    const hi = linearToDisplaySrgb([0.2, 0.2, 0.2], evToExposure(1), 'none');
    assert.ok(hi[0] > lo[0]);
  });

  test('sRGB OETF が掛かる（リニア0.5 < 表示値）', () => {
    // none で linear 0.5 → sRGB ≈ 0.735
    const out = linearToDisplaySrgb([0.5, 0.5, 0.5], 1, 'none');
    assert.ok(out[0] > 0.7 && out[0] < 0.76, `out=${out[0]}`);
  });

  test('HDR値も表示は [0,1]', () => {
    const out = linearToDisplaySrgb([10, 5, 1], 1, 'pbrNeutral');
    assert.ok(inRange01(out));
  });
});

describe('displayTransform（fs_display の CPU twin）', () => {
  test('mode=transform は linearToDisplaySrgb と一致する', () => {
    for (const id of TONEMAP_IDS) {
      for (const v of [0, 0.05, 0.3, 0.8, 1, 3, 20]) {
        const viaFull = displayTransform([v, v * 0.5, 0.1], { exposure: 2, tonemap: id, mode: 'transform' });
        const viaShort = linearToDisplaySrgb([v, v * 0.5, 0.1], 2, id);
        assert.ok(approx(viaFull[0], viaShort[0], 1e-9), `${id} v=${v}`);
        assert.ok(approx(viaFull[1], viaShort[1], 1e-9), `${id} v=${v}`);
        assert.ok(approx(viaFull[2], viaShort[2], 1e-9), `${id} v=${v}`);
      }
    }
  });

  test('mode=raw はトーンマップせずクランプのみ（tonemap=none と同じ）', () => {
    for (const v of [0, 0.25, 1, 2, 64]) {
      const raw = displayTransform([v, v, v], { exposure: 1, tonemap: 'agx', mode: 'raw' });
      const none = displayTransform([v, v, v], { exposure: 1, tonemap: 'none', mode: 'transform' });
      assert.ok(approx(raw[0], none[0], 1e-9), `v=${v}`);
    }
    // 負値も 0 に丸める
    assert.strictEqual(displayTransform([-1, 0.5, 2], { exposure: 1, tonemap: 'agx', mode: 'raw' })[0], 0);
  });

  describe('クリップ警告（mode=clip）', () => {
    test('>1.0 は赤、<0.0 は青', () => {
      const p = { exposure: 1, tonemap: 'pbrNeutral', mode: 'clip' } as const;
      assert.deepStrictEqual(displayTransform([1.5, 0, 0], p), CLIP_OVER_RED);
      assert.deepStrictEqual(displayTransform([0, 0, 1.0001], p), CLIP_OVER_RED);
      assert.deepStrictEqual(displayTransform([-0.5, 0, 0], p), CLIP_UNDER_BLUE);
      assert.deepStrictEqual(displayTransform([0, 0, -0.0001], p), CLIP_UNDER_BLUE);
    });

    test('判定は露出前（=作品データそのもの）の値で行う', () => {
      // 露出 +3 なら表示上は 4.0 になるが、シーン値が 0.5 なら赤くはならない
      const p = { exposure: 8, tonemap: 'pbrNeutral', mode: 'clip' } as const;
      const out = displayTransform([0.5, 0.5, 0.5], p);
      assert.notDeepStrictEqual(out, CLIP_OVER_RED);
      assert.ok(inRange01(out));
      // シーン値が 1.0 超なら露出倍率に関わらず赤
      assert.deepStrictEqual(displayTransform([2, 2, 2], p), CLIP_OVER_RED);
    });

    test('範囲内は通常表示になる（警告色を出さない）', () => {
      const p = { exposure: 1, tonemap: 'pbrNeutral', mode: 'clip' } as const;
      assert.ok(inRange01(displayTransform([0.5, 0.5, 0.5], p)));
      // ちょうど 1.0 は警告しない（>1.0 が条件）
      assert.notDeepStrictEqual(displayTransform([1, 1, 1], p), CLIP_OVER_RED);
      // ちょうど 0.0 は警告しない（<0.0 が条件）
      assert.notDeepStrictEqual(displayTransform([0, 0, 0], p), CLIP_UNDER_BLUE);
    });

    test('警告は表示モードが clip のときだけ（transform/raw では出さない）', () => {
      for (const mode of ['transform', 'raw'] as DisplayModeId[]) {
        const out = displayTransform([4, 4, 4], { exposure: 1, tonemap: 'none', mode });
        assert.notDeepStrictEqual(out, CLIP_OVER_RED);
      }
    });
  });

  describe('HDR出力（hdrOut=true）', () => {
    test('トーンマップも raw も迂回し、1.0 を超える値を返す', () => {
      const out = displayTransform([4, 1, 0.25], { exposure: 1, tonemap: 'agx', mode: 'transform', hdrOut: true });
      // AgX なら 4.0 はほぼ白に潰れるが、HDR 出力では光量 4.0 がそのまま通る
      assert.ok(out[0] > 1, `out=${out}`);
      assert.ok(out[0] > out[1] && out[1] > out[2], `単調性が必要: ${out}`);
      // 拡張 OETF: 4.0 -> 1.055*4^(1/2.4)-0.055
      assert.ok(approx(out[0], 1.055 * Math.pow(4, 1 / 2.4) - 0.055, 1e-9), `out=${out[0]}`);
    });

    test('mode=raw より優先される（分岐順の固定）', () => {
      const viaRaw = displayTransform([4, 4, 4], { exposure: 1, tonemap: 'none', mode: 'raw', hdrOut: true });
      assert.ok(viaRaw[0] > 1, `hdrOut は raw より優先されるべき: ${viaRaw}`);
    });

    test('mode=clip の警告は hdrOut より優先される', () => {
      assert.deepStrictEqual(
        displayTransform([4, 4, 4], { exposure: 1, tonemap: 'none', mode: 'clip', hdrOut: true }),
        CLIP_OVER_RED,
      );
    });

    test('負値は 0 に丸める（extended でも下側はクランプ）', () => {
      assert.strictEqual(displayTransform([-2, 0, 0], { exposure: 1, tonemap: 'none', mode: 'transform', hdrOut: true })[0], 0);
    });

    test('露出が効く', () => {
      const lo = displayTransform([0.25, 0.25, 0.25], { exposure: 1, tonemap: 'none', mode: 'transform', hdrOut: true });
      const hi = displayTransform([0.25, 0.25, 0.25], { exposure: 4, tonemap: 'none', mode: 'transform', hdrOut: true });
      assert.ok(hi[0] > lo[0]);
      // 露出 +2EV なら 0.25*4 = 1.0 ちょうど → 表示 1.0
      assert.ok(approx(hi[0], 1, 1e-3), `hi=${hi[0]}`);
    });
  });

  test('hdrOut でない限り出力は必ず [0,1]（PNG書き出しの前提）', () => {
    for (const id of TONEMAP_IDS) {
      for (const mode of DISPLAY_MODE_IDS) {
        for (const ev of [-6, 0, 6]) {
          for (const v of [0, 0.1, 0.9, 1, 10, 5000]) {
            const out = displayTransform([v, v * 0.3, v * 0.01], {
              exposure: evToExposure(ev), tonemap: id, mode, hdrOut: false,
            });
            assert.ok(inRange01(out), `${id}/${mode}/ev${ev} v=${v} -> ${out}`);
            assert.ok(out.every(Number.isFinite), `${id}/${mode}/ev${ev} v=${v} -> ${out}`);
          }
        }
      }
    }
  });

  test('グレースケールで単調非減少（露出・トーンマップ種別によらず）', () => {
    for (const id of TONEMAP_IDS) {
      for (const mode of DISPLAY_MODE_IDS) {
        let prev = -1;
        // clip モードは非単調（赤/青の途切れ）になるので単調性の対象外
        if (mode === 'clip') continue;
        for (const v of [0, 0.02, 0.1, 0.3, 0.6, 1, 2, 8, 64]) {
          const out = displayTransform([v, v, v], { exposure: 1, tonemap: id, mode })[0];
          assert.ok(out >= prev - 1e-3, `${id}/${mode} v=${v} -> ${out} < ${prev}`);
          prev = out;
        }
      }
    }
  });

  test('黒は黒（HDR出力でも 0）', () => {
    for (const id of TONEMAP_IDS) {
      for (const mode of DISPLAY_MODE_IDS) {
        for (const hdrOut of [false, true]) {
          const out = displayTransform([0, 0, 0], { exposure: 1, tonemap: id, mode, hdrOut });
          assert.ok(out.every(v => Math.abs(v) < 1e-3), `${id}/${mode}/hdr=${hdrOut} -> ${out}`);
        }
      }
    }
  });
});
