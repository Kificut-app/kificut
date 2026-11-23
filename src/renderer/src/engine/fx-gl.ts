/*
 * Offscreen passes for clip effects in the WebGL 2 preview. A layer is first drawn at its own size
 * into a texture, then each pass reads one texture and writes another, in the same order and with
 * the same math as the FFmpeg filters in src/shared/ffmpeg-graph.ts.
 *
 * Textures hold straight (not premultiplied) RGBA with the top row of the picture in row 0, the
 * same as uploaded video frames, so a pass can use gl_FragCoord / size as its texture coordinate.
 */

/** `css` is the CSS filter the 2D canvas fallback uses for passes that have one. */
export type FxPass = (
  | { kind: 'blur'; sigma: number }
  | { kind: 'sharpen'; amount: number }
  | { kind: 'pixelate'; cells: [number, number] }
  | { kind: 'glow'; low: number; gain: number; sigma: number; intensity: number }
  | { kind: 'multiply'; image: FxImage }
  | { kind: 'grain'; deviation: number; seed: number }
  | { kind: 'shift'; offset: [number, number] }
  | { kind: 'matrix'; matrix: number[]; offset: number }
  | {
      kind: 'key'
      uv: [number, number]
      similarity: number
      smoothness: number
      spill: number
      blue: boolean
    }
) & { css?: string }

export interface FxImage {
  /** Texture cache key. */
  key: string
  source: TexImageSource
}

export interface FxShadow {
  color: [number, number, number]
  opacity: number
  sigma: number
  offset: [number, number]
  pad: number
}

export interface LayerFx {
  /** Layer size in output pixels, before rotation. */
  width: number
  height: number
  passes: FxPass[]
  mask: FxImage | null
  border: FxImage | null
  shadow: FxShadow | null
}

export interface Target {
  texture: WebGLTexture
  framebuffer: WebGLFramebuffer
  width: number
  height: number
  busy: boolean
  used: boolean
}

const VERTEX = `#version 300 es
in vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const HEADER = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform sampler2D u_other;
uniform sampler2D u_third;
uniform vec2 u_size;
uniform vec2 u_srcSize;
out vec4 outColor;
vec2 here() { return gl_FragCoord.xy / u_size; }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`

