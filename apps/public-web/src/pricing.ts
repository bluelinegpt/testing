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
    price: 'AED 100',
    period: 'per month',
    volume: '101–1,000 orders / month',
    cta: 'Request Demo',
    href: '/request-demo',
    highlights: ['Daily order management', 'Driver assignment workflows', 'COD collection controls'],
  },
  {
    name: 'Growth',
    price: 'AED 200',
    period: 'per month',
    volume: '1,001–3,000 orders / month',
    cta: 'Request Demo',
    href: '/request-demo',
    highlights: ['Trader relationship tracking', 'Trader settlement workflows', 'Operational reporting'],
  },
  {
    name: 'Business',
    price: 'AED 500',
    period: 'per month',
    volume: '3,001–5,000 orders / month',
    cta: 'Request Demo',
    href: '/request-demo',
    highlights: ['Accounting and payroll support', 'Management reporting', 'Platform controls for growing teams'],
  },
  {
    name: 'Scale',
    price: 'AED 750',
    period: 'per month',
    volume: 'Above 10,000 orders / month',
    cta: 'Contact Us',
    href: '/contact',
    highlights: ['High-volume operations', 'Advanced operational review', 'Commerce integration readiness'],
  },
] as const;

export const pricingGapNote = 'For 5,001–10,000 monthly orders, Tawseelhub should confirm the commercial tier before publishing a fixed price.';
