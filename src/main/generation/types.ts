import type { GenerationRequest, ModelCapabilities } from '@shared/generation'

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export interface RunContext {
  fetch: Fetch
  signal: AbortSignal
  apiKey: string | null
  /** Reports what is happening, with progress from 0 to 1 when the service gives it. */
  progress: (message: string, fraction?: number | null) => void
  /** ComfyUI's address and the workflow files to use. */
  comfyui?: { url: string; videoWorkflow: string; imageWorkflow: string }
}

/** The finished clip or picture, as bytes or as a URL to download. */
export interface GeneratedFile {
  data?: Uint8Array
  url?: string
  headers?: Record<string, string>
  extension: string
}

export interface Adapter {
  capabilities(model: string, ctx: RunContext): Promise<ModelCapabilities>
  /** A short note on the expected cost, such as "about $0.70". */
  estimate(request: GenerationRequest, ctx: RunContext): Promise<string>
  run(request: GenerationRequest, ctx: RunContext): Promise<GeneratedFile>
}

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status = 0
  ) {
    super(message)
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

/** The error message a JSON API returned, or a plain description of the status. */
export async function failure(response: Response, service: string): Promise<ServiceError> {
  let detail = ''
  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string
      detail?: unknown
      message?: string
    }
    if (typeof body.error === 'string') detail = body.error
    else if (body.error?.message) detail = body.error.message
    else if (body.message) detail = body.message
    else if (typeof body.detail === 'string') detail = body.detail
    else if (body.detail) detail = JSON.stringify(body.detail)
  } catch {
    // Not JSON.
  }
  const status = response.status
  if (status === 401 || status === 403) {
    return new ServiceError(`${service} did not accept the API key.${detail ? ` (${detail})` : ''}`, status)
  }
  if (status === 402) {
    return new ServiceError(`${service} says the account needs credit or billing set up.`, status)
  }
  if (status === 429)
    return new ServiceError(detail || `${service} is rate limiting this key. Try again soon.`, status)
  return new ServiceError(detail || `${service} returned HTTP ${status}.`, status)
}

export function money(amount: number): string {
  if (amount >= 0.1) return `$${amount.toFixed(2)}`
  return `$${Number(amount.toFixed(3))}`
}
