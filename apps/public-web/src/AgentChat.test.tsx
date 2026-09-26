import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderAgentMessageLine } from './AgentChat';

describe('AgentChat message rendering', () => {
  it('renders plain URL text as a clickable safe link', () => {
    const parts = renderAgentMessageLine('أسعار استخدام نظام Tawseelhub موجودة هنا: https://tawseelhub.com/pricing');
    const link = parts.find((part) => isValidElement(part));

    expect(isValidElement(link)).toBe(true);
    expect(link?.props).toMatchObject({
      children: 'https://tawseelhub.com/pricing',
      href: 'https://tawseelhub.com/pricing',
      rel: 'noreferrer',
      target: '_blank',
    });
  });
});
