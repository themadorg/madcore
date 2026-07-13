/**
 * lib/logger.ts — Single logging entry point for madcore
 *
 * All SDK diagnostics go through `log.*`. By default that prefixes a timestamp
 * and forwards to `console`. Host apps can inject a custom writer and log level
 * via `DeltaChatSDK({ logLevel, logger })` or `configureLogger(...)`.
 *
 * @example
 * ```ts
 * import { log, configureLogger } from 'madcore';
 *
 * configureLogger({
 *   logLevel: 'debug',
 *   logger: (method, ...args) => mySink.write(method, args),
 * });
 *
 * log.info('transport', 'connected', { url });
 * log.log('plain message', { any: 'console.log-compatible' });
 * log.table([{ a: 1 }]);
 * ```
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

/** Console method names we forward (same surface as `console` for common APIs). */
export type LogMethod =
    | 'debug'
    | 'info'
    | 'log'
    | 'warn'
    | 'error'
    | 'trace'
    | 'table'
    | 'dir'
    | 'dirxml'
    | 'group'
    | 'groupCollapsed'
    | 'groupEnd'
    | 'time'
    | 'timeEnd'
    | 'timeLog'
    | 'count'
    | 'countReset'
    | 'assert'
    | 'clear';

/**
 * Custom log writer. Receives a console-compatible method name plus the same
 * arguments you would pass to `console[method](...)`.
 *
 * The default writer prefixes a timestamp onto the first string argument
 * (when timestamps are enabled) then calls `console[method]`.
 */
export type LoggerFn = (method: LogMethod, ...args: unknown[]) => void;

export interface LoggerConfig {
    /** Minimum level to emit (default: `'info'`). */
    logLevel?: LogLevel;
    /**
     * Custom sink. If omitted / `null`, logs go to `console`.
     * Signature matches console methods for easy bridging.
     */
    logger?: LoggerFn | null;
    /**
     * When true (default), every emit is prefixed with a wall-clock timestamp.
     * Set false if your custom `logger` already timestamps.
     */
    timestamps?: boolean;
    /**
     * When true, use ISO-8601 timestamps (`2026-07-13T12:34:56.789Z`).
     * Default false → local `HH:mm:ss.mmm`.
     */
    isoTimestamps?: boolean;
}

const LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    none: 4,
};

/** Map console-ish methods onto a filter level. */
const METHOD_LEVEL: Record<LogMethod, LogLevel> = {
    debug: 'debug',
    trace: 'debug',
    info: 'info',
    log: 'info',
    table: 'info',
    dir: 'info',
    dirxml: 'info',
    count: 'info',
    countReset: 'info',
    time: 'info',
    timeEnd: 'info',
    timeLog: 'info',
    group: 'info',
    groupCollapsed: 'info',
    groupEnd: 'info',
    clear: 'info',
    warn: 'warn',
    assert: 'warn',
    error: 'error',
};

const LEVEL_EMOJI: Record<Exclude<LogLevel, 'none'>, string> = {
    debug: '🔍',
    info: 'ℹ️ ',
    warn: '⚠️ ',
    error: '❌',
};

let currentLevel: LogLevel = 'info';
let useTimestamps = true;
let useIsoTimestamps = false;
let customLogger: LoggerFn | null = null;

/** Optional sinks for bridging logs → DC_EVENT_INFO/WARNING/ERROR (browser-safe). */
export type LogSink = (
    level: Exclude<LogLevel, 'none' | 'debug'>,
    tag: string,
    msg: string,
    args: unknown[],
) => void;
const sinks = new Set<LogSink>();

export function addLogSink(sink: LogSink): () => void {
    sinks.add(sink);
    return () => {
        sinks.delete(sink);
    };
}

export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
}

export function getLogLevel(): LogLevel {
    return currentLevel;
}

/** Install a custom console-compatible writer (or `null` to restore console). */
export function setLogger(fn: LoggerFn | null): void {
    customLogger = fn;
}

export function getLogger(): LoggerFn | null {
    return customLogger;
}

/**
 * Apply logger options in one call (used by `DeltaChatSDK` / `createJsonRpcCompat`).
 * Omitted fields keep their previous values.
 */
export function configureLogger(config: LoggerConfig = {}): void {
    if (config.logLevel !== undefined) currentLevel = config.logLevel;
    if (config.logger !== undefined) customLogger = config.logger;
    if (config.timestamps !== undefined) useTimestamps = config.timestamps;
    if (config.isoTimestamps !== undefined) useIsoTimestamps = config.isoTimestamps;
}

function shouldEmit(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[currentLevel] && currentLevel !== 'none';
}

