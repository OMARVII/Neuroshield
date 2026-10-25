/**
 * NeuroShield — frame sampler.
 *
 * Reduces a video or canvas frame to 32×32 RGBA samples for the detector.
 * WebGL samples are linear light with premultiplied alpha; 2D samples are
 * sRGB with straight alpha.
 *
 * Preferred path (WebGL2): upload the frame into an sRGB texture, let the GPU
 * build mipmaps (which averages in linear light, so a small bright area keeps
 * its true weight), draw it at 32×32 and read the result back through a
 * pixel-buffer object. The readback is asynchronous: results arrive one frame
 * later and the main thread never waits for the GPU (~0.3 ms per 1080p frame).
 *
 * Fallback (2D canvas): draw the frame at 128×128, halve it to 64, draw the
 * 32×32 result on a CPU canvas and read it there. Synchronous and more
 * expensive, used when WebGL2 is unavailable, software-rendered, or its
 * context is lost.
 *
 * One WebGL context is shared by every reader in a document and released when
 * nothing has been sampled for a while, so pages keep their own context budget.
 */
var NeuroShieldSampler = (() => {
  'use strict';

  const SIZE = 32;
  const PIXEL_BYTES = SIZE * SIZE * 4;
  /** Readbacks in flight per source. The GPU is rarely more than one frame behind. */
  const RING_SIZE = 3;
  /** Release the shared WebGL context after this long without readers. */
  const IDLE_RELEASE_MS = 20000;
  /** After a context loss, use the 2D path for this long before trying WebGL again. */
  const GL_RETRY_MS = 60000;

  const VERTEX_SHADER = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D frame;
out vec4 color;
void main() {
  color = texture(frame, uv);
}`;

  function makeCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    return canvas;
  }

  /** Intrinsic size of a sampleable element; 0×0 when it has no frame yet. */
  function sourceSize(el) {
    if (el instanceof HTMLVideoElement) return { width: el.videoWidth, height: el.videoHeight };
    if (el instanceof HTMLCanvasElement) return { width: el.width, height: el.height };
    return { width: 0, height: 0 };
  }

  function isSecurityError(e) {
    return !!e && e.name === 'SecurityError';
  }

  // ─── WebGL2 path ─────────────────────────────────────────────────────

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(shader));
    return shader;
  }

  class GLPipeline {
    constructor() {
      const canvas = makeCanvas();
      const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'low-power',
        // Without a GPU the 2D path is cheaper than emulated WebGL.
        failIfMajorPerformanceCaveat: true,
      });
      if (!gl) throw new Error('WebGL2 unavailable');

      this.canvas = canvas;
      this.gl = gl;
      this.lost = false;
      this.readers = new Set();
      canvas.addEventListener('webglcontextlost', () => {
        this.lost = true;
      });

      const program = gl.createProgram();
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(program));
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, 'frame'), 0);

      // Render into an RGBA8 texture so alpha survives (a cleared canvas reads as transparent).
      const target = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, SIZE, SIZE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete');
      gl.viewport(0, 0, SIZE, SIZE);
      gl.activeTexture(gl.TEXTURE0);
      // Premultiplied, so averaging a partly transparent canvas weighs each
      // pixel by its coverage. Opaque video is unaffected.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    }

    destroy() {
      const ext = this.gl.getExtension('WEBGL_lose_context');
      if (ext && !this.lost) ext.loseContext();
      this.lost = true;
    }
  }

  let pipeline = null;
  let glRetryAt = 0;
  let releaseTimer = 0;

  function acquirePipeline() {
    if (pipeline && pipeline.lost) {
      pipeline = null;
      glRetryAt = performance.now() + GL_RETRY_MS;
    }
    if (pipeline) {
      clearTimeout(releaseTimer);
      return pipeline;
    }
    if (performance.now() < glRetryAt) return null;
    try {
      pipeline = new GLPipeline();
      return pipeline;
    } catch (_) {
      glRetryAt = Infinity;
      return null;
    }
  }

  function scheduleRelease() {
    if (!pipeline || pipeline.readers.size) return;
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      if (pipeline && !pipeline.readers.size) {
        pipeline.destroy();
        pipeline = null;
      }
    }, IDLE_RELEASE_MS);
  }

  class GLReader {
    constructor(p) {
      const gl = p.gl;
      this.kind = 'webgl';
      this.pipeline = p;
      this.pixels = new Uint8Array(PIXEL_BYTES);
      this.pending = [];
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.slots = [];
      for (let i = 0; i < RING_SIZE; i++) this.slots.push({ buffer: gl.createBuffer(), allocated: false, fence: null, timestamp: 0 });
      p.readers.add(this);
    }

    get broken() {
      return this.pipeline.lost;
    }

    /**
     * Queue a frame. Results are delivered to `sink` by a later capture() or
     * poll(), in order. Returns false when the frame was skipped.
     * Throws a SecurityError for cross-origin sources.
     */
    capture(source, timestamp, sink) {
      this.poll(sink);
      if (this.pipeline.lost) return false;
      const slot = this.slots.find((s) => !s.fence);
      if (!slot) return false;

      const gl = this.pipeline.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
      if (!slot.allocated) {
        // DYNAMIC_COPY, not *_READ: Chrome shadows READ buffers for readback and
        // logs a performance warning to the page console on every reuse. Same
        // cost either way (~0.2 ms per frame, measured).
        gl.bufferData(gl.PIXEL_PACK_BUFFER, PIXEL_BYTES, gl.DYNAMIC_COPY);
        slot.allocated = true;
      }
      gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      slot.timestamp = timestamp;
      this.pending.push(slot);
      gl.flush();
      return true;
    }

    /** Deliver every finished readback to `sink(pixels, timestamp, linear)`. */
    poll(sink) {
      const gl = this.pipeline.gl;
      while (this.pending.length) {
        const slot = this.pending[0];
        const status = this.pipeline.lost ? gl.WAIT_FAILED : gl.clientWaitSync(slot.fence, 0, 0);
        if (status === gl.TIMEOUT_EXPIRED) return;
        this.pending.shift();
        gl.deleteSync(slot.fence);
        slot.fence = null;
        if (status === gl.WAIT_FAILED) continue;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pixels);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        sink(this.pixels, slot.timestamp, true);
      }
    }

    dispose() {
      const gl = this.pipeline.gl;
      for (const slot of this.slots) {
        if (slot.fence) gl.deleteSync(slot.fence);
        gl.deleteBuffer(slot.buffer);
      }
      this.slots = [];
      this.pending = [];
      gl.deleteTexture(this.texture);
      this.pipeline.readers.delete(this);
      scheduleRelease();
    }
  }

  // ─── 2D canvas fallback ──────────────────────────────────────────────

  /** Frame size of anything drawImage accepts (including VideoFrame). */
  function drawableSize(source) {
    const size = sourceSize(source);
    if (size.width && size.height) return size;
    return { width: source.displayWidth || source.width || 0, height: source.displayHeight || source.height || 0 };
  }

  /**
   * Draws the frame at 128×128, then halves it twice. A single drawImage to
   * 32×32 reads only a few pixels per sample, so fine patterns read as black
   * or white depending on where they fall; 128×128 reads 16× as many.
   * Averages in sRGB, unlike the WebGL path.
   */
  class Canvas2DReader {
    constructor() {
      this.kind = '2d';
      this.broken = false;
      this.steps = [makeCanvas().getContext('2d'), makeCanvas().getContext('2d')];
      this.read = makeCanvas().getContext('2d', { willReadFrequently: true });
    }

    capture(source, timestamp, sink) {
      let { width: w, height: h } = drawableSize(source);
      let from = source;
      let step = 0;
      while (w > 2 * SIZE || h > 2 * SIZE) {
        // The first step goes straight to 128 px: halving a full frame on the
        // CPU costs more than everything else together.
        const first = step === 0 && (w > 4 * SIZE || h > 4 * SIZE);
        const nw = first ? 4 * SIZE : Math.max(SIZE, Math.ceil(w / 2));
        const nh = first ? 4 * SIZE : Math.max(SIZE, Math.ceil(h / 2));
        const ctx = this.steps[step++ % 2];
        if (ctx.canvas.width < nw || ctx.canvas.height < nh) {
          ctx.canvas.width = Math.max(ctx.canvas.width, nw);
          ctx.canvas.height = Math.max(ctx.canvas.height, nh);
        }
        ctx.clearRect(0, 0, nw, nh);
        ctx.drawImage(from, 0, 0, w, h, 0, 0, nw, nh);
        from = ctx.canvas;
        w = nw;
        h = nh;
      }
      this.read.clearRect(0, 0, SIZE, SIZE);
      if (w && h) this.read.drawImage(from, 0, 0, w, h, 0, 0, SIZE, SIZE);
      else this.read.drawImage(from, 0, 0, SIZE, SIZE);
      sink(this.read.getImageData(0, 0, SIZE, SIZE).data, timestamp, false);
      return true;
    }

    poll() {}

    dispose() {}
  }

  /**
   * A reader for one source element. Readers keep per-source GPU state and
   * remember taint, so create a new one when the source changes.
   */
  function createReader() {
    const p = acquirePipeline();
    if (p) {
      try {
        return new GLReader(p);
      } catch (_) {
        glRetryAt = Infinity;
      }
    }
    return new Canvas2DReader();
  }

  return Object.freeze({ SIZE, createReader, sourceSize, isSecurityError });
})();
