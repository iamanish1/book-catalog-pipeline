import { openRepository } from '../db/index.js';
import type { CatalogRepository } from '../db/repository.js';
import { log } from '../lib/logger.js';
import type { Runtime } from '../providers/registry.js';
import { createRuntime } from '../providers/registry.js';

export interface CliArgs {
  flags: Record<string, string | boolean>;
  num(name: string): number | undefined;
  list(name: string): string[] | undefined;
  bool(name: string): boolean;
  str(name: string): string | undefined;
}

/** Minimal `--key value` / `--key=value` / `--flag` parser. */
export function parseArgs(argv = process.argv.slice(2)): CliArgs {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) flags[k] = argv[++i]!;
    else flags[k] = true;
  }
  return {
    flags,
    num: (n) => {
      const v = flags[n];
      if (v === undefined || v === true) return undefined;
      const x = Number(v);
      if (!Number.isFinite(x)) throw new Error(`--${n} must be a number`);
      return x;
    },
    list: (n) => (typeof flags[n] === 'string' ? String(flags[n]).split(',').map((s) => s.trim()).filter(Boolean) : undefined),
    bool: (n) => flags[n] === true || flags[n] === 'true',
    str: (n) => (typeof flags[n] === 'string' ? String(flags[n]) : undefined),
  };
}

export function withRepo(rt: Runtime): CatalogRepository {
  return openRepository(rt.env, rt.config, rt.providers);
}

export async function main(fn: (rt: Runtime, args: CliArgs) => Promise<unknown>): Promise<void> {
  try {
    const rt = createRuntime();
    const out = await fn(rt, parseArgs());
    if (out !== undefined) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } catch (e) {
    log.error('command failed', { error: e instanceof Error ? e.message : String(e) });
    process.exitCode = 1;
  }
}
