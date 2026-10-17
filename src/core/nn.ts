// 手写的极小卷积网前向（零依赖，不打 ONNX/tfjs）。
//
// 为什么自己写：这个网一共约 9.6 万个参数（float32 约 380 KB），前向约 100 万次乘加 ——
// 在 JS 里是**毫秒级**的事。为它引入几 MB 的 wasm 运行时，既换不来速度，
// 又违背这个仓库"目录自给自足、无运行时依赖"的既有约定（连 Service Worker 都要能离线缓存它）。
//
// 权重文件格式（二进制，小端，自描述）：
//   magic  "BCNN"           4 字节
//   ver    u8               1 字节（当前 = 1）
//   n      u32              张量个数
//   之后 n 个张量：u8 名字长度 + 名字(utf8) + u8 维度数 + u32 各维度 + f32 数据
// 张量的名字与形状由 Python 侧（train/export.py）写出，两边靠下面的 ARCH 常量对齐。

import type { Encoded } from './features';
import { ACTION_COUNT, CELLS, FEATURE_CHANNELS, GLOBAL_COUNT } from './features';

/** 网络结构常量 —— 改这里就必须同步改 train/model.py，并且两边的形状检查会拦住不一致 */
export const ARCH = {
  inChannels: FEATURE_CHANNELS,
  trunk: 32,
  policyChannels: 8,
  valueChannels: 8,
  valueHidden: 64,
  actions: ACTION_COUNT,
  globals: GLOBAL_COUNT,
  cells: CELLS,
} as const;

export type Tensors = Record<string, { dims: number[]; data: Float32Array }>;

const MAGIC = [0x42, 0x43, 0x4e, 0x4e]; // 'BCNN'
export const FORMAT_VERSION = 1;

/** 解析权重二进制。形状不对就抛错 —— 静默错位的权重比没有权重更糟 */
export function parseWeights(buffer: ArrayBuffer): Tensors {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('权重文件魔数不对（不是 BCNN）');
  }
  const version = view.getUint8(4);
  if (version !== FORMAT_VERSION) throw new Error(`权重格式版本不支持：${version}`);

  let offset = 5;
  const count = view.getUint32(offset, true);
  offset += 4;

  const out: Tensors = {};
  for (let t = 0; t < count; t++) {
    const nameLen = view.getUint8(offset);
    offset += 1;
    const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLen));
    offset += nameLen;
    const ndim = view.getUint8(offset);
    offset += 1;
    const dims: number[] = [];
    let total = 1;
    for (let d = 0; d < ndim; d++) {
      const dim = view.getUint32(offset, true);
      offset += 4;
      dims.push(dim);
      total *= dim;
    }
    // f32 数据可能不是 4 字节对齐的，所以逐元素读，不能直接 new Float32Array(buffer, offset)
    const data = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      data[i] = view.getFloat32(offset, true);
      offset += 4;
    }
    out[name] = { dims, data };
  }
  if (offset !== buffer.byteLength) {
    throw new Error(`权重文件尾部有 ${buffer.byteLength - offset} 字节多余数据`);
  }
  return out;
}

function need(t: Tensors, name: string, dims: number[]): Float32Array {
  const tensor = t[name];
  if (!tensor) throw new Error(`权重缺少张量：${name}`);
  if (tensor.dims.length !== dims.length || tensor.dims.some((d, i) => d !== dims[i])) {
    throw new Error(`张量 ${name} 形状不对：期望 [${dims}]，实际 [${tensor.dims}]`);
  }
  return tensor.data;
}

/**
 * 3x3 卷积（padding = 1，尺寸不变）。
 * 权重在文件里是 PyTorch 的 [out][in][ky][kx]；这里加载时转成 [ky][kx][in][out]，
 * 让最内层循环（out）走连续内存 —— 同样的乘加次数，快好几倍。
 */
