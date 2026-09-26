/**
 * 入力の記録と再生（D7）
 * 実機の生サンプル（位置・筆圧・傾き・時刻）をJSON化し、
 * パイプラインへ流し直して再現・回帰テストできるようにする。
 */
import type { PenInputEvent } from './input.js';

export interface RecordedInputEvent {
  /** 記録開始からの経過 ms */
  t: number;
  type: 'down' | 'move' | 'up' | 'cancel';
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  pointerType: string;
  /** 消しゴムスイッチで開始したストローク */
  eraser: boolean;
  pointerId: number;
}

export interface InputRecording {
  version: 1;
  createdAt: string;
  events: RecordedInputEvent[];
}

/**
 * PenInputEvent を逐次記録する。start() で記録開始、stop() で JSON 化。
 */
export class InputRecorder {
  private events: RecordedInputEvent[] = [];
  private startT: number | null = null;
  private active = false;

  get recording(): boolean {
    return this.active;
  }

  get count(): number {
    return this.events.length;
  }

  start(): void {
    this.events = [];
    this.startT = null;
    this.active = true;
  }

  /** handlePenInput へ届いた生イベントを記録する（フィルタ適用前） */
  record(ev: PenInputEvent): void {
    if (!this.active) return;
    const p = ev.point;
    if (this.startT === null) this.startT = p.timestamp;
    this.events.push({
      t: p.timestamp - this.startT,
      type: ev.type,
      x: p.x,
      y: p.y,
      pressure: p.pressure,
      tiltX: p.tiltX,
      tiltY: p.tiltY,
      pointerType: ev.pointerType,
      eraser: ev.eraser,
      pointerId: ev.pointerId,
    });
  }

  stop(): InputRecording {
    this.active = false;
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      events: this.events,
    };
  }
}

/** 記録を PenInputEvent 列へ戻す（テスト・再現用） */
export function recordingToEvents(rec: InputRecording): PenInputEvent[] {
  return rec.events.map((e) => ({
    type: e.type,
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    eraser: e.eraser,
    point: {
      x: e.x,
      y: e.y,
      pressure: e.pressure,
      tiltX: e.tiltX,
      tiltY: e.tiltY,
      timestamp: e.t,
      pointerId: e.pointerId,
    },
  }));
}

/**
 * 記録をハンドラーへ再生する。
 * realtime=true で記録時の時間間隔を再現する（speed で倍速可）。
 */
export async function replayRecording(
  rec: InputRecording,
  handler: (ev: PenInputEvent) => void,
  opts: { realtime?: boolean; speed?: number } = {},
): Promise<void> {
  const speed = opts.speed ?? 1;
  let last = 0;
  for (const ev of recordingToEvents(rec)) {
    if (opts.realtime) {
      const delay = (ev.point.timestamp - last) / speed;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
    last = ev.point.timestamp;
    handler(ev);
  }
}
