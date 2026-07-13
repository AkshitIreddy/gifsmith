/**
 * The Timeline DSL — the direct fix for the biggest failure mode of ad-hoc demo
 * scripts: choreographing imperatively with racing promises. Here the walkthrough
 * is a declarative, ordered list of beats with named cues, holds, and explicit
 * `parallel`/`sequence` composition. "App does X, then the characters move"
 * becomes trivial and reproducible, and the whole thing is introspectable
 * (dryRun) and seekable (snapshot).
 *
 * Steps run in real time so CSS animations play naturally and the screencast
 * records true pacing (see capture/ and pacing/). Durations are authored in
 * seconds for readability and compiled to milliseconds.
 */
import type {
  CompiledTimeline,
  Easing,
  PageCallback,
  Point,
  Step,
} from '../types.js';

interface Registry {
  cues: string[];
  calls: Record<string, PageCallback>;
  hasLoopAnchor: boolean;
  callSeq: number;
}

export class TimelineBuilder {
  /** @internal collected steps for this scope */
  _steps: Step[] = [];

  constructor(private reg: Registry) {}

  private push(s: Step): this {
    this._steps.push(s);
    return this;
  }

  /** Pause on the current state for `seconds` (a hold that lets the UI breathe). */
  hold(seconds: number): this {
    return this.push({ kind: 'hold', ms: Math.round(seconds * 1000) });
  }

  /** Block until a selector appears (gates the start of a demo on app-ready). */
  waitFor(selector: string, opts: { timeoutMs?: number } = {}): this {
    return this.push({ kind: 'waitFor', selector, timeoutMs: opts.timeoutMs ?? 15_000 });
  }

  /** Block until an in-page predicate returns truthy. The fn runs in the page. */
  waitUntil(pageFn: () => boolean, opts: { timeoutMs?: number } = {}): this {
    return this.push({
      kind: 'waitFor',
      predicate: `(${pageFn.toString()})()`,
      timeoutMs: opts.timeoutMs ?? 15_000,
    });
  }

  /** Click a selector. `via:'cursor'` moves the synthetic cursor there first
   * (glide duration is distance-aware by default; set `glideSeconds` to pin it). */
  click(selector: string, opts: { via?: 'cursor' | 'direct'; glideSeconds?: number } = {}): this {
    return this.push({
      kind: 'click',
      selector,
      via: opts.via ?? 'cursor',
      glideMs: opts.glideSeconds != null ? Math.round(opts.glideSeconds * 1000) : 0,
    });
  }

  /** Type text into a field, one key at a time. */
  type(selector: string, text: string, opts: { delayMs?: number } = {}): this {
    return this.push({ kind: 'type', selector, text, delayMs: opts.delayMs ?? 55 });
  }

  /** Smoothly scroll a scroll container by `dy` px over `seconds`. */
  scroll(selector: string, dy: number, seconds: number, easing: Easing = 'easeInOut'): this {
    return this.push({
      kind: 'scroll',
      selector,
      dy,
      durationMs: Math.round(seconds * 1000),
      easing,
    });
  }

  /** Glide the synthetic cursor to a selector's center or a page point. */
  cursorTo(target: string | Point, seconds = 0.6, easing: Easing = 'easeInOut'): this {
    const base = { kind: 'cursorTo' as const, durationMs: Math.round(seconds * 1000), easing };
    return this.push(typeof target === 'string' ? { ...base, selector: target } : { ...base, point: target });
  }

  /** Move a named actor/prop element to a page point (in-page tween). */
  actorMove(actorId: string, point: Point, seconds: number, easing: Easing = 'easeInOut'): this {
    return this.push({
      kind: 'actorMove',
      actorId,
      point,
      durationMs: Math.round(seconds * 1000),
      easing,
    });
  }

  /** Patch a prop's in-page state (e.g. flip a mock window to "minimized"). */
  prop(propId: string, patch: Record<string, unknown>): this {
    return this.push({ kind: 'propSet', propId, patch });
  }

  /** Drive the app's own engine through its window.__demo bridge. */
  bridgeSet(key: string, value: unknown): this {
    return this.push({ kind: 'bridgeSet', key, value });
  }

  bridgeTrigger(action: string, ...args: unknown[]): this {
    return this.push({ kind: 'bridgeTrigger', action, args });
  }

  /** Change the app pace multiplier mid-scene (window.__demo.pace / __DEMO_PACE__). */
  pace(multiplier: number): this {
    return this.push({ kind: 'pace', multiplier });
  }

  /** Run an arbitrary author callback against the Puppeteer Page. */
  call(fn: PageCallback): this {
    const label = `call#${this.reg.callSeq++}`;
    this.reg.calls[label] = fn;
    return this.push({ kind: 'call', label });
  }

  /** Mark a named moment (for introspection and snapshot targeting). */
  cue(name: string): this {
    this.reg.cues.push(name);
    return this.push({ kind: 'cue', name });
  }

  /**
   * Mark the neutral state the scene returns to. Enables the artifact-free
   * anchor loop: gifsmith trims to the best hold-to-hold seam near this beat.
   */
  loopAnchor(): this {
    this.reg.hasLoopAnchor = true;
    return this.push({ kind: 'loopAnchor' });
  }

  /** Run several branches concurrently; the beat ends when the slowest does. */
  parallel(...branches: Array<(t: TimelineBuilder) => void>): this {
    const compiled = branches.map((fn) => {
      const child = new TimelineBuilder(this.reg);
      fn(child);
      return child._steps;
    });
    return this.push({ kind: 'parallel', branches: compiled });
  }

  /** Group steps as an explicit sub-sequence (useful inside a parallel branch). */
  sequence(fn: (t: TimelineBuilder) => void): this {
    const child = new TimelineBuilder(this.reg);
    fn(child);
    return this.push({ kind: 'sequence', steps: child._steps });
  }
}

export function timeline(build: (t: TimelineBuilder) => void): CompiledTimeline {
  const reg: Registry = { cues: [], calls: {}, hasLoopAnchor: false, callSeq: 0 };
  const root = new TimelineBuilder(reg);
  build(root);
  return {
    steps: root._steps,
    calls: reg.calls,
    cues: reg.cues,
    hasLoopAnchor: reg.hasLoopAnchor,
  };
}

/**
 * Estimate the planned wall-clock length of a compiled timeline (holds +
 * timed motions; discrete actions count as ~0). Used by dryRun and to size
 * capture safety timeouts. `parallel` takes the max of its branches.
 */
export function estimateSeconds(steps: Step[]): number {
  let total = 0;
  for (const s of steps) {
    switch (s.kind) {
      case 'hold':
        total += s.ms / 1000;
        break;
      case 'scroll':
      case 'cursorTo':
      case 'actorMove':
        total += s.durationMs / 1000;
        break;
      case 'type':
        total += (s.text.length * s.delayMs) / 1000;
        break;
      case 'parallel':
        total += Math.max(0, ...s.branches.map((b) => estimateSeconds(b)));
        break;
      case 'sequence':
        total += estimateSeconds(s.steps);
        break;
      default:
        break;
    }
  }
  return total;
}
