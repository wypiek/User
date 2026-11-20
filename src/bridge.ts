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

export type AskResult = { ok: true; text: string } | { ok: false; error: string };

export const bridge = {
  getSettings: () => invoke<Settings>('get_settings'),
  setSettings: (next: Partial<Settings>) => invoke<Settings>('set_settings', { next }),

  async ask(text: string, onEvent: (ev: AiEvent) => void): Promise<AskResult> {
    const ch = new Channel<AiEvent>();
    ch.onmessage = onEvent;
    try {
      return { ok: true, text: await invoke<string>('ask', { text, onEvent: ch }) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
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
