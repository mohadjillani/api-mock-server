import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // The shebang lives in `src/cli.ts` rather than in a banner here, so it
  // survives the build for both entries without being prepended to the library
  // as well — and so `tsx src/cli.ts` behaves identically to the built binary.
  target: 'node20',
  sourcemap: true,
});
