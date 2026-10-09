/*
 * A small multilayer perceptron with no dependencies: Float32Array weights, tanh hidden layers and
 * a linear output, forward and backward passes over a batch, and Adam. Big enough for a bot's
 * brain (a few tens of thousands of weights), small enough to train on a CPU and run in a browser.
 */

export interface MlpJson {
  sizes: number[];
  /** Every weight and bias, base64 of a little-endian Float32Array */
  params: string;
}

export class Mlp {
  readonly sizes: readonly number[];
  /** All weights and biases, layer by layer: W (out × in, row-major) then b (out) */
  readonly params: Float32Array;
  /** Gradient of the loss with respect to params, accumulated by backward() */
  readonly grad: Float32Array;
  private readonly wOffset: number[] = [];
  private readonly bOffset: number[] = [];
  /** Activations of every layer from the last batched forward(), for backward() */
  private acts: Float32Array[] = [];
  private batch = 0;
  /** Scratch for single-sample inference */
  private readonly one: Float32Array[];

  constructor(sizes: readonly number[], params?: Float32Array, rand: () => number = Math.random) {
    this.sizes = sizes;
    let n = 0;
    for (let l = 0; l < sizes.length - 1; l++) {
      this.wOffset.push(n);
      n += sizes[l]! * sizes[l + 1]!;
      this.bOffset.push(n);
      n += sizes[l + 1]!;
    }
    this.params = params ?? new Float32Array(n);
    if (this.params.length !== n) throw new Error(`Expected ${n} parameters, got ${this.params.length}`);
    this.grad = new Float32Array(n);
    this.one = sizes.map((s) => new Float32Array(s));
    if (!params) this.init(rand);
  }

  get layers(): number {
    return this.sizes.length - 1;
  }

  /** Orthogonal-ish init: scaled uniform, smaller for the output layer so early policies are near uniform. */
  private init(rand: () => number): void {
    for (let l = 0; l < this.layers; l++) {
      const fanIn = this.sizes[l]!;
      const out = this.sizes[l + 1]!;
      const last = l === this.layers - 1;
      const scale = (last ? 0.01 : 1) * Math.sqrt(6 / (fanIn + out));
      const w = this.wOffset[l]!;
      for (let i = 0; i < fanIn * out; i++) this.params[w + i] = (rand() * 2 - 1) * scale;
    }
  }

  /** Scale the output layer's initial weights (e.g. a value head starts larger than a policy head). */
  scaleOutput(factor: number): void {
    const l = this.layers - 1;
    const w = this.wOffset[l]!;
    for (let i = 0; i < this.sizes[l]! * this.sizes[l + 1]!; i++) this.params[w + i]! *= factor;
  }

  /** One input, no bookkeeping for backward. The result is reused by the next call. */
  run(input: ArrayLike<number>): Float32Array {
    const a = this.one;
    a[0]!.set(input as ArrayLike<number>);
    for (let l = 0; l < this.layers; l++) {
      layer(this.params, this.wOffset[l]!, this.bOffset[l]!, a[l]!, a[l + 1]!, this.sizes[l]!, this.sizes[l + 1]!, 1, l < this.layers - 1);
    }
    return a[this.layers]!;
  }

  /** `n` inputs (row-major, n × in). Returns n × out; keeps activations for backward(). */
  forward(input: Float32Array, n: number): Float32Array {
    if (this.batch !== n || this.acts.length === 0) {
      this.acts = this.sizes.map((s) => new Float32Array(s * n));
      this.batch = n;
    }
    this.acts[0]!.set(input.subarray(0, n * this.sizes[0]!));
    for (let l = 0; l < this.layers; l++) {
      layer(this.params, this.wOffset[l]!, this.bOffset[l]!, this.acts[l]!, this.acts[l + 1]!, this.sizes[l]!, this.sizes[l + 1]!, n, l < this.layers - 1);
    }
    return this.acts[this.layers]!;
  }

  zeroGrad(): void {
    this.grad.fill(0);
  }

