// @vitest-environment jsdom
// App 级集成测试：开始界面 → 人机对战 → 玩家翻棋 → AI 应招。
// 原生版审计里 app.js 是 203 行、0 覆盖（连变异测试都做不了，因为代码根本没被加载）。

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import App from './App';

// 联机这一层在单测里换成假的：真的 peerjs 要 WebRTC，jsdom 没有，
// 而且真连会去打 PeerJS 公共云（测试不许上网）。
vi.mock('./transport/online', async () => {
  const { createLocalTransport } = await import('./transport/local');
  return {
    createOnlineHost: (seed: number) => {
      const transport = createLocalTransport(seed);
      const client = transport.connect('red');
      return {
        client,
        authority: transport.authority,
        invitation: Promise.resolve(
          `https://x.test/?mode=online&host=battlechess-${seed}&seed=${seed}&side=blue`,
        ),
        destroy: () => client.close(),
      };
    },
    // 客人：永远连不上（不产生任何消息），用来验证"连接中"这一屏
    createOnlineClient: () => ({
      side: 'blue' as const,
      onmessage: () => {},
      send: () => {},
      close: () => {},
    }),
  };
});

const cells = () => screen.getAllByTestId(/^cell-/);
const pieces = () => [...document.querySelectorAll('.piece')];
const revealed = () => [...document.querySelectorAll('.piece.is-revealed')];

/**
 * 找一张**现在真能翻**的格子。
 *
 * 之前这里硬编码 `cell-0-0`，可是「我执蓝、AI 先手」时 AI 第一手就可能把 0,0 翻掉 ——
 * 于是点击是空操作，步数不涨，测试随机红灯（约 1/4 的种子）。判据用 DOM 上的两个事实：
 *   · 这格上有棋子，且还没翻开（`.piece` 的 `data-at` + 缺 `is-revealed`）
 *   · 这格此刻是 `is-hoverable`（`cellFlags` 算出来的"可操作"，翻棋 / 选子都算）
 */
function flippableCell(): HTMLElement {
  const revealed = new Set(
    [...document.querySelectorAll('.piece.is-revealed')].map((p) => (p as HTMLElement).dataset.at ?? ''),
  );
  const candidates = cells().filter((cell) => {
    const at = cell.getAttribute('data-cell') ?? '';
    return cell.classList.contains('is-hoverable') && !revealed.has(at);
  });
  const cell = candidates[0];
  if (!cell) throw new Error('找不到可翻的格子');
  return cell as HTMLElement;
}

/**
 * 等到"轮到我"。
 *
 * 颜色现在是**种子派生**的（偶数红、奇数蓝），`?mode=ai` 进来时种子是随机的，
 * 所以我方可能是蓝方 —— 那样开局先动的是 AI。测试不能假设"我永远先手"，
 * 统一先等到自己回合（电脑先手时它会思考 420ms 后落子）。
 */
async function waitMyTurn() {
  await waitFor(() => expect(cells()).toHaveLength(36));
  // 8000 而不是 4000：AI 思考是真实计时器（420ms/步），整套测试并行跑满 CPU 时余量不够
  await waitFor(() => expect(screen.getByTestId('banner')).toHaveTextContent('轮到你了'), {
    timeout: 8000,
  });
}

test('开始界面：两个模式按钮都可用', () => {
  render(<App />);
  expect(screen.getByTestId('start-screen')).toBeInTheDocument();
  expect(screen.getByTestId('mode-ai')).toBeEnabled();
  expect(screen.getByTestId('mode-online')).toBeEnabled();
  expect(document.querySelector('#game')).toBeNull();
});

