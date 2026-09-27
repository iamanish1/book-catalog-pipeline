/** Language code normalization to ISO 639-1 where one exists (else the 3-letter code). */
const MAP: Record<string, string> = {
  eng: 'en', en: 'en', english: 'en',
  hin: 'hi', hi: 'hi', hindi: 'hi',
  ben: 'bn', bn: 'bn', bengali: 'bn', bangla: 'bn',
  tam: 'ta', ta: 'ta', tamil: 'ta',
  tel: 'te', te: 'te', telugu: 'te',
  mar: 'mr', mr: 'mr', marathi: 'mr',
  guj: 'gu', gu: 'gu', gujarati: 'gu',
  kan: 'kn', kn: 'kn', kannada: 'kn',
  mal: 'ml', ml: 'ml', malayalam: 'ml',
  pan: 'pa', pa: 'pa', punjabi: 'pa',
  urd: 'ur', ur: 'ur', urdu: 'ur',
  san: 'sa', sa: 'sa', sanskrit: 'sa',
  ori: 'or', ory: 'or', or: 'or', odia: 'or',
  asm: 'as', as: 'as', assamese: 'as',
  fre: 'fr', fra: 'fr', fr: 'fr', french: 'fr',
  ger: 'de', deu: 'de', de: 'de', german: 'de',
  spa: 'es', es: 'es', spanish: 'es',
  ita: 'it', it: 'it', italian: 'it',
  por: 'pt', pt: 'pt', portuguese: 'pt',
  rus: 'ru', ru: 'ru', russian: 'ru',
  jpn: 'ja', ja: 'ja', japanese: 'ja',
  chi: 'zh', zho: 'zh', zh: 'zh', chinese: 'zh',
  ara: 'ar', ar: 'ar', arabic: 'ar',
  dut: 'nl', nld: 'nl', nl: 'nl', dutch: 'nl',
  swe: 'sv', sv: 'sv', pol: 'pl', pl: 'pl', tur: 'tr', tr: 'tr', kor: 'ko', ko: 'ko',
  gre: 'el', ell: 'el', el: 'el', heb: 'he', he: 'he', nep: 'ne', ne: 'ne',
};

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', hi: 'Hindi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', mr: 'Marathi', gu: 'Gujarati',
  kn: 'Kannada', ml: 'Malayalam', pa: 'Punjabi', ur: 'Urdu', sa: 'Sanskrit', or: 'Odia', as: 'Assamese',
  fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese',
  zh: 'Chinese', ar: 'Arabic', nl: 'Dutch', ne: 'Nepali',
};

/** Accepts "eng", "/languages/eng", "en", "en-GB", "English". */
export function normalizeLanguage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/^\/languages\//, '').split(/[-_]/)[0]!;
  if (!s) return null;
  return MAP[s] ?? (/^[a-z]{2,3}$/.test(s) ? s : null);
}
