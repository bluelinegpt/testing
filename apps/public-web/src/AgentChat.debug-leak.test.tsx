// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for a real customer-visible defect: the chat panel's
 * minimize and close controls rendered as the literal characters "_" and
 * "x" -- unstyled placeholder-looking text sitting right next to the "AR"
 * language toggle, reading as stray debug output ("AR_x") rather than
 * icons. Fixed by rendering proper minus/multiplication-sign glyphs. This
 * test fails again if either control regresses to bare source-looking text.
 */
vi.mock('./agent-client', () => ({
  buildWhatsAppMessageUrl: (url: string) => url,
  createAgentConversation: vi.fn().mockResolvedValue({ conversationId: 'c1', token: 't1', welcomeMessages: [] }),
  fallbackAvatarSettings: { enabled: false, displayName: 'Yousef', titleEn: 'AI Advisor', titleAr: 'مستشار ذكي', introTranscriptEn: 'Hello from Yousef', introTranscriptAr: 'مرحباً من يوسف', showOnHomepage: true, showOnPricing: true, showOnDeliveryCompany: true, showOnTrader: true, showOnSendPackage: true, autoOpen: false, provider: 'prerecorded', status: 'active' },
  fallbackWhatsAppSettings: { enabled: false, label: 'Chat on WhatsApp', number: '', url: null },
  getAgentAvailability: vi.fn().mockResolvedValue({ assistantAvailable: true, humanAvailable: false, status: 'assistant_only' }),
  getAvatarSettings: vi.fn().mockResolvedValue({ enabled: false }),
  getAgentConversation: vi.fn().mockResolvedValue(null),
  getWhatsAppSettings: vi.fn().mockResolvedValue({ enabled: false, url: null }),
  sendAgentMessage: vi.fn(),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Agent chat panel controls', () => {
  it('never renders the minimize/close controls as bare "_" or "x" text', async () => {
    vi.useFakeTimers();
    const { AgentChat } = await import('./AgentChat');
    render(<AgentChat />);
    await act(async () => { vi.advanceTimersByTime(700); });
    await act(async () => { window.dispatchEvent(new CustomEvent('tawseelhub:open-agent')); });

    const minimize = screen.getByRole('button', { name: 'Minimize chat' });
    const close = screen.getByRole('button', { name: 'Close chat' });
    expect(minimize.textContent?.trim()).not.toBe('_');
    expect(close.textContent?.trim()).not.toBe('x');
    // The visible glyphs are proper icon characters, not source-looking placeholders.
    expect(minimize.textContent).toContain('−');
    expect(close.textContent).toContain('×');
  });
});
