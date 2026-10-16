// 在条件允许时把屏幕锁成横屏。
//
// 这只是"补一刀"，不是主手段 —— 真正兜底的是 styles.css 里那层竖屏遮罩：
//   · manifest 的 orientation:landscape 只在"装到主屏 / 独立窗口"后生效；
//   · screen.orientation.lock() 需要全屏或独立窗口，且 iOS Safari 根本没实现这个方法。
// 所以这里全程静默失败：锁不上完全不影响游戏，遮罩会提示用户自己把手机转过来。

export function lockLandscape(): void {
  const orientation = screen.orientation;
  // iOS Safari 没有 lock；有些老浏览器连 screen.orientation 都没有
  if (typeof orientation?.lock !== 'function') return;

  const attempt = (): void => {
    // Chrome 要求"用户手势"才允许锁屏方向：页面加载时直接调多半被拒，
    // 所以首次交互（pointerdown，鼠标/触摸都覆盖）之后再试一次。
    // 失败就失败 —— 拒绝的 Promise 必须吞掉，否则控制台里全是未处理拒绝。
    void orientation.lock('landscape').catch(() => {});
  };

  attempt();
  window.addEventListener('pointerdown', attempt, { once: true });
}
