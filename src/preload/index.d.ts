import type { KificutApi } from '../shared/ipc'

declare global {
  interface Window {
    kificut: KificutApi
  }
}

export {}