const SHADERS = {
  blur: `
uniform vec2 u_dir;
uniform float u_sigma;
uniform float u_step;
void main() {
  vec2 uv = here();
  vec2 texel = u_dir / u_size;
  float limit = 3.0 * u_sigma + u_step;
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -64; i <= 64; i++) {
    float x = float(i) * u_step;
    if (abs(x) > limit) continue;
    float w = exp(-0.5 * x * x / (u_sigma * u_sigma));
    sum += texture(u_src, uv + texel * x) * w;
    total += w;
  }
  outColor = sum / total;
}`,
  // FFmpeg's unsharp with a 5x5 luma matrix: the brightness moves away from its local average.
  sharpen: `
uniform float u_amount;
void main() {
  vec2 uv = here();
  vec2 texel = 1.0 / u_size;
  vec4 c = texture(u_src, uv);
  float sum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) sum += luma(texture(u_src, uv + vec2(x, y) * texel).rgb);
  }
  float d = (luma(c.rgb) - sum / 25.0) * u_amount;
  outColor = vec4(clamp(c.rgb + d, 0.0, 1.0), c.a);
}`,
  // Average of each block (scale down with area), then nearest neighbour back up.
  pixelate: `
uniform vec2 u_cells;
void main() {
  vec2 cell = floor(here() * u_cells);
  vec4 sum = vec4(0.0);
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) sum += texture(u_src, (cell + (vec2(x, y) + 0.5) / 4.0) / u_cells);
  }
  outColor = sum / 16.0;
}`,
  threshold: `
uniform float u_low;
uniform float u_gain;
void main() {
  vec4 c = texture(u_src, here());
  outColor = vec4(clamp((c.rgb * 255.0 - u_low) * u_gain, 0.0, 255.0) / 255.0, c.a);
}`,
  // FFmpeg blend: top + (screen(top, bottom) - top) * opacity, on every channel.
  screen: `
uniform float u_opacity;
void main() {
  vec4 a = texture(u_src, here());
  vec4 b = texture(u_other, here());
  vec4 s = 1.0 - (1.0 - a) * (1.0 - b);
  outColor = a + (s - a) * u_opacity;
}`,
  multiply: `
void main() {
  vec4 a = texture(u_src, here());
  outColor = vec4(a.rgb * texture(u_other, here()).rgb, a.a);
}`,
  grain: `
uniform float u_deviation;
uniform float u_seed;
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
void main() {
  vec4 c = texture(u_src, here());
  vec2 p = gl_FragCoord.xy + vec2(37.0, 17.0) * u_seed;
  float n = sqrt(-2.0 * log(max(hash(p), 1e-6))) * cos(6.2831853 * hash(p + 19.19));
  outColor = vec4(clamp(c.rgb + n * u_deviation, 0.0, 1.0), c.a);
}`,
  shift: `
uniform vec2 u_offset;
void main() {
  vec2 uv = here();
  vec2 d = u_offset / u_size;
  vec4 c = texture(u_src, uv);
  outColor = vec4(texture(u_src, uv - d).r, c.g, texture(u_src, uv + d).b, c.a);
}`,
  matrix: `
uniform mat3 u_matrix;
uniform float u_offset;
void main() {
  vec4 c = texture(u_src, here());
  outColor = vec4(clamp(u_matrix * c.rgb + u_offset, 0.0, 1.0), c.a);
}`,
  // FFmpeg chromakey (U/V distance to the key averaged over 3x3 pixels), then despill.
  key: `
uniform vec2 u_key;
uniform float u_similarity;
uniform float u_smoothness;
uniform float u_spill;
uniform bool u_blue;
vec2 chroma(vec3 c) {
  c *= 255.0;
  float k = 224.0 / 255.0;
  return vec2(
    -0.16874 * k * c.r - 0.33126 * k * c.g + 0.5 * k * c.b + 128.0,
    0.5 * k * c.r - 0.41869 * k * c.g - 0.08131 * k * c.b + 128.0
  );
}
void main() {
  vec2 uv = here();
  vec2 texel = 1.5 / u_size;
  float diff = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 d = chroma(texture(u_src, uv + vec2(x, y) * texel).rgb) - u_key;
      diff += sqrt(dot(d, d) / (255.0 * 255.0 * 2.0));
    }
  }
  diff /= 9.0;
  float alpha = u_smoothness > 0.0001
    ? clamp((diff - u_similarity) / u_smoothness, 0.0, 1.0)
    : (diff > u_similarity ? 1.0 : 0.0);
  vec3 rgb = texture(u_src, uv).rgb;
  if (u_spill > 0.0) {
    if (u_blue) rgb.b = max(rgb.b - max(rgb.b - (rgb.r + rgb.g) * 0.5, 0.0) * u_spill, 0.0);
    else rgb.g = max(rgb.g - max(rgb.g - (rgb.r + rgb.b) * 0.5, 0.0) * u_spill, 0.0);
  }
  outColor = vec4(rgb, alpha);
}`,
  // The mask multiplies the alpha, then the border goes on top the way FFmpeg's overlay does it.
  finish: `
uniform bool u_hasMask;
uniform bool u_hasBorder;
void main() {
  vec2 uv = here();
  vec4 l = texture(u_src, uv);
  if (u_hasMask) l.a *= texture(u_other, uv).a;
  if (u_hasBorder) {
    vec4 b = texture(u_third, uv);
    l = vec4(mix(l.rgb, b.rgb, b.a), b.a + l.a * (1.0 - b.a));
  }
  outColor = l;
}`,
  shadowAlpha: `
uniform vec2 u_offset;
uniform float u_pad;
void main() {
  vec2 p = (gl_FragCoord.xy - vec2(u_pad) - u_offset) / u_srcSize;
  bool inside = p.x >= 0.0 && p.y >= 0.0 && p.x <= 1.0 && p.y <= 1.0;
  outColor = vec4(0.0, 0.0, 0.0, inside ? texture(u_src, p).a : 0.0);
}`,
  compose: `
uniform vec3 u_color;
uniform float u_opacity;
uniform float u_pad;
void main() {
  float shadow = texture(u_other, here()).a * u_opacity;
  vec2 p = (gl_FragCoord.xy - vec2(u_pad)) / u_srcSize;
  bool inside = p.x >= 0.0 && p.y >= 0.0 && p.x <= 1.0 && p.y <= 1.0;
  vec4 l = inside ? texture(u_src, p) : vec4(0.0);
  outColor = vec4(mix(u_color, l.rgb, l.a), l.a + shadow * (1.0 - l.a));
}`
}

