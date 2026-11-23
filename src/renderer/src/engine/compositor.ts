import type { ColorAdjust } from '@shared/types'
import type { Point } from '@shared/geometry'
import { FxPipeline, type FxImage, type LayerFx, type Target } from './fx-gl'

const VERTEX = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform vec2 u_resolution;
// -1 for the screen; 1 for an offscreen texture, which keeps the top row of the picture in row 0.
uniform float u_flip;
out vec2 v_uv;
void main() {
  vec2 clip = a_pos / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, clip.y * u_flip, 0.0, 1.0);
  v_uv = a_uv;
}`

// Mirrors FFmpeg's eq filter: contrast, brightness and gamma act on luma, saturation scales chroma.
// Temperature and tint are RGB gains after it, like the export's colorchannelmixer.
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_opacity;
uniform vec4 u_eq;
uniform vec3 u_gain;
uniform bool u_solid;
uniform vec3 u_color;
out vec4 outColor;
void main() {
  vec4 c = u_solid ? vec4(u_color, 1.0) : texture(u_texture, v_uv);
  vec3 rgb = c.rgb;
  float y = dot(rgb, vec3(0.299, 0.587, 0.114));
  float y2 = u_eq.y * (y - 0.5) + 0.5 + u_eq.x;
  y2 = y2 <= 0.0 ? 0.0 : min(pow(y2, 1.0 / u_eq.w), 1.0);
  rgb = clamp(vec3(y2) + (rgb - vec3(y)) * u_eq.z, 0.0, 1.0) * u_gain;
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
  /** RGB gains for temperature and tint. */
  gain: [number, number, number]
  opacity: number
  /** Effects, mask, border and shadow. `corners` are then those of the finished (padded) layer. */
  fx?: LayerFx
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
  /** The image last uploaded, for textures of effect images. */
  uploaded?: TexImageSource
}

const NO_GAIN: [number, number, number] = [1, 1, 1]

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
  private fx: FxPipeline

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
    this.program = this.createProgram(VERTEX, FRAGMENT)
    this.buffer = gl.createBuffer()!

    gl.useProgram(this.program)
    for (const name of [
      'u_resolution',
      'u_flip',
      'u_texture',
      'u_opacity',
      'u_eq',
      'u_gain',
      'u_solid',
      'u_color'
    ]) {
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

    this.fx = new FxPipeline(
      gl,
      (vertex, fragment) => this.createProgram(vertex, fragment),
      (image) => this.imageTexture(image)
    )
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

  private createProgram(vertex: string, fragment: string): WebGLProgram {
    const gl = this.gl
    const program = gl.createProgram()!
    gl.attachShader(program, this.compile(gl.VERTEX_SHADER, vertex))
    gl.attachShader(program, this.compile(gl.FRAGMENT_SHADER, fragment))
    // The effect passes share one vertex array that feeds location 0.
    gl.bindAttribLocation(program, 0, 'a_pos')
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
    gl.uniform1f(this.uniforms.u_flip, -1)
    for (const entry of this.textures.values()) entry.used = false
  }

  /** Texture for an effect image (mask, border, vignette), uploaded again only when it changes. */
  private imageTexture(image: FxImage): WebGLTexture {
    const gl = this.gl
    const entry = this.texture(image.key)
    entry.used = true
    if (entry.uploaded !== image.source) {
      gl.bindTexture(gl.TEXTURE_2D, entry.texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image.source)
      entry.uploaded = image.source
      entry.ready = true
    }
    return entry.texture
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

    let source: WebGLTexture | null = null
    if (layer.solid) {
      gl.uniform1i(this.uniforms.u_solid, 1)
      gl.uniform3f(this.uniforms.u_color, ...layer.solid)
    } else {
      const entry = this.texture(layer.key)
      source = entry.texture
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

    if (layer.fx) {
      this.drawWithFx(layer, layer.fx, source)
      return
    }
    this.quad(layer.corners, layer.uv, layer.color, layer.gain, Math.min(1, layer.opacity))
  }

  /** Draws the bound texture (or solid color) as a quad, with the color math of the base shader. */
  private quad(
    corners: Point[],
    uv: [number, number, number, number],
    color: ColorAdjust | null,
    gain: [number, number, number],
    opacity: number
  ): void {
    const gl = this.gl
    gl.uniform1f(this.uniforms.u_opacity, opacity)
    gl.uniform4f(
      this.uniforms.u_eq,
      color?.brightness ?? 0,
      color?.contrast ?? 1,
      color?.saturation ?? 1,
      Math.max(0.01, color?.gamma ?? 1)
    )
    gl.uniform3f(this.uniforms.u_gain, ...gain)

    const [u0, v0, u1, v1] = uv
    const [tl, tr, br, bl] = corners
    const d = this.data
    // Two triangles: tl, tr, br and tl, br, bl.
    d.set([tl[0], tl[1], u0, v0, tr[0], tr[1], u1, v0, br[0], br[1], u1, v1])
    d.set([tl[0], tl[1], u0, v0, br[0], br[1], u1, v1, bl[0], bl[1], u0, v1], 12)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  /**
   * Draws the layer at its own size into a texture (crop, flip and color included), runs the
   * effects on it, then puts the result on screen at the layer's corners.
   */
  private drawWithFx(layer: DrawLayer, fx: LayerFx, source: WebGLTexture | null): void {
    const gl = this.gl
    const base: Target = this.fx.target(fx.width, fx.height)
    // Creating a target binds its texture, so bind the clip's own again.
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, source)
    gl.bindFramebuffer(gl.FRAMEBUFFER, base.framebuffer)
    gl.viewport(0, 0, fx.width, fx.height)
    gl.disable(gl.BLEND)
    gl.uniform2f(this.uniforms.u_resolution, fx.width, fx.height)
    gl.uniform1f(this.uniforms.u_flip, 1)
    const full: Point[] = [
      [0, 0],
      [fx.width, 0],
      [fx.width, fx.height],
      [0, fx.height]
    ]
    this.quad(full, layer.uv, layer.color, layer.gain, 1)
    gl.enable(gl.BLEND)

    const done = this.fx.process(base, fx)

    gl.useProgram(this.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.uniform2f(this.uniforms.u_resolution, this.width, this.height)
    gl.uniform1f(this.uniforms.u_flip, -1)
    gl.uniform1i(this.uniforms.u_solid, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, done.texture)
    this.quad(layer.corners, [0, 0, 1, 1], null, NO_GAIN, Math.min(1, layer.opacity))
    this.fx.release(done)
  }

  hasTexture(key: string): boolean {
    return this.textures.get(key)?.ready ?? false
  }

  /** Frees textures and effect targets that were not used this frame. */
  end(): void {
    for (const [key, entry] of this.textures) {
      if (!entry.used) {
        this.gl.deleteTexture(entry.texture)
        this.textures.delete(key)
      }
    }
    this.fx.sweep()
  }

  destroy(): void {
    this.fx.destroy()
    for (const entry of this.textures.values()) this.gl.deleteTexture(entry.texture)
    this.textures.clear()
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