test('人机对战：翻棋 → AI 应招 → 步数累加，认输按钮初期禁用', async () => {
  render(<App />);
  fireEvent.click(screen.getByTestId('mode-ai'));

  await waitMyTurn();
  expect(screen.queryByTestId('start-screen'), '开局后开始界面应当卸载').toBeNull();
  expect(pieces()).toHaveLength(36);
  expect(screen.getByTestId('banner')).toHaveTextContent('轮到你了');
  expect(screen.getByTitle('认输')).toBeDisabled();
  // 执蓝时电脑先手，开局就已经翻了 1 张 —— 这里只要求"最多 1 张"，不假设我永远先手
  expect(revealed().length).toBeLessThanOrEqual(1);

  // 步数从页脚读：AI 可能翻子也可能走子（走子不增加"已翻开"的数量），
  // 所以只有步数是可靠的进度指标
  const steps = () => Number(/已走 (\d+) 步/.exec(document.querySelector('#foot')!.textContent!)![1]);
  const s0 = steps();

  // 玩家翻一张暗子（不能硬编码 0,0：AI 先手时它可能已经被翻开了）
  fireEvent.click(flippableCell());
  await waitFor(() => expect(steps()).toBe(s0 + 1));
  expect(screen.getByTestId('banner')).toHaveTextContent('电脑思考中…');

  // AI 思考 420ms 后应招
  // 8000 而不是 4000：AI 思考是真实计时器（420ms/步），整套测试并行跑满 CPU 时余量不够
  await waitFor(() => expect(screen.getByTestId('banner')).toHaveTextContent('轮到你了'), {
    timeout: 8000,
  });
  await waitFor(() => expect(steps()).toBe(s0 + 2));
  expect(pieces(), '现有 UI 下没有任何棋子会消失').toHaveLength(36);
});

test('终局结分：人机认输 −20，掉级后名牌跟着变', async () => {
  // 归档上一次可能残留的分数，从"禁卫军 100 分"起手
  window.localStorage.setItem('battlechess.rating.v1', JSON.stringify({ points: 100 }));
  render(<App />);
  fireEvent.click(screen.getByTestId('mode-ai'));
  await waitMyTurn();

  const steps = () => Number(/已走 (\d+) 步/.exec(document.querySelector('#foot')!.textContent!)![1]);
  const myPlate = () =>
    [...document.querySelectorAll('.plate')].find((p) => p.querySelector('.plate-id')?.textContent === '玩家')!;
  expect(myPlate().textContent).toContain('禁卫军');
  expect(myPlate().textContent).toContain('100');
  expect(myPlate().querySelectorAll('.plate-star')).toHaveLength(2);

  // 走到能认输（20 步）：每步随便点，只要步数往前走就算数
  for (let turn = 0; turn < 40 && screen.getByTitle('认输').hasAttribute('disabled'); turn++) {
    const before = steps();
    for (const cell of cells()) {
      fireEvent.click(cell);
      if (steps() !== before) break;
    }
    await waitFor(() => expect(screen.getByTestId('banner')).toHaveTextContent('轮到你了'), {
      timeout: 5000,
    });
  }
  expect(screen.getByTitle('认输')).toBeEnabled();

  fireEvent.click(screen.getByTitle('认输'));
  await waitFor(() => expect(screen.getByTestId('banner')).toHaveTextContent('对局结束'));

  // 认输 = 输一局：100 - 20 = 80 分，等级从禁卫军掉回刺客（星级 2 → 1）
  expect(window.localStorage.getItem('battlechess.rating.v1')).toBe(JSON.stringify({ points: 80 }));
  await waitFor(() => expect(myPlate().textContent).toContain('刺客'));
  expect(myPlate().querySelectorAll('.plate-star')).toHaveLength(1);
}, 30000);

test('不是自己回合时，点棋盘不会有任何进展', async () => {
  render(<App />);
  fireEvent.click(screen.getByTestId('mode-ai'));
  await waitMyTurn();

  fireEvent.click(flippableCell());
  await waitFor(() => expect(screen.getByTestId('banner')).toHaveTextContent('电脑思考中…'));

  // 趁着轮到电脑，连点几下：不该有任何 effect（也不能抛错）。
  // 同步比较状态文本 —— 电脑 420ms 后才落子，不能给它插进来的机会。
  const footBefore = document.querySelector('#foot')!.textContent;
  fireEvent.click(screen.getByTestId('cell-1-1'));
  fireEvent.click(screen.getByTestId('cell-2-2'));
  expect(document.querySelector('#foot')!.textContent, '非我回合点棋盘不该有任何进展').toBe(footBefore);
});