type ShaderName = keyof typeof SHADERS
type Uniforms = Record<string, number | boolean | number[]>

export class FxPipeline {
  private programs = new Map<ShaderName, WebGLProgram>()
  private locations = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>()
  private vao: WebGLVertexArrayObject
  private targets: Target[] = []

  constructor(
    private gl: WebGL2RenderingContext,
    private compile: (vertex: string, fragment: string) => WebGLProgram,
    /** Uploads (when changed) and returns the texture for an image. */
    private imageTexture: (image: FxImage) => WebGLTexture
  ) {
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    const buffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    // One triangle that covers the whole target.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
  }

  /** A free render target of this size; call `release` when its contents are no longer needed. */
  target(width: number, height: number): Target {
    const gl = this.gl
    let target = this.targets.find((t) => !t.busy && t.width === width && t.height === height)
    if (!target) {
      const texture = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const framebuffer = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      target = { texture, framebuffer, width, height, busy: false, used: false }
      this.targets.push(target)
    }
    target.busy = true
    target.used = true
    return target
  }

  release(target: Target): void {
    target.busy = false
  }

  /** Runs the effect passes, mask, border and shadow on `input` and returns the finished layer. */
  process(input: Target, fx: LayerFx): Target {
    let current = input
    const swap = (next: Target) => {
      this.release(current)
      current = next
    }
    for (const pass of fx.passes) swap(this.pass(pass, current))
    if (fx.mask || fx.border) {
      const out = this.target(current.width, current.height)
      const mask = fx.mask ? this.imageTexture(fx.mask) : null
      const border = fx.border ? this.imageTexture(fx.border) : null
      this.run('finish', out, [current.texture, mask, border], {
        u_hasMask: !!fx.mask,
        u_hasBorder: !!fx.border
      })
      swap(out)
    }
    if (fx.shadow) swap(this.shadow(current, fx.shadow))
    return current
  }

  private pass(pass: FxPass, input: Target): Target {
    const { width, height } = input
    const out = () => this.target(width, height)
    switch (pass.kind) {
      case 'blur':
        return this.blur(input, pass.sigma, false)
      case 'sharpen':
        return this.simple('sharpen', input, { u_amount: pass.amount })
      case 'pixelate':
        return this.simple('pixelate', input, { u_cells: pass.cells })
      case 'glow': {
        const bright = this.simple('threshold', input, { u_low: pass.low, u_gain: pass.gain })
        const blurred = this.blur(bright, pass.sigma, true)
        const result = out()
        this.run('screen', result, [input.texture, blurred.texture], { u_opacity: pass.intensity })
        this.release(blurred)
        return result
      }
      case 'multiply': {
        const result = out()
        this.run('multiply', result, [input.texture, this.imageTexture(pass.image)], {})
        return result
      }
      case 'grain':
        return this.simple('grain', input, { u_deviation: pass.deviation, u_seed: pass.seed })
      case 'shift':
        return this.simple('shift', input, { u_offset: pass.offset })
      case 'matrix':
        return this.simple('matrix', input, { u_matrix: pass.matrix, u_offset: pass.offset })
      case 'key':
        return this.simple('key', input, {
          u_key: pass.uv,
          u_similarity: pass.similarity,
          u_smoothness: pass.smoothness,
          u_spill: pass.spill,
          u_blue: pass.blue
        })
    }
  }

  /** One pass from `input` into a new target of the same size. `input` stays valid. */
  private simple(name: ShaderName, input: Target, uniforms: Uniforms): Target {
    const result = this.target(input.width, input.height)
    this.run(name, result, [input.texture], uniforms)
    return result
  }

