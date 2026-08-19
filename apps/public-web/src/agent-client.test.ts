import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentConversation, sendAgentMessage } from './agent-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agent client', () => {
  it('uses the public Agent Core routes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ conversationToken: 'token-1', language: 'en', reference: 'AGT-000001' }),
      ok: true,
    });
    vi.stubGlobal('fetch', fetchMock);

    await createAgentConversation('en');
    await sendAgentMessage('token-1', 'Send a Package', 'en');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/public/agent/conversations', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/public/agent/conversations/token-1/messages', expect.objectContaining({ method: 'POST' }));
  });

  it('replaces raw backend route errors with a visitor-safe message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ message: 'Cannot POST /api/v1/public/agent/conversations' }),
      ok: false,
    }));

    await expect(createAgentConversation('en')).rejects.toThrow("I'm having trouble connecting right now. Please try again, or choose Contact Tawseelhub.");
    await expect(createAgentConversation('en')).rejects.not.toThrow(/Cannot POST/);
  });
});
