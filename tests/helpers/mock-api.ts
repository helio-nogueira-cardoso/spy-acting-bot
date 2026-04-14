import { vi } from 'vitest';

export function createMockApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 1 }),
    getFile: vi.fn().mockResolvedValue({ file_path: '/tmp/test.jpg' }),
    getMe: vi.fn().mockResolvedValue({ username: 'TestBot', first_name: 'Test' }),
  } as any;
}
