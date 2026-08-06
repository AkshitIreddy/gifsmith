/**
 * The contract every capture backend satisfies, extracted so the two backends
 * can share it without one importing the other.
 *
 * The Director consumes exactly three members — `frames`, `timestamps` and
 * `stop()` — and everything downstream works off files on disk. Two properties
 * of that are implicit but binding on any new backend:
 *
 *  - frames must live in the Director's `framesDir`, because the concat list is
 *    written into that same directory and references frames by *basename*. The
 *    extension is free (the demuxer only sees basenames), the location is not.
 *  - only timestamp *differences* matter downstream, plus the span for the
 *    achieved-fps report. So a backend that knows its own cadence may emit
 *    synthetic timestamps from an arbitrary origin — which is precisely how the
 *    deterministic backend gets a sequence that is uniform by construction
 *    rather than uniform by resampling.
 */
import type { CDPSession } from 'puppeteer-core';

export interface CaptureHandle {
  client: CDPSession;
  /** Absolute file paths, in capture order. */
  frames: string[];
  /** Seconds as floats; only the differences between them are consumed. */
  timestamps: number[];
  /** MUST be idempotent — the Director calls it on success and again in `finally`. */
  stop(): Promise<void>;
}
