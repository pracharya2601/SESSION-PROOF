/**
 * Types for the vendored Vexo Open library (index.js). Ours, not the kit's: only what the
 * Field Assistant uses is declared. Names and shapes follow band.js / docs/api.md at the
 * vendored commit (see README.md).
 */

export class VexoError extends Error {
  constructor(code: string, message: string);
  /** Short machine-readable reason, e.g. "not-found-nearby", "denied", "no-web-bluetooth". */
  code: string;
}

/** Base class of every way to reach a band. */
export class Transport {
  kind: string;
  open(): Promise<void>;
  close(): Promise<void>;
}

export interface SimTransportOptions {
  /** Raw Opus packets (from oggPackets) the pretend band plays as its audio stream, looping. */
  audioPackets?: Uint8Array[] | null;
  firmware?: "1.0" | "1.1";
  via?: "ble" | "usb";
  realtime?: boolean;
}

/** The pretend band. */
export class SimTransport extends Transport {
  constructor(number?: number, options?: SimTransportOptions);
  number: number;
  /** The link is lost; with autoReconnect the band comes back by itself. */
  dropLink(seconds?: number | null): void;
}

export interface BandInfo {
  number: number;
  protocol: "1.0" | "1.1";
  firmware: string;
  features: string[];
  hardware: number;
  capabilities: string[];
  maxFrame: number;
  uptimeMs: number;
}

export interface AudioEvent {
  /** 0..65535, wraps; starts again at 0 on a new audio run (e.g. after a reconnect). */
  seq: number;
  /** One raw Opus packet: 16 kHz mono, 20 ms. */
  opus: Uint8Array;
  /** ms since 1970: arrival of the run's first packet + 20 ms per packet since. */
  time: number;
}

export interface BatteryEvent {
  percent: number;
  millivolts: number;
  state: "battery" | "charging" | "charged";
  charging: boolean;
  time: number;
}

export interface DisconnectEvent {
  reason: "closed" | "lost" | "restart" | "sleep" | "wrong-band" | "session-ended";
  reconnect?: "gave-up";
  message?: string;
  found?: number;
  wanted?: number;
}

export interface ReconnectingEvent {
  reason: "lost" | "session-ended";
  seconds: number;
  message?: string;
}

export interface ReconnectedEvent {
  attempts: number;
  seconds: number;
  failed: string[];
}

export interface NoticeEvent {
  kind: "low-battery" | "critical-battery" | "stream-dropped" | "usb-power" | string;
  arg: number;
  time: number;
}

export interface BandEvents {
  audio: AudioEvent;
  battery: BatteryEvent;
  disconnect: DisconnectEvent;
  reconnecting: ReconnectingEvent;
  reconnected: ReconnectedEvent;
  notice: NoticeEvent;
}

export interface ConfigureOptions {
  audio?: boolean;
  /** true, or seconds between readings. */
  battery?: boolean | number;
}

export interface ConnectOptions {
  /** Default 'ble' (Web Bluetooth). */
  transport?: "ble" | "serial" | "sim" | Transport;
  autoReconnect?: boolean;
  reconnectSeconds?: number;
  timeoutMs?: number;
}

export class Band {
  /** Must run inside a click handler for 'ble' and 'serial' (browser chooser). */
  static connect(number: number | null, options?: ConnectOptions): Promise<Band>;
  readonly number: number | null;
  /** "Vexo-HACK-42" */
  readonly name: string | null;
  readonly info: BandInfo | null;
  readonly connected: boolean;
  readonly reconnecting: boolean;
  readonly transportKind: "ble" | "serial" | "sim" | "custom";
  readonly streams: { audio: boolean; [stream: string]: unknown };
  /** Returns a function that stops listening. */
  on<K extends keyof BandEvents>(type: K, handler: (e: BandEvents[K]) => void): () => void;
  off<K extends keyof BandEvents>(type: K, handler: (e: BandEvents[K]) => void): void;
  configure(wanted: ConfigureOptions): Promise<unknown>;
  /** Fails with code 'denied' while the microphone is on. */
  setLed(colour: string, options?: { brightness?: number; pattern?: "off" | "solid" | "blink" | "breathe" | "flash" | "rainbow"; period?: number }): Promise<void>;
  /** Blink white for a few seconds (1..30, default 5). Fails with 'denied' while the microphone is on. */
  identify(seconds?: number): Promise<void>;
  getBattery(): Promise<Omit<BatteryEvent, "time">>;
  disconnect(): Promise<void>;
}

/** The raw Opus packets of an Ogg Opus file. */
export function oggPackets(bytes: Uint8Array): Uint8Array[];
