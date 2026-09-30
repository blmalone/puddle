import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { brand } from './brand.ts';

const root = new URL('../', import.meta.url);
function git(...args: string[]): string | undefined {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}

// Capture the source revision once during the build, never from the live branch.
const commit = process.env.BUILD_COMMIT ?? git('rev-parse', '--verify', 'HEAD');
if (commit !== undefined && !/^[a-f0-9]{40}$/i.test(commit)) {
  throw new Error('BUILD_COMMIT must be a full Git commit hash.');
}
const status = git('status', '--porcelain', '--untracked-files=normal');
const modified = status === undefined ? !process.env.BUILD_COMMIT : status.length > 0;
const label = commit ? `${commit.slice(0, 7)}${modified ? ' · dev' : ''}` : 'dev';
const title = commit ? `Frontend commit ${commit}${modified ? ' — includes local changes' : ''}` : 'Development build — source revision unavailable';
const badge = commit
  ? `<a class="build-version" href="${brand.repository}/commit/${commit}" target="_blank" rel="noreferrer" title="${title}" aria-label="${title}">${label}</a>`
  : `<span class="build-version" title="${title}">${label}</span>`;

const template = await readFile(new URL('app/index.html', root), 'utf8');
const escapeHTML = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const html = template.replace(/\{\{brand\.(name|displayName|repository)\}\}/g,
  (_, key: 'name' | 'displayName' | 'repository') => escapeHTML(brand[key]));
await writeFile(new URL('.cache/ui/index.html', root), html.replace('<!-- build-version -->', badge));
