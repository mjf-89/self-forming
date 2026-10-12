import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

/** Collect notices for all npm packages read by the bundler, including tree-shaken inputs. */
export async function writeNotices(root, inputs, output) {
  const packages = new Map();
  for (const input of inputs.filter(path => path.includes('node_modules/'))) {
    let directory = dirname(resolve(root, input));
    while (directory !== root && dirname(directory) !== directory) {
      let pkg;
      try { pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (pkg?.name && pkg?.version) {
        packages.set(`${pkg.name}@${pkg.version}`, { directory, pkg });
        break;
      }
      directory = dirname(directory);
    }
  }
  const sections = ['# Third-party notices',
    'These packages contributed build inputs. Some input code is removed by tree shaking. Preserve the legal-comment files alongside their generated JavaScript modules.'];
  for (const [name, { directory, pkg }] of [...packages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const files = (await readdir(directory)).filter(file => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(file)).sort();
    let notices = await Promise.all(files.map(async file => `### ${file}\n\n${await readFile(resolve(directory, file), 'utf8')}`));
    // Earendil's published 1.0.4 packages omit the monorepo's root license file.
    if (!notices.length && pkg.name.startsWith('@earendil-works/')) {
      if (pkg.version !== '1.0.4') throw new Error(`Review the upstream license snapshot before shipping ${name}`);
      notices = [await readFile(resolve(root, 'third-party/earendil-works.LICENSE'), 'utf8')];
    }
    // The 1.1.1 npm tarball includes dist only; its MIT license lives at libraries/LICENSE upstream.
    if (!notices.length && pkg.name === 'standardwebhooks') {
      if (pkg.version !== '1.1.1' || pkg.license !== 'MIT') throw new Error(`Review the upstream license snapshot before shipping ${name}`);
      notices = [await readFile(resolve(root, 'third-party/standardwebhooks.LICENSE'), 'utf8')];
    }
    if (!notices.length) throw new Error(`No license text found for bundled input ${name}`);
    sections.push(`## ${name}\n\nDeclared license: ${pkg.license ?? 'see notice below'}\n\n${notices.join('\n\n')}`);
  }
  await writeFile(output, sections.join('\n\n') + '\n');
}
