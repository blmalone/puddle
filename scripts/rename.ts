import { execFileSync } from 'node:child_process';
import { readFile, writeFile, access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { brand } from './brand.ts';

const root = new URL('../', import.meta.url);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { github: { type: 'boolean' }, definition: { type: 'string' } },
});
const [name] = positionals;
if (positionals.length !== 1 || !name || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || name.length > 100) {
  throw new Error('Usage: npm run rename -- new-name [--definition "Meaning of the name."] [--github]');
}
const next = {
  name,
  definition: values.definition ?? (name === brand.name ? brand.definition : ''),
  githubOwner: brand.githubOwner,
};
const repository = `https://github.com/${next.githubOwner}/${name}`;
const changes = new Map<string, string>();
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
changes.set('brand.json', json(next));

// Package managers and GitHub need literal names, so update their files together.
for (const prefix of ['', 'docs/']) {
  for (const file of ['package.json', 'package-lock.json']) {
    const path = `${prefix}${file}`;
    let source: string;
    try { source = await readFile(new URL(path, root), 'utf8'); }
    catch (error) {
      if (prefix && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const pkg = JSON.parse(source);
    pkg.name = `${name}${prefix ? '-docs' : ''}`;
    if (file === 'package-lock.json') pkg.packages[''].name = pkg.name;
    else if (!prefix) pkg.repository = { type: 'git', url: `${repository}.git` };
    changes.set(path, json(pkg));
  }
}

let readme = await readFile(new URL('README.md', root), 'utf8');
const escaped = brand.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
readme = readme.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), word =>
  word[0] === word[0].toUpperCase() ? name.charAt(0).toUpperCase() + name.slice(1) : name);
const heading = `<!-- brand:start -->\n# ${name}${next.definition ? `\n\n${next.definition}` : ''}\n<!-- brand:end -->`;
const block = /<!-- brand:start -->[\s\S]*?<!-- brand:end -->/;
if (!block.test(readme) && !/^# [^\n]+/.test(readme)) throw new Error('README must start with a title.');
readme = block.test(readme) ? readme.replace(block, () => heading) : readme.replace(/^# [^\n]+/, () => heading);
changes.set('README.md', readme);

// Validate every local destination before changing the remote repository.
for (const path of changes.keys()) await access(new URL(path, root), 2);
function run(command: string, args: string[]) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
}
if (values.github) {
  const origin = run('git', ['remote', 'get-url', 'origin']).replace(/\.git$/, '');
  const remote = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+)$/.exec(origin);
  if (!remote || remote[1] !== brand.githubOwner) {
    throw new Error('origin does not match brand.json; no files or repository were changed.');
  }
  if (remote[2] !== name) run('gh', ['repo', 'rename', name, '--repo', `${remote[1]}/${remote[2]}`, '--yes']);
  run('git', ['remote', 'set-url', 'origin', origin.startsWith('git@')
    ? `git@github.com:${next.githubOwner}/${name}.git` : `${repository}.git`]);
}
for (const [path, content] of changes) await writeFile(new URL(path, root), content);
console.log(`Renamed to ${name}${values.github ? ' (including GitHub)' : ' locally'}. Rebuild or restart the app and docs.`);
