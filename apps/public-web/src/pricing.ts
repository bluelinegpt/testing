export const pricingPlans = [
  {
    name: 'Free',
    price: 'AED 0',
    period: 'per month',
    volume: 'Up to 100 orders / month',
    cta: 'Start with a demo',
    href: '/request-demo',
    highlights: ['Order and driver operations foundation', 'COD and settlement visibility', 'Reports for early-stage teams'],
  },
  {
    name: 'Starter',
    price: 'AED 500',
    period: 'per month',
    volume: '100–2,000 orders / month',
    cta: 'Request Demo',
    href: '/request-demo',
    highlights: ['Daily order management', 'Driver assignment workflows', 'COD collection controls'],
  },
  {
    name: 'Growth',
    price: 'AED 1000',
    period: 'per month',
    volume: '2,001–5,000 orders / month',
    cta: 'Request Demo',
    href: '/request-demo',
    highlights: ['Trader relationship tracking', 'Trader settlement workflows', 'Operational reporting'],
  },
  {
    name: 'Business',
    price: 'AED 2000',
    period: 'per month',
    volume: '5,001–10,000 orders / month',
    cta: 'Request Demo',
    href: '/request-demo',
    highlights: ['Accounting and payroll support', 'Management reporting', 'Platform controls for growing teams'],
  },
] as const;

export const pricingGapNote = 'For more than 10,000 monthly orders, Tawseelhub can confirm a custom commercial tier.';