function formatTimestamp(): string {
    if (useIsoTimestamps) {
        return new Date().toISOString();
    }
    const d = new Date();
    const p = (n: number, w = 2) => n.toString().padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function emitSink(
    level: Exclude<LogLevel, 'none' | 'debug'>,
    tag: string,
    msg: string,
    args: unknown[],
): void {
    for (const sink of sinks) {
        try {
            sink(level, tag, msg, args);
        } catch {
            /* never break logging */
        }
    }
}

/** Methods where the first argument must stay intact (not string-merged with a stamp). */
const PRESERVE_FIRST_ARG: ReadonlySet<LogMethod> = new Set([
    'table',
    'dir',
    'dirxml',
    'groupEnd',
    'clear',
    'time',
    'timeEnd',
    'timeLog',
    'count',
    'countReset',
    'assert',
]);

/**
 * Core writer used by every public log API.
 * Always timestamps (when enabled) then calls the configured logger / console.
 */
export function writeLog(method: LogMethod, ...args: unknown[]): void {
    const level = METHOD_LEVEL[method] ?? 'info';
    if (!shouldEmit(level)) return;

    const stamp = useTimestamps ? `[${formatTimestamp()}]` : null;
    let out = args;

    if (stamp) {
        if (PRESERVE_FIRST_ARG.has(method)) {
            // Keep structured args intact; stamp is a leading label only when useful
            if (method === 'assert') {
                // console.assert(condition, ...msgs) — leave condition at [0]
                if (args.length >= 2 && typeof args[1] === 'string') {
                    out = [args[0], `${stamp} ${args[1]}`, ...args.slice(2)];
                } else {
                    out = args;
                }
            } else if (
                method === 'time' ||
                method === 'timeEnd' ||
                method === 'timeLog' ||
                method === 'count' ||
                method === 'countReset'
            ) {
                out = args; // labels must match exactly
            } else if (method === 'table' || method === 'dir' || method === 'dirxml') {
                // Log stamp on its own line, then the structured call
                emitRaw('log', stamp);
                out = args;
            } else {
                out = args;
            }
        } else if (args.length === 0) {
            out = [stamp];
        } else if (typeof args[0] === 'string') {
            out = [`${stamp} ${args[0]}`, ...args.slice(1)];
        } else {
            out = [stamp, ...args];
        }
    }

    emitRaw(method, ...out);
}

function emitRaw(method: LogMethod, ...out: unknown[]): void {
    if (customLogger) {
        try {
            customLogger(method, ...out);
            return;
        } catch {
            /* fall through to console */
        }
    }

    const cons = typeof console !== 'undefined' ? console : null;
    if (!cons) return;
    const fn = (cons as any)[method];
    if (typeof fn === 'function') {
        fn.apply(cons, out);
    } else {
        cons.log(...out);
    }
}

function tagged(
    level: Exclude<LogLevel, 'none'>,
    method: LogMethod,
    tag: string,
    msg: string,
    args: unknown[],
): void {
    if (!shouldEmit(level)) return;
    const emoji = LEVEL_EMOJI[level] || '';
    const prefix = `${emoji}[${tag}] ${msg}`;
    writeLog(method, prefix, ...args);
    if (level !== 'debug') {
        emitSink(level, tag, msg, args);
    }
}

/**
 * Primary logger API used throughout madcore.
 *
 * Tagged methods (`debug/info/warn/error`) keep the historical
 * `(tag, message, ...args)` signature. Console-compatible methods
 * (`log`, `table`, `group`, …) accept the same arguments as `console`.
 */
export const log = {
    // ── Tagged levels (madcore convention) ──────────────────────────────
    debug(tag: string, msg: string, ...args: unknown[]) {
        tagged('debug', 'debug', tag, msg, args);
    },
    info(tag: string, msg: string, ...args: unknown[]) {
        tagged('info', 'info', tag, msg, args);
    },
    warn(tag: string, msg: string, ...args: unknown[]) {
        tagged('warn', 'warn', tag, msg, args);
    },
    error(tag: string, msg: string, ...args: unknown[]) {
        tagged('error', 'error', tag, msg, args);
    },

    // ── Console-compatible surface ──────────────────────────────────────
    /** Like `console.log` — timestamped, level-filtered as `info`. */
    log(...args: unknown[]) {
        writeLog('log', ...args);
    },
    trace(...args: unknown[]) {
        writeLog('trace', ...args);
    },
    table(...args: unknown[]) {
        writeLog('table', ...args);
    },
    dir(...args: unknown[]) {
        writeLog('dir', ...args);
    },
    dirxml(...args: unknown[]) {
        writeLog('dirxml', ...args);
    },
    group(...args: unknown[]) {
        writeLog('group', ...args);
    },
    groupCollapsed(...args: unknown[]) {
        writeLog('groupCollapsed', ...args);
    },
    groupEnd(...args: unknown[]) {
        writeLog('groupEnd', ...args);
    },
    time(label?: string) {
        writeLog('time', label);
    },
    timeEnd(label?: string) {
        writeLog('timeEnd', label);
    },
    timeLog(label?: string, ...args: unknown[]) {
        writeLog('timeLog', label, ...args);
    },
    count(label?: string) {
        writeLog('count', label);
    },
    countReset(label?: string) {
        writeLog('countReset', label);
    },
    assert(condition?: boolean, ...args: unknown[]) {
        // Mirror console.assert: only emit when condition is falsy
        if (!condition) writeLog('assert', condition, ...args);
    },
    clear() {
        writeLog('clear');
    },
};

export type MadcoreLogger = typeof log;
