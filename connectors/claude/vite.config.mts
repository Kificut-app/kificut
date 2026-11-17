import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const here = import.meta.dirname
const root = resolve(here, '../..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }

// Bundles the connector and every dependency into one file that Claude Desktop runs with Node.
export default defineConfig({
  root: here,
  logLevel: 'warn',
  resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: resolve(here, 'src/server.ts'),
    outDir: resolve(here, 'build/server'),
    emptyOutDir: true,
    target: 'node18',
    minify: false,
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } }
  }
})
