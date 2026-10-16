import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// globals 关掉了（测试里显式 import），所以 RTL 的自动 cleanup 要自己接上
afterEach(() => {
  cleanup();
});