test('棋子按 id 复用节点：AI 走完后仍是同一批 DOM 节点（动画才有得放矢）', async () => {
  render(<App />);
  fireEvent.click(screen.getByTestId('mode-ai'));
  await waitMyTurn();

  const before = pieces();
  fireEvent.click(screen.getByTestId('cell-0-0'));
  // 8000 而不是 4000：AI 思考是真实计时器（420ms/步），整套测试并行跑满 CPU 时余量不够
  await waitFor(() => expect(screen.getByTestId('banner')).toHaveTextContent('轮到你了'), {
    timeout: 8000,
  });

  const after = pieces();
  // 用 id 找同一个棋子的节点，必须是同一个对象
  const idOf = (el: Element) => (el as HTMLElement).dataset.pieceId;
  const sampleId = idOf(before[0]!)!;
  const same = after.find((el) => idOf(el) === sampleId)!;
  expect(same).toBe(before[0]);
});

// ── 联机大厅（界面已就绪、传输层未接） ─────────────────────
// 这一组守的是"入口能进、参数能对上、假数据别串味"：
// 房号必须由种子推出来，邀请链接必须带 seed（房主握手会校验它），否则接线那天必踩。

test('联网对战：从开始界面进大厅，创建房间后给出真链接（房号 = 房间种子）', async () => {
  render(<App />);
  fireEvent.click(screen.getByTestId('mode-online'));

  expect(screen.getByTestId('online-lobby')).toHaveAttribute('data-step', 'menu');
  fireEvent.click(screen.getByRole('button', { name: '创建' }));
  expect(screen.getByTestId('online-lobby')).toHaveAttribute('data-step', 'host');

  // 链接是异步来的（要等 peer 起来），先显示"正在创建房间…"
  const link = (await screen.findByTestId('invite-link')) as HTMLInputElement;
  const url = new URL(link.value);
  const seed = url.searchParams.get('seed');
  expect(url.searchParams.get('mode')).toBe('online');
  expect(seed, '邀请链接必须带 seed，否则房主会判"不是这一盘棋"').toBeTruthy();
  expect(url.searchParams.get('host')).toBe(`battlechess-${seed}`);

  // 房号 = 房间种子（四位），和链接里对得上
  const code = String(Number(seed) % 10_000).padStart(4, '0');
  expect(code, '房号必须是四位').toHaveLength(4);
  expect(screen.getByText(new RegExp(`房间号 ${code}`))).toBeInTheDocument();
});

test('加入房间：空输入报错，输入四位房号就真的去连（进"正在连接"那屏）', async () => {
  render(<App />);
  fireEvent.click(screen.getByTestId('mode-online'));
  fireEvent.click(screen.getByRole('button', { name: '加入' }));
  expect(screen.getByTestId('online-lobby')).toHaveAttribute('data-step', 'join');

  fireEvent.click(screen.getByTestId('do-join'));
  expect(screen.getByTestId('join-error')).toHaveTextContent('请粘贴完整邀请链接，或输入 4 位房号');

  fireEvent.change(screen.getByTestId('room-code'), { target: { value: '4821' } });
  fireEvent.click(screen.getByTestId('do-join'));

  await waitFor(() => expect(screen.getByTestId('connecting-screen')).toBeInTheDocument());
  expect(screen.getByTestId('connecting-detail')).toHaveTextContent('4821');
});

test('大厅的返回能回到开始界面', () => {
  render(<App />);
  fireEvent.click(screen.getByTestId('mode-online'));
  fireEvent.click(screen.getByRole('button', { name: /返回开始界面/ }));
  expect(screen.getByTestId('start-screen')).toBeInTheDocument();
  expect(screen.queryByTestId('online-lobby')).toBeNull();
});
