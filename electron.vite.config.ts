import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': shared,
        sharp: resolve(__dirname, 'src/main/sharp-stub.ts')
      }
    },
    build: {
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // The utility process for custom voices (transformers.js 4 with onnxruntime-node).
          'voice-worker': resolve(__dirname, 'src/main/voice-worker.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        // The GPL eSpeak phonemizer is downloaded with the Kokoro model, not bundled.
        phonemizer: resolve(__dirname, 'src/renderer/src/local-ai/phonemizer.ts'),
        // ONNX Runtime's WebAssembly files, served locally instead of from a CDN.
        'ort-dist': resolve(__dirname, 'node_modules/onnxruntime-web/dist')
      }
    },
    plugins: [react()],
    worker: { format: 'es' }
  }
})