  /** Separable Gaussian blur. With `consume` the input target is released. */
  private blur(input: Target, sigma: number, consume: boolean): Target {
    if (sigma < 0.3) {
      if (consume) return input
      const copy = this.target(input.width, input.height)
      this.run('matrix', copy, [input.texture], { u_matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], u_offset: 0 })
      return copy
    }
    const step = Math.max(1, (3 * sigma) / 64)
    const across = this.target(input.width, input.height)
    this.run('blur', across, [input.texture], { u_dir: [1, 0], u_sigma: sigma, u_step: step })
    if (consume) this.release(input)
    const down = this.target(input.width, input.height)
    this.run('blur', down, [across.texture], { u_dir: [0, 1], u_sigma: sigma, u_step: step })
    this.release(across)
    return down
  }

  private shadow(layer: Target, shadow: FxShadow): Target {
    const width = layer.width + 2 * shadow.pad
    const height = layer.height + 2 * shadow.pad
    const alpha = this.target(width, height)
    this.run('shadowAlpha', alpha, [layer.texture], { u_offset: shadow.offset, u_pad: shadow.pad }, [
      layer.width,
      layer.height
    ])
    const soft = this.blur(alpha, shadow.sigma, true)
    const result = this.target(width, height)
    this.run(
      'compose',
      result,
      [layer.texture, soft.texture],
      { u_color: shadow.color, u_opacity: shadow.opacity, u_pad: shadow.pad },
      [layer.width, layer.height]
    )
    this.release(soft)
    return result
  }

  private program(name: ShaderName): WebGLProgram {
    let program = this.programs.get(name)
    if (!program) {
      program = this.compile(VERTEX, HEADER + SHADERS[name])
      this.programs.set(name, program)
      const gl = this.gl
      gl.useProgram(program)
      gl.uniform1i(this.location(program, 'u_src'), 0)
      gl.uniform1i(this.location(program, 'u_other'), 1)
      gl.uniform1i(this.location(program, 'u_third'), 2)
    }
    return program
  }

  private location(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    let map = this.locations.get(program)
    if (!map) {
      map = new Map()
      this.locations.set(program, map)
    }
    if (!map.has(name)) map.set(name, this.gl.getUniformLocation(program, name))
    return map.get(name)!
  }

  private run(
    name: ShaderName,
    target: Target,
    textures: Array<WebGLTexture | null>,
    uniforms: Uniforms,
    /** Size of the first texture when it differs from the target (shadow passes). */
    sourceSize: [number, number] = [target.width, target.height]
  ): void {
    const gl = this.gl
    const program = this.program(name)
    gl.useProgram(program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.viewport(0, 0, target.width, target.height)
    textures.forEach((texture, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, texture)
    })
    gl.uniform2f(this.location(program, 'u_size'), target.width, target.height)
    gl.uniform2f(this.location(program, 'u_srcSize'), sourceSize[0], sourceSize[1])
    for (const [key, value] of Object.entries(uniforms)) {
      const loc = this.location(program, key)
      if (typeof value === 'boolean') gl.uniform1i(loc, value ? 1 : 0)
      else if (typeof value === 'number') gl.uniform1f(loc, value)
      else if (value.length === 2) gl.uniform2f(loc, value[0], value[1])
      else if (value.length === 3) gl.uniform3f(loc, value[0], value[1], value[2])
      else if (value.length === 9) gl.uniformMatrix3fv(loc, true, value)
    }
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
    gl.enable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0)
  }

  /** Frees targets that were not used since the last call. */
  sweep(): void {
    this.targets = this.targets.filter((t) => {
      if (t.used || t.busy) {
        t.used = false
        return true
      }
      this.gl.deleteTexture(t.texture)
      this.gl.deleteFramebuffer(t.framebuffer)
      return false
    })
  }

  destroy(): void {
    for (const t of this.targets) {
      this.gl.deleteTexture(t.texture)
      this.gl.deleteFramebuffer(t.framebuffer)
    }
    this.targets = []
  }
}