function conv3x3(
  input: Float32Array,
  inC: number,
  outC: number,
  w: Float32Array,
  b: Float32Array,
  out: Float32Array,
  relu: boolean,
): void {
  out.fill(0);
  for (let oc = 0; oc < outC; oc++) {
    const bv = b[oc]!;
    for (let i = 0; i < CELLS; i++) out[oc * CELLS + i] = bv;
  }
  for (let ky = 0; ky < 3; ky++) {
    for (let kx = 0; kx < 3; kx++) {
      for (let ic = 0; ic < inC; ic++) {
        const wBase = ((ky * 3 + kx) * inC + ic) * outC;
        const iBase = ic * CELLS;
        for (let r = 0; r < 6; r++) {
          const rr = r + ky - 1;
          if (rr < 0 || rr > 5) continue;
          for (let c = 0; c < 6; c++) {
            const cc = c + kx - 1;
            if (cc < 0 || cc > 5) continue;
            const v = input[iBase + rr * 6 + cc]!;
            if (v === 0) continue;
            // 累加的是**中心格** (r,c)；rr/cc 只是取输入的位置。
            // （曾经写成 oBase = rr*6+cc，等于把核的方向反了 —— 形状全对、结果全错，
            //   被 check-parity 的逐元素比对抓到）
            const oBase = r * 6 + c;
            for (let oc = 0; oc < outC; oc++) {
              out[oc * CELLS + oBase] += v * w[wBase + oc]!;
            }
          }
        }
      }
    }
  }
  if (relu) for (let i = 0; i < out.length; i++) if (out[i]! < 0) out[i] = 0;
}

/** 1x1 卷积 = 逐像素的线性层 */
function conv1x1(
  input: Float32Array,
  inC: number,
  outC: number,
  w: Float32Array,
  b: Float32Array,
  out: Float32Array,
  relu: boolean,
): void {
  for (let i = 0; i < CELLS; i++) {
    for (let oc = 0; oc < outC; oc++) {
      let sum = b[oc]!;
      for (let ic = 0; ic < inC; ic++) sum += input[ic * CELLS + i]! * w[ic * outC + oc]!;
      out[oc * CELLS + i] = relu && sum < 0 ? 0 : sum;
    }
  }
}

function linear(input: Float32Array, inN: number, outN: number, w: Float32Array, b: Float32Array, out: Float32Array, relu: boolean): void {
  // PyTorch 的 Linear.weight 是 [out][in]，即 data[o * inN + i]。
  // 这里故意不再转置成 [in][out]：内层 i 循环在两个数组上都是顺序访问，对缓存更友好
  // （曾经写成 w[i * outN + o]，被前向核对抓了个正着：logits 差 0.15）
  for (let o = 0; o < outN; o++) {
    const base = o * inN;
    let sum = b[o]!;
    for (let i = 0; i < inN; i++) sum += input[i]! * w[base + i]!;
    out[o] = relu && sum < 0 ? 0 : sum;
  }
}

export interface NetOutput {
  /** 180 维原始 logits（未过掩码 softmax） */
  policy: Float32Array;
  /** tanh 输出，[-1, 1]，站在 `view.you` 视角 */
  value: number;
}

/**
 * 前向。所有中间缓冲区在构造时一次分配，`forward` 里零分配 ——
 * 这个函数每步棋都要跑，也会被搜索调用很多次。
 */
export class TinyNet {
  private readonly w: Tensors;
  private readonly a1 = new Float32Array(ARCH.trunk * CELLS);
  private readonly a2 = new Float32Array(ARCH.trunk * CELLS);
  private readonly a3 = new Float32Array(ARCH.trunk * CELLS);
  private readonly pHidden = new Float32Array(ARCH.policyChannels * CELLS);
  private readonly vHidden = new Float32Array(ARCH.valueChannels * CELLS);
  private readonly policy: Float32Array;
  private readonly vMid: Float32Array;
  private readonly valueIn: Float32Array;
  private readonly vOut = new Float32Array(1);

