/** ISO-4217 currency validation and price-string parsing. Never converts currencies. */

// Active ISO-4217 alphabetic codes.
export const ISO_4217 = new Set(
  `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD
CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF
GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP
LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB
PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL
THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG`
    .split(/\s+/)
    .filter(Boolean),
);

export function isValidCurrency(code: unknown): code is string {
  return typeof code === 'string' && ISO_4217.has(code);
}

// Unambiguous markers only. A bare "$" is ambiguous and needs an explicit default currency.
const MARKERS: Array<[RegExp, string]> = [
  [/₹|\bRs\.?(?=\s|\d)|\bINR\b/i, 'INR'],
  [/US\$|\bUSD\b/i, 'USD'],
  [/A\$|\bAUD\b/i, 'AUD'],
  [/C\$|CA\$|\bCAD\b/i, 'CAD'],
  [/€|\bEUR\b/i, 'EUR'],
  [/£|\bGBP\b/i, 'GBP'],
  [/¥|\bJPY\b/i, 'JPY'],
];

export interface ParsedPrice {
  amount: number;
  currency: string;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Parse "₹499", "Rs. 1,299.00", "INR 499", or "$12.99" (only with defaultCurrency).
 * Returns null when either amount or currency cannot be determined reliably.
 */
export function parsePrice(raw: string | number | null | undefined, defaultCurrency?: string): ParsedPrice | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    return defaultCurrency && isValidCurrency(defaultCurrency) && Number.isFinite(raw) && raw >= 0
      ? { amount: round2(raw), currency: defaultCurrency }
      : null;
  }
  const s = raw.trim();
  let currency: string | null = null;
  for (const [re, code] of MARKERS) {
    if (re.test(s)) {
      currency = code;
      break;
    }
  }
  if (!currency) {
    const code = s.match(/\b([A-Z]{3})\b/)?.[1];
    if (code && isValidCurrency(code)) currency = code;
  }
  if (!currency && defaultCurrency && isValidCurrency(defaultCurrency)) currency = defaultCurrency;
  if (!currency) return null;
  if (/(^|[\s(:])-\s*[^\d\s]{0,4}\s*\d/.test(s)) return null; // negative amounts ("-₹10", "INR -5") are never valid prices
  const num = s.match(/\d[\d,]*(?:\.\d+)?/)?.[0];
  if (!num) return null;
  const amount = Number(num.replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount < 0) return null;
  return { amount: round2(amount), currency };
}
