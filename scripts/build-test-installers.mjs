// Builds two installers for the install/upgrade test (tests/install), from the current build in out/:
// version A (the package version) and version B (one patch higher), under their own application id,
// name and output folder, so installing them can never replace or uninstall a real installation of
// Hardware Shop Manager on this computer.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const next = version.replace(/(\d+)$/, (n) => String(Number(n) + 1));
const builder = join(root, 'node_modules', 'electron-builder', 'cli.js');

rmSync(join(root, 'installer-test'), { recursive: true, force: true });
for (const [label, v] of [['a', version], ['b', next]]) {
  execFileSync(
    process.execPath,
    [
      builder,
      '--win',
      'nsis',
      '--publish',
      'never',
      '-c.appId=com.hardwareshop.manager.installtest',
      '-c.productName=HSM Install Test',
      '-c.nsis.shortcutName=HSM Install Test',
      `-c.directories.output=installer-test/${label}`,
      `-c.extraMetadata.version=${v}`,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  execFileSync(process.execPath, [join(root, 'scripts', 'check-package.mjs'), join(root, 'installer-test', label, 'win-unpacked')], { stdio: 'inherit' });
}
console.log(`Built test installers ${version} and ${next} in installer-test/`);
