// 前向一致性核对：Python(PyTorch) 与 TS 手写前向必须是同一个函数。
//
// 训练侧（train/train.py）会导出 <weights>.parity.json：
// 几条真实样本的输入 + PyTorch 算出的 logits / value。
// 这里用同一份权重在 TS 里跑一遍，逐元素比对。
//
// 为什么必须有这一步：如果权重转置/维度顺序错了，棋力会**看起来还行**（网络还是有结构的），
// 但实际是在用一个错位的模型下棋 —— 这种问题只有逐元素比对才抓得到。
//
// 用法：pnpm exec tsx scripts/check-parity.ts ../train/weights/net-v1.bin

import { readFileSync } from 'node:fs';

import { FEATURE_COUNT, GLOBAL_COUNT, encode } from '../src/core/features';
import { TinyNet, parseWeights } from '../src/core/nn';

const weightsPath = process.argv[2];
if (!weightsPath) throw new Error('用法：tsx scripts/check-parity.ts <weights.bin> [parity.json]');
const parityPath = process.argv[3] ?? weightsPath.replace(/\.bin$/, '.parity.json');

const buf = readFileSync(weightsPath);
const weights = parseWeights(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
const net = new TinyNet(weights);

const parity = JSON.parse(readFileSync(parityPath, 'utf8')) as {
  x: number[][];
  g: number[][];
  policy: number[][];
  value: number[];
};

let worstPolicy = 0;
let worstValue = 0;
for (let i = 0; i < parity.x.length; i++) {
  const features = Float32Array.from(parity.x[i]!);
  if (features.length !== FEATURE_COUNT) throw new Error('对照样本特征维度不对');
  const globals = Float32Array.from(parity.g[i]!);
  if (globals.length !== GLOBAL_COUNT) throw new Error('对照样本全局维度不对');

  // 注意：这里绕开 encode()，直接用存下来的特征 —— 核对的是"同一个输入下两边前向是否一致"
  const out = net.forward({ features, globals, mask: new Uint8Array(180).fill(1) });
  const expectPolicy = parity.policy[i]!;
  const expectValue = parity.value[i]!;

  let maxDiff = 0;
  for (let a = 0; a < expectPolicy.length; a++) {
    maxDiff = Math.max(maxDiff, Math.abs(out.policy[a]! - expectPolicy[a]!));
  }
  const valueDiff = Math.abs(out.value - expectValue);
  worstPolicy = Math.max(worstPolicy, maxDiff);
  worstValue = Math.max(worstValue, valueDiff);
  console.log(`  样本 ${i}: logits 最大差 ${maxDiff.toExponential(2)} · value 差 ${valueDiff.toExponential(2)}`);
}

const POLICY_TOL = 2e-3;
const VALUE_TOL = 2e-3;
if (worstPolicy > POLICY_TOL || worstValue > VALUE_TOL) {
  throw new Error(
    `前向不一致：logits 最大差 ${worstPolicy}，value 最大差 ${worstValue}（容差 ${POLICY_TOL}/${VALUE_TOL}）`,
  );
}
console.log(`前向一致 ✔（logits ≤ ${worstPolicy.toExponential(2)}，value ≤ ${worstValue.toExponential(2)}）`);

// 顺手量一下前向耗时，这直接决定"浏览器里能不能实时算"
{
  const features = Float32Array.from(parity.x[0]!);
  const globals = Float32Array.from(parity.g[0]!);
  const enc = { features, globals, mask: new Uint8Array(180).fill(1) };
  net.forward(enc);
  const t0 = performance.now();
  const N = 200;
  for (let i = 0; i < N; i++) net.forward(enc);
  const ms = (performance.now() - t0) / N;
  console.log(`单次前向 ${ms.toFixed(2)} ms（node 环境，浏览器大致同量级）`);
}

// 顺便确认 encode() 本身能跑通（不被上面的旁路绕过）
{
  const { createState } = await import('../src/core/reduce');
  const { viewFor } = await import('../src/core/visibility');
  const enc = encode(viewFor(createState(1), 'red'));
  const out = net.forward(enc);
  console.log(`encode() 通路自检：value=${out.value.toFixed(3)} logits 有限=${out.policy.every((v) => Number.isFinite(v))}`);
}