  constructor(weights: Tensors) {
    this.w = weights;
    // 构造即校验形状：宁可在这里炸，也不要下出一盘"权重错位"的棋
    need(weights, 'conv1.w', [ARCH.trunk, ARCH.inChannels, 3, 3]);
    need(weights, 'conv1.b', [ARCH.trunk]);
    need(weights, 'conv2.w', [ARCH.trunk, ARCH.trunk, 3, 3]);
    need(weights, 'conv2.b', [ARCH.trunk]);
    need(weights, 'conv3.w', [ARCH.trunk, ARCH.trunk, 3, 3]);
    need(weights, 'conv3.b', [ARCH.trunk]);
    need(weights, 'policy.w', [ARCH.policyChannels, ARCH.trunk, 1, 1]);
    need(weights, 'policy.b', [ARCH.policyChannels]);
    need(weights, 'policy_fc.w', [ARCH.actions, ARCH.policyChannels * CELLS]);
    need(weights, 'policy_fc.b', [ARCH.actions]);
    need(weights, 'value.w', [ARCH.valueChannels, ARCH.trunk, 1, 1]);
    need(weights, 'value.b', [ARCH.valueChannels]);
    need(weights, 'value_fc1.w', [ARCH.valueHidden, ARCH.valueChannels * CELLS + ARCH.globals]);
    need(weights, 'value_fc1.b', [ARCH.valueHidden]);
    need(weights, 'value_fc2.w', [1, ARCH.valueHidden]);
    need(weights, 'value_fc2.b', [1]);

    // 3x3 权重在构造时转置成 [ky][kx][in][out]，之后前向的热循环就全在连续内存上跑
    for (const name of ['conv1', 'conv2', 'conv3']) {
      const src = weights[`${name}.w`]!;
      const [outC, inC] = src.dims as [number, number, number, number];
      const dst = new Float32Array(src.data.length);
      for (let oc = 0; oc < outC; oc++) {
        for (let ic = 0; ic < inC; ic++) {
          for (let ky = 0; ky < 3; ky++) {
            for (let kx = 0; kx < 3; kx++) {
              dst[((ky * 3 + kx) * inC + ic) * outC + oc] = src.data[((oc * inC + ic) * 3 + ky) * 3 + kx]!;
            }
          }
        }
      }
      weights[`${name}.wt`] = { dims: [3, 3, inC, outC], data: dst };
    }
    // 1x1 卷积同样需要 [in][out] 连续
    for (const [name, inC, outC] of [
      ['policy', ARCH.trunk, ARCH.policyChannels],
      ['value', ARCH.trunk, ARCH.valueChannels],
    ] as const) {
      const src = weights[`${name}.w`]!;
      const dst = new Float32Array(src.data.length);
      for (let o = 0; o < outC; o++) {
        for (let i = 0; i < inC; i++) dst[i * outC + o] = src.data[o * inC + i]!;
      }
      weights[`${name}.wt`] = { dims: [inC, outC], data: dst };
    }

    this.policy = new Float32Array(ARCH.actions);
    this.vMid = new Float32Array(ARCH.valueHidden);
    this.valueIn = new Float32Array(ARCH.valueChannels * CELLS + ARCH.globals);
  }

  forward(input: Encoded): NetOutput {
    const w = this.w;
    conv3x3(input.features, ARCH.inChannels, ARCH.trunk, w['conv1.wt']!.data, w['conv1.b']!.data, this.a1, true);
    conv3x3(this.a1, ARCH.trunk, ARCH.trunk, w['conv2.wt']!.data, w['conv2.b']!.data, this.a2, true);
    conv3x3(this.a2, ARCH.trunk, ARCH.trunk, w['conv3.wt']!.data, w['conv3.b']!.data, this.a3, true);

    conv1x1(this.a3, ARCH.trunk, ARCH.policyChannels, w['policy.wt']!.data, w['policy.b']!.data, this.pHidden, true);
    linear(this.pHidden, ARCH.policyChannels * CELLS, ARCH.actions, w['policy_fc.w']!.data, w['policy_fc.b']!.data, this.policy, false);

    conv1x1(this.a3, ARCH.trunk, ARCH.valueChannels, w['value.wt']!.data, w['value.b']!.data, this.vHidden, true);
    this.valueIn.set(this.vHidden, 0);
    this.valueIn.set(input.globals, ARCH.valueChannels * CELLS);
    linear(this.valueIn, this.valueIn.length, ARCH.valueHidden, w['value_fc1.w']!.data, w['value_fc1.b']!.data, this.vMid, true);
    linear(this.vMid, ARCH.valueHidden, 1, w['value_fc2.w']!.data, w['value_fc2.b']!.data, this.vOut, false);

    return { policy: this.policy, value: Math.tanh(this.vOut[0]!) };
  }
}
