import { cpSync } from 'node:fs';
cpSync(new URL('../src/web/', import.meta.url), new URL('../dist/web/', import.meta.url), {
  recursive: true,
});
