import { execFileSync } from 'node:child_process';
import { brand } from './brand.ts';

const root = new URL('../', import.meta.url);
export const escapeHTML = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function renderBrand(template: string) {
  return template.replace(/\{\{brand\.(name|displayName|repository)\}\}/g,
    (_, key: 'name' | 'displayName' | 'repository') => escapeHTML(brand[key]));
}

function git(...args: string[]): string | undefined {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}

// Capture the source revision during the build, including source archives without Git.
export function revisionBadge(className = '') {
  const commit = process.env.BUILD_COMMIT ?? git('rev-parse', '--verify', 'HEAD');
  if (commit !== undefined && !/^[a-f0-9]{40}$/i.test(commit)) throw new Error('BUILD_COMMIT must be a full Git commit hash.');
  const status = git('status', '--porcelain', '--untracked-files=normal');
  const modified = status === undefined ? !process.env.BUILD_COMMIT : status.length > 0;
  const label = commit ? `${commit.slice(0, 7)}${modified ? ' · dev' : ''}` : 'dev';
  const title = commit ? `Source commit ${commit}${modified ? ' — includes local changes' : ''}` : 'Development build — source revision unavailable';
  const attributes = `class="${escapeHTML(className)}" title="${escapeHTML(title)}"`;
  return commit
    ? `<a ${attributes} href="${escapeHTML(brand.repository)}/commit/${commit}" target="_blank" rel="noreferrer">${label}</a>`
    : `<span ${attributes}>${label}</span>`;
}
