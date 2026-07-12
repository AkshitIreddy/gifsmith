/**
 * ffmpeg process runner. gifsmith shells out to a system ffmpeg (kept off the
 * dependency tree deliberately — it is a large native binary that most demo
 * authors already have). All capture/encode is commodity; the value is what we
 * feed it. See loop/ and encode/.
 */
import { spawn, spawnSync } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export function ffmpegAvailable(): boolean {
  try {
    const r = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function assertFfmpeg(): void {
  if (!ffmpegAvailable()) {
    throw new Error(
      'gifsmith: ffmpeg not found on PATH. Install it (https://ffmpeg.org/) ' +
        'or set FFMPEG_PATH. It is the one non-npm dependency.',
    );
  }
}

/** Run ffmpeg, rejecting on a non-zero exit and surfacing the tail of stderr. */
export function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${err.split('\n').slice(-16).join('\n')}`));
    });
  });
}

/** Run ffmpeg and capture stdout as a Buffer (used for raw-frame MSE reads). */
export function runCapture(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}\n${err.split('\n').slice(-16).join('\n')}`));
    });
  });
}
