export const companyCurrencies = [
  "AED", "SAR", "QAR", "USD", "EUR", "GBP", "KWD", "BHD", "OMR", "JOD",
  "EGP", "SYP", "LBP", "IQD", "YER", "MAD", "DZD", "TND", "LYD", "SDG",
  "SOS", "DJF", "KMF", "MRU",
] as const;

export type CompanyCurrency = (typeof companyCurrencies)[number];
