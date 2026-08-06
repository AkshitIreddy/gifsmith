/**
 * The three failures a user can be told about in one line, and everything else.
 *
 * This file exists because "print a stack for a typo" was fixed twice and came
 * back twice, from a layer the previous fix did not cover. Round one: the flag
 * layer threw a bare `Error`, so `--fps` with no value printed
 * `gifsmith: Error: gifsmith: --fps needs a value` and four frames through
 * node's internals. That was fixed by `UsageError`, in `flags.ts`, for flags.
 * Round two: `--capture Deterministic` did exactly the same thing, because the
 * value of `--capture` is validated in the DIRECTOR — `captureOptions()` threw a
 * plain `Error`, which the CLI could not tell apart from a real crash. A capital
 * D printed four lines, said `gifsmith:` twice, and exited 1.
 *
 * Round three was the same lesson again from the LOAD path rather than the value
 * path: `cli.ts` guarded one way a config module can fail to load (no such file)
 * and left the rest to node, so a syntax error in a config printed five frames
 * of node's ESM internals and never named the file — while `mcp/server.ts`, a
 * second hand-written copy of the same twelve lines, guarded nothing at all. See
 * `loadConfig.ts`, which both bins now call.
 *
 * The lesson of every round is that the fix cannot live at a call site. So the
 * shape of a failure is declared by its TYPE, once, here, and every layer that
 * can reject something a user typed uses one of these:
 *
 *   UsageError        the command line is wrong          → one line, exit 2
 *   ConfigError       a value in the config cannot be honoured → one line, exit 2
 *   EnvironmentError  something is missing on the machine → one line, exit 1
 *   anything else     gifsmith's own bug                 → stack, exit 1
 *
 * All three extend `Error`, so a programmatic caller catches them exactly as
 * before and reads the same message — the library API does not change. What
 * changes is that the CLI can now ask "is this the user's mistake or mine?" and
 * get a reliable answer, instead of guessing from a message string.
 *
 * Messages carry NO program prefix for a UsageError (the CLI owns it) and DO
 * carry `gifsmith: ` for the library errors (they are read by programmatic
 * callers and by `dryRun`, where nothing else says who is speaking). The CLI
 * prints exactly one prefix either way — see `cli.ts`.
 */

/** A mistake in the command line: an unknown value, a missing argument, a flag given a value it does not take. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * A value in the RenderConfig that gifsmith cannot honour — a mode it does not
 * recognise, a number it cannot use, a combination that cannot work.
 *
 * Thrown by `render()` (via `assertConfig`) before a browser is launched, and by
 * the individual validators for programmatic callers. `dryRun()` reports the
 * same problems as strings instead of throwing, which is what a dry run is for.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Something the machine is missing: ffmpeg, a Chromium-based browser. Not the user's typo, and not a bug. */
export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

/**
 * `instanceof` OR `name`, deliberately.
 *
 * A CLI is not always running the same copy of a module as the code that threw
 * — a linked checkout, a duplicated install, a bundler that inlined one path and
 * left the other external — and when it is not, `instanceof` silently says no
 * and the user gets a stack trace for a typo. That is the exact failure this
 * file is here to prevent, so the check does not depend on identity alone.
 */
function named(e: unknown, ctor: Function, name: string): boolean {
  return e instanceof ctor || (e instanceof Error && e.name === name);
}

export const isUsageError = (e: unknown): e is UsageError => named(e, UsageError, 'UsageError');
export const isConfigError = (e: unknown): e is ConfigError => named(e, ConfigError, 'ConfigError');
export const isEnvironmentError = (e: unknown): e is EnvironmentError =>
  named(e, EnvironmentError, 'EnvironmentError');

/** Anything the user can fix themselves — printed as one line, never as a stack. */
export const isUserFacing = (e: unknown): e is Error =>
  isUsageError(e) || isConfigError(e) || isEnvironmentError(e);
