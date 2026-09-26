import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentConversation, getAgentAvailability, recordAgentOpened, sendAgentMessage } from './agent-client';

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
    await recordAgentOpened('token-1', '7c14b7c5-245f-4bab-810c-2b380b4a8500');
    await sendAgentMessage('token-1', 'Send a Package', 'en', '9c14b7c5-245f-4bab-810c-2b380b4a8501');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/public/agent/conversations', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ language: 'en', surface: 'website' });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/public/agent/conversations/token-1/events/opened', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/v1/public/agent/conversations/token-1/messages', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toMatchObject({ inboundMessageId: '9c14b7c5-245f-4bab-810c-2b380b4a8501' });
  });

  it('marks avatar conversations without changing the conversation API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ conversationToken: 'token-avatar' }), ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await createAgentConversation('ar', 'visitor-1', 'website_avatar', { landingPage: '/ar', sourceHostname: 'tawseelhub.com', sourcePage: '/ar/pricing', utmCampaign: 'launch' });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ landingPage: '/ar', language: 'ar', sourceHostname: 'tawseelhub.com', sourcePage: '/ar/pricing', surface: 'website_avatar', utmCampaign: 'launch', visitorId: 'visitor-1' });
  });

  it('loads public human support availability without exposing private settings', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ assistantAvailable: true, humanAvailable: true, status: 'available' }),
      ok: true,
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAgentAvailability()).resolves.toEqual({ assistantAvailable: true, humanAvailable: true, status: 'available' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/public/agent/availability', expect.objectContaining({ method: 'GET' }));
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
