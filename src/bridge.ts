// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { Channel, invoke } from '@tauri-apps/api/core';

export interface Settings {
  provider: 'claude-code' | 'openrouter';
  openrouterKey: string;
  openrouterModel: string;
  claudePath: string;
  claudeModel: string;
  deviceControl: boolean;
  confirmCommands: boolean;
  sttModel: string;
  voiceVolume: number;
  ambienceVolume: number;
  setupDone: boolean;
  platform?: string;
}

export type AiEvent = { type: 'doing'; label: string };

/** Where the person is, read from this computer's own settings (no network lookup). */
export interface Place {
  timeZone: string; // IANA zone, e.g. "Europe/Warsaw"
  utcOffset: string; // e.g. "UTC+01:00"
  localTime: string; // e.g. "Friday, November 20, 2026 at 10:42 AM"
  locale: string; // system language/region, e.g. "pl-PL"
  region: string; // country from the system region, e.g. "Poland" ('' if unknown)
}

export function wherePersonIs(now = new Date()): Place {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const locale = navigator.languages?.[0] || navigator.language || 'en-US';
  let region = '';
  try {
    const code = new Intl.Locale(locale).maximize().region;
    if (code) region = new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? '';
  } catch { /* unknown locale */ }
  const off = -now.getTimezoneOffset();
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const utcOffset = `UTC${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
  const localTime = now.toLocaleString('en-US', {
    timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return { timeZone, utcOffset, localTime, locale, region };
}

export type AskResult = { ok: true; text: string } | { ok: false; error: string };

export const bridge = {
  getSettings: () => invoke<Settings>('get_settings'),
  setSettings: (next: Partial<Settings>) => invoke<Settings>('set_settings', { next }),

  async ask(text: string, onEvent: (ev: AiEvent) => void): Promise<AskResult> {
    const ch = new Channel<AiEvent>();
    ch.onmessage = onEvent;
    try {
      return { ok: true, text: await invoke<string>('ask', { text, place: wherePersonIs(), onEvent: ch }) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  /** Ask User for a drawing; returns the SVG strokes his paint program traces. */
  async draw(subject: string): Promise<{ ok: true; svg: string } | { ok: false; error: string }> {
    try {
      return { ok: true, svg: await invoke<string>('draw', { subject }) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  /** Remember how the person felt about a drawing (used to improve the next ones). */
  drawingFeedback: (subject: string, liked: boolean, note = '') => invoke<void>('drawing_feedback', { subject, liked, note }),
  /** Save PNG bytes into Pictures/User; returns the file path. */
  saveDrawing: (png: Uint8Array, subject: string) => invoke<string>('save_drawing', { png: Array.from(png), subject }),
  cancel: () => invoke<void>('cancel'),
  reset: () => invoke<void>('reset'),
  listModels: () => invoke<string[]>('list_models'),

  micStart: () => invoke<void>('mic_start'),
  async micStop(): Promise<Float32Array> {
    const buf = await invoke<ArrayBuffer>('mic_stop');
    return new Float32Array(buf);
  },
  micCancel: () => invoke<void>('mic_cancel'),
};
