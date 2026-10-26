import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(__dirname, '../..');

/**
 * Bundles a TypeScript script (with the @main/@shared aliases and the bundled migrations) into a
 * single CommonJS file that a separate Node process can run. better-sqlite3 stays external so the
 * child loads the same native module as the tests.
 */
export async function bundleForNode(entry: string): Promise<string> {
  // Inside the project, so the child resolves better-sqlite3 from node_modules.
  const cache = join(root, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  const outDir = mkdtempSync(join(cache, 'hws-bundle-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    root,
    resolve: { alias: { '@shared': join(root, 'src/shared'), '@main': join(root, 'src/main') } },
    ssr: { noExternal: true, external: ['better-sqlite3'] },
    build: {
      ssr: resolve(root, entry),
      outDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { external: ['better-sqlite3', 'electron'], output: { format: 'cjs', entryFileNames: 'child.cjs' } },
    },
  });
  return join(outDir, 'child.cjs');
}