  /** Accumulate gradients for the last forward(), given dLoss/dOutput (n × out). */
  backward(gradOut: Float32Array): void {
    const n = this.batch;
    let delta = Float32Array.from(gradOut.subarray(0, n * this.sizes[this.layers]!));
    for (let l = this.layers - 1; l >= 0; l--) {
      const inSize = this.sizes[l]!;
      const outSize = this.sizes[l + 1]!;
      const x = this.acts[l]!;
      const w = this.wOffset[l]!;
      const b = this.bOffset[l]!;
      const p = this.params;
      const g = this.grad;
      const prev = l > 0 ? new Float32Array(n * inSize) : null;
      for (let s = 0; s < n; s++) {
        const xo = s * inSize;
        const d0 = s * outSize;
        for (let o = 0; o < outSize; o++) {
          const d = delta[d0 + o]!;
          if (d === 0) continue;
          g[b + o]! += d;
          const row = w + o * inSize;
          for (let i = 0; i < inSize; i++) g[row + i]! += d * x[xo + i]!;
          if (prev) for (let i = 0; i < inSize; i++) prev[xo + i]! += d * p[row + i]!;
        }
      }
      if (prev) {
        // Through the tanh of the layer below: d/dx tanh = 1 - tanh².
        for (let i = 0; i < prev.length; i++) prev[i]! *= 1 - x[i]! * x[i]!;
        delta = prev;
      }
    }
  }

  toJSON(): MlpJson {
    return { sizes: [...this.sizes], params: encodeFloats(this.params) };
  }

  static fromJSON(json: MlpJson): Mlp {
    return new Mlp(json.sizes, decodeFloats(json.params));
  }
}

/** out = act(W · in + b) for n samples */
function layer(
  p: Float32Array, w: number, b: number, input: Float32Array, out: Float32Array,
  inSize: number, outSize: number, n: number, tanh: boolean,
): void {
  for (let s = 0; s < n; s++) {
    const xo = s * inSize;
    const yo = s * outSize;
    for (let o = 0; o < outSize; o++) {
      let sum = p[b + o]!;
      const row = w + o * inSize;
      for (let i = 0; i < inSize; i++) sum += p[row + i]! * input[xo + i]!;
      out[yo + o] = tanh ? Math.tanh(sum) : sum;
    }
  }
}

/** Adam over one flat parameter vector. */
export class Adam {
  private readonly m: Float32Array;
  private readonly v: Float32Array;
  private t = 0;

  constructor(size: number, private readonly beta1 = 0.9, private readonly beta2 = 0.999, private readonly eps = 1e-8) {
    this.m = new Float32Array(size);
    this.v = new Float32Array(size);
  }

  /** params -= lr · Adam(grad); the gradient is clipped to a global norm of `maxNorm` first. */
  step(params: Float32Array, grad: Float32Array, lr: number, maxNorm = Infinity): void {
    let norm = 0;
    for (let i = 0; i < grad.length; i++) norm += grad[i]! * grad[i]!;
    norm = Math.sqrt(norm);
    const scale = norm > maxNorm ? maxNorm / norm : 1;
    this.t++;
    const { m, v, beta1, beta2, eps } = this;
    const c1 = 1 - beta1 ** this.t;
    const c2 = 1 - beta2 ** this.t;
    for (let i = 0; i < params.length; i++) {
      const g = grad[i]! * scale;
      m[i] = beta1 * m[i]! + (1 - beta1) * g;
      v[i] = beta2 * v[i]! + (1 - beta2) * g * g;
      params[i]! -= (lr * (m[i]! / c1)) / (Math.sqrt(v[i]! / c2) + eps);
    }
  }
}

// ---------------------------------------------------------------- float arrays as text

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 of the array's bytes (little-endian), in the browser and in Node alike. */
export function encodeFloats(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
      + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=')
      + (i + 2 < bytes.length ? B64[n & 63]! : '=');
  }
  return out;
}

export function decodeFloats(s: string): Float32Array {
  const clean = s.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]!) << 18) | (B64.indexOf(clean[i + 1]!) << 12)
      | ((B64.indexOf(clean[i + 2] ?? 'A') & 63) << 6) | (B64.indexOf(clean[i + 3] ?? 'A') & 63);
    if (o < bytes.length) bytes[o++] = (n >> 16) & 255;
    if (o < bytes.length) bytes[o++] = (n >> 8) & 255;
    if (o < bytes.length) bytes[o++] = n & 255;
  }
  return new Float32Array(bytes.buffer, 0, bytes.length / 4);
}
