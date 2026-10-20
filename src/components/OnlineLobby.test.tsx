// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { OnlineLobby, type OnlineLobbyProps } from './OnlineLobby';

const invite = { code: '4821', link: 'https://wu.dev/game/?mode=online&host=battlechess-4821' };

function setup(over: Partial<OnlineLobbyProps> = {}) {
  const props: OnlineLobbyProps = {
    step: 'menu',
    invite,
    joinError: null,
    onHost: vi.fn(),
    onShowJoin: vi.fn(),
    onJoin: vi.fn(),
    onMenu: vi.fn(),
    onExit: vi.fn(),
    ...over,
  };
  render(<OnlineLobby {...props} />);
  return props;
}

/** jsdom 没有剪贴板，按需装一个能成功/失败的桩 */
function stubClipboard(impl: 'ok' | 'deny') {
  const writeText = vi.fn(() => (impl === 'ok' ? Promise.resolve() : Promise.reject(new Error('denied'))));
  const readText = vi.fn(() => (impl === 'ok' ? Promise.resolve(invite.link) : Promise.reject(new Error('denied'))));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText, readText }, configurable: true });
  return { writeText, readText };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
});

test('① 中间页：标题与两枚按钮，点创建/加入各自回调', () => {
  const p = setup();
  expect(screen.getByTestId('online-lobby')).toHaveAttribute('data-step', 'menu');
  expect(screen.getByRole('heading')).toHaveTextContent('联机对战');

  fireEvent.click(screen.getByRole('button', { name: '创建' }));
  expect(p.onHost).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: '加入' }));
  expect(p.onShowJoin).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: /返回开始界面/ }));
  expect(p.onExit).toHaveBeenCalledTimes(1);
  expect(p.onJoin).not.toHaveBeenCalled();
});

test('② 房主邀请：房号、链接都在，复制走剪贴板并给提示', async () => {
  const clip = stubClipboard('ok');
  const p = setup({ step: 'host' });

  expect(screen.getByRole('heading')).toHaveTextContent('房间已创建');
  expect(screen.getByText(/4821/)).toBeInTheDocument();
  expect(screen.getByTestId('invite-link')).toHaveValue(invite.link);

  fireEvent.click(screen.getByTestId('copy-link'));
  expect(await screen.findByTestId('copy-hint')).toHaveTextContent('已复制');
  expect(clip.writeText).toHaveBeenCalledWith(invite.link);

  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(p.onMenu).toHaveBeenCalledTimes(1);
});

test('② 剪贴板被拒：不抛错，提示手动复制，并把链接选中', async () => {
  stubClipboard('deny');
  setup({ step: 'host' });

  const link = screen.getByTestId('invite-link') as HTMLInputElement;
  fireEvent.click(screen.getByTestId('copy-link'));
  expect(await screen.findByTestId('copy-hint')).toHaveTextContent('手动');

  // select() 之后 selectionEnd 会落在链接末尾，说明整条被选中了
  expect(link.selectionEnd).toBe(link.value.length);
});

test('③ 加入：输入 → 加入把**原始输入**交给上层解析（解析只有一处）', () => {
  const p = setup({ step: 'join' });
  expect(screen.getByRole('heading')).toHaveTextContent('加入房间');

  const input = screen.getByTestId('room-code');
  fireEvent.change(input, { target: { value: '4821' } });
  fireEvent.click(screen.getByTestId('do-join'));
  expect(p.onJoin).toHaveBeenCalledWith('4821');

  // 回车等价于点「加入」
  fireEvent.change(input, { target: { value: '1234' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(p.onJoin).toHaveBeenLastCalledWith('1234');
});

test('③ 粘贴：从剪贴板读整条链接填进输入框', async () => {
  stubClipboard('ok');
  setup({ step: 'join' });

  fireEvent.click(screen.getByTestId('paste-link'));
  expect(await screen.findByTestId('room-code')).toHaveValue(invite.link);
});

test('③ 粘贴被拒：吞掉异常，只是把焦点给输入框', async () => {
  stubClipboard('deny');
  setup({ step: 'join' });

  const input = screen.getByTestId('room-code');
  fireEvent.click(screen.getByTestId('paste-link'));
  await Promise.resolve();
  expect(input).toHaveValue('');
  expect(document.activeElement).toBe(input);
});

test('③ 错误行：有错才带 role=alert，没错时也占着位置（不跳版）', () => {
  const { unmount } = render(
    <OnlineLobby
      step="join"
      invite={null}
      joinError="房间不存在，或房主已经关闭了这个房间"
      onHost={() => {}}
      onShowJoin={() => {}}
      onJoin={() => {}}
      onMenu={() => {}}
      onExit={() => {}}
    />,
  );
  const err = screen.getByTestId('join-error');
  expect(err).toHaveTextContent('房间不存在');
  expect(err).toHaveAttribute('role', 'alert');
  unmount();

  setup({ step: 'join', joinError: null });
  const quiet = screen.getByTestId('join-error');
  expect(quiet).toHaveTextContent('');
  expect(quiet).not.toHaveAttribute('role');
});

test('② 中继状态：有中继说"跨网络能连"，没有就直说只能同网段', () => {
  setup({ step: 'host', relay: { relay: true } });
  const ok = screen.getByTestId('relay-status');
  expect(ok).toHaveTextContent('中继已就绪');
  expect(ok.className).not.toContain('lobby-relay-warn');
});

test('② 中继状态：没配中继时是警告样式（这一行是"连不上"的第一现场）', () => {
  setup({ step: 'host', relay: { relay: false } });
  const warn = screen.getByTestId('relay-status');
  expect(warn).toHaveTextContent('只能同一个网络');
  expect(warn.className).toContain('lobby-relay-warn');
});
