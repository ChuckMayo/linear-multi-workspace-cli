import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/commands/**/*.ts', 'src/lib/**/*.ts'],
  outDir: 'dist',
  format: 'esm',
  target: 'node22',
  unbundle: true,
  root: 'src',
  outExtensions: () => ({ js: '.js' }),
  clean: true,
  dts: false,
  sourcemap: false,
  alias: { '@': './src' },
})
