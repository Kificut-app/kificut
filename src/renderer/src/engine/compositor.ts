import type { ColorAdjust } from '@shared/types'
import type { Point } from '@shared/geometry'

const VERTEX = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform vec2 u_resolution;
out vec2 v_uv;
void main() {
  vec2 clip = a_pos / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_uv;
}`

// Mirrors FFmpeg's eq filter: contrast, brightness and gamma act on luma, saturation scales chroma.
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_opacity;
uniform vec4 u_eq;
uniform bool u_solid;
uniform vec3 u_color;
out vec4 outColor;
void main() {
  vec4 c = u_solid ? vec4(u_color, 1.0) : texture(u_texture, v_uv);
  vec3 rgb = c.rgb;
  float y = dot(rgb, vec3(0.299, 0.587, 0.114));
  float y2 = u_eq.y * (y - 0.5) + 0.5 + u_eq.x;
  y2 = y2 <= 0.0 ? 0.0 : min(pow(y2, 1.0 / u_eq.w), 1.0);
  rgb = vec3(y2) + (rgb - vec3(y)) * u_eq.z;
  outColor = vec4(clamp(rgb, 0.0, 1.0), c.a * u_opacity);
}`

export interface DrawLayer {
  /** Texture cache key, usually the clip id. */
  key: string
  source: TexImageSource | null
  /** Upload the source to the texture before drawing. */
  upload: boolean
  solid?: [number, number, number]
  corners: Point[]
  uv: [number, number, number, number]
  color: ColorAdjust
  opacity: number
}

/** What the player needs from a preview renderer. */
export interface LayerRenderer {
  readonly backend: 'webgl' | 'canvas'
  resize(pixelWidth: number, pixelHeight: number, projectWidth: number, projectHeight: number): void
  begin(background: string): void
  draw(layer: DrawLayer): void
  hasTexture(key: string): boolean
  end(): void
  destroy(): void
}

interface TextureEntry {
  texture: WebGLTexture
  ready: boolean
  used: boolean
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean
  const n = parseInt(full.slice(0, 6), 16) || 0
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export class Compositor implements LayerRenderer {
  readonly backend = 'webgl'
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private buffer: WebGLBuffer
  private textures = new Map<string, TextureEntry>()
  private uniforms: Record<string, WebGLUniformLocation | null> = {}
  private width = 0
  private height = 0
  private data = new Float32Array(24)

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    })
    if (!gl) throw new Error('WebGL 2 is not available on this system.')
    this.gl = gl
    this.program = this.createProgram()
    this.buffer = gl.createBuffer()!

    gl.useProgram(this.program)
    for (const name of ['u_resolution', 'u_texture', 'u_opacity', 'u_eq', 'u_solid', 'u_color']) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name)
    }
    const stride = 4 * 4
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    const pos = gl.getAttribLocation(this.program, 'a_pos')
    const uv = gl.getAttribLocation(this.program, 'a_uv')
    gl.enableVertexAttribArray(pos)
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, stride, 0)
    gl.enableVertexAttribArray(uv)
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, stride, 8)
    gl.uniform1i(this.uniforms.u_texture, 0)

    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  }

  private compile(type: number, source: string): WebGLShader {
    const gl = this.gl
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compile failed')
    }
    return shader
  }

  private createProgram(): WebGLProgram {
    const gl = this.gl
    const program = gl.createProgram()!
    gl.attachShader(program, this.compile(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, this.compile(gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'Program link failed')
    }
    return program
  }

  /** Sets the output size. Layer coordinates are always given in project pixels. */
  resize(pixelWidth: number, pixelHeight: number, projectWidth: number, projectHeight: number): void {
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth
      this.canvas.height = pixelHeight
    }
    this.width = projectWidth
    this.height = projectHeight
  }

  begin(background: string): void {
    const gl = this.gl
    const [r, g, b] = hexToRgb(background)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(r, g, b, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program)
    gl.uniform2f(this.uniforms.u_resolution, this.width, this.height)
    for (const entry of this.textures.values()) entry.used = false
  }

  private texture(key: string): TextureEntry {
    const gl = this.gl
    let entry = this.textures.get(key)
    if (!entry) {
      const texture = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      entry = { texture, ready: false, used: false }
      this.textures.set(key, entry)
    }
    return entry
  }

  draw(layer: DrawLayer): void {
    const gl = this.gl
    if (layer.opacity <= 0) return

    if (layer.solid) {
      gl.uniform1i(this.uniforms.u_solid, 1)
      gl.uniform3f(this.uniforms.u_color, ...layer.solid)
    } else {
      const entry = this.texture(layer.key)
      entry.used = true
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, entry.texture)
      if (layer.upload && layer.source) {
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.source)
          entry.ready = true
        } catch {
          // A frame that is not decodable yet; keep showing the previous one.
        }
      }
      if (!entry.ready) return
      gl.uniform1i(this.uniforms.u_solid, 0)
    }

    gl.uniform1f(this.uniforms.u_opacity, Math.min(1, layer.opacity))
    gl.uniform4f(
      this.uniforms.u_eq,
      layer.color.brightness,
      layer.color.contrast,
      layer.color.saturation,
      Math.max(0.01, layer.color.gamma)
    )

    const [u0, v0, u1, v1] = layer.uv
    const [tl, tr, br, bl] = layer.corners
    const d = this.data
    // Two triangles: tl, tr, br and tl, br, bl.
    d.set([tl[0], tl[1], u0, v0, tr[0], tr[1], u1, v0, br[0], br[1], u1, v1])
    d.set([tl[0], tl[1], u0, v0, br[0], br[1], u1, v1, bl[0], bl[1], u0, v1], 12)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  hasTexture(key: string): boolean {
    return this.textures.get(key)?.ready ?? false
  }

  /** Frees textures that were not drawn this frame. */
  end(): void {
    for (const [key, entry] of this.textures) {
      if (!entry.used) {
        this.gl.deleteTexture(entry.texture)
        this.textures.delete(key)
      }
    }
  }

  destroy(): void {
    for (const entry of this.textures.values()) this.gl.deleteTexture(entry.texture)
    this.textures.clear()
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
