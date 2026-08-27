// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { CustomerQuoteFlow } from './CustomerQuoteFlow';
import { publicLocaleStorageKey } from './public-localization';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

function renderArabicQuoteFlow() {
  localStorage.setItem(publicLocaleStorageKey, 'ar');
  render(
    <MemoryRouter>
      <CustomerQuoteFlow />
    </MemoryRouter>,
  );
}

describe('Send a Package Arabic validation', () => {
  it('shows visible Arabic field-level errors for missing required shipment information', () => {
    renderArabicQuoteFlow();

    fireEvent.change(screen.getByLabelText(/دولة الاستلام/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/دولة التوصيل/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/الوزن التقريبي/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'احصل على عرض توصيل' }));

    // Verify separate delivery country and city validation (not combined address validation)
    expect(screen.getByText('يرجى اختيار دولة الاستلام.')).toBeVisible();
    expect(screen.getByText('يرجى اختيار دولة التوصيل.')).toBeVisible();
    expect(screen.getByText('يرجى إدخال وزن الشحنة أكبر من صفر.')).toBeVisible();
    expect(screen.getByText('يرجى إدخال مدينة التوصيل.')).toBeVisible();
    expect(screen.queryByText(/pickupCountryCode|deliveryCountryCode|weightKg/)).not.toBeInTheDocument();
  });
});
