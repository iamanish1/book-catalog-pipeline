import fs from 'node:fs';
import path from 'node:path';

export function writeJsonl(file: string, rows: Iterable<unknown>): number {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  let n = 0;
  try {
    for (const r of rows) {
      fs.writeSync(fd, JSON.stringify(r) + '\n');
      n++;
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return n;
}

export function appendJsonl(file: string, row: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

export function* readJsonl<T>(file: string): Generator<T> {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (line.trim()) yield JSON.parse(line) as T;
  }
}

export function requireFile(file: string, hint: string): void {
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. ${hint}`);
}
