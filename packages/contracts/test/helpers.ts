import { readFileSync } from 'node:fs';

export function fixture<T>(name: string): T {
  const url = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}
