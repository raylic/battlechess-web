import '@testing-library/jest-dom/vitest';

import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// globals 关掉了（测试里显式 import），所以 RTL 的自动 cleanup 要自己接上
afterEach(() => {
  cleanup();
});

// 默认等 1000ms 太紧：人机测试里 AI 思考是**真实计时器**（420ms/步），
// 整套测试并行跑满 CPU 时，一次点击 + 状态更新 + 轮次切换很容易超过 1 秒，
// 于是"等步数 +1"这种断言会偶发红灯（和代码无关）。放宽到 4 秒，只影响等待上限。
configure({ asyncUtilTimeout: 4000 });
