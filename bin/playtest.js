#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { enableCompileCache, registerHooks, stripTypeScriptTypes } from 'node:module';

enableCompileCache?.();
// Node will not strip types under node_modules, which is where a copied install (tarball, git, registry) puts us.
if (import.meta.url.includes('/node_modules/')) {
  const root = new URL('../', import.meta.url).href;
  const strip = (code) => {
    const emitWarning = process.emitWarning;
    process.emitWarning = () => {};
    try {
      return stripTypeScriptTypes(code);
    } finally {
      process.emitWarning = emitWarning;
    }
  };
  registerHooks({
    load(url, context, next) {
      if (!url.startsWith(root) || !url.endsWith('.ts')) return next(url, context);
      return { format: 'module', source: strip(readFileSync(new URL(url), 'utf8')), shortCircuit: true };
    },
  });
}
const { main } = await import('../src/cli.ts');

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(process.env.PLAYTEST_DEBUG ? error : `pt: ${error.message}`);
  process.exitCode = 2;
}
