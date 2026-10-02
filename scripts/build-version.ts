import { readFile, writeFile } from 'node:fs/promises';
import { renderBrand, revisionBadge } from './html.ts';

const root = new URL('../', import.meta.url);
const template = await readFile(new URL('app/index.html', root), 'utf8');
await writeFile(new URL('.cache/ui/index.html', root),
  renderBrand(template).replace('<!-- build-version -->', revisionBadge('build-version')));
