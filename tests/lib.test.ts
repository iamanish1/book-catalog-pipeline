import { describe, expect, it } from 'vitest';
import { isValidCurrency, parsePrice } from '../src/lib/currency.js';
import { isbn10To13, isbn13To10, isValidIsbn10, isValidIsbn13, resolveIsbns, toIsbn13 } from '../src/lib/isbn.js';
import { normalizeLanguage } from '../src/lib/language.js';
import { authorKey, cleanDescription, normalizeAuthorName, parseYear, shortDescription, splitTitle, titleKey } from '../src/lib/text.js';

describe('ISBN', () => {
  it('validates checksums', () => {
    expect(isValidIsbn13('9780857197689')).toBe(true);
    expect(isValidIsbn13('978-0-85719-768-9')).toBe(true);
    expect(isValidIsbn13('9780857197680')).toBe(false);
    expect(isValidIsbn10('0857197681')).toBe(true);
    expect(isValidIsbn10('080442957X')).toBe(true);
    expect(isValidIsbn10('0857197682')).toBe(false);
  });

  it('converts between ISBN-10 and ISBN-13 without inventing values', () => {
    expect(isbn10To13('0857197681')).toBe('9780857197689');
    expect(isbn13To10('9780857197689')).toBe('0857197681');
    expect(isbn13To10('9798602477429')).toBeNull(); // 979 prefix has no ISBN-10
    expect(isbn10To13('0857197682')).toBeNull();
    expect(toIsbn13('0-85719-768-1')).toBe('9780857197689');
    expect(toIsbn13('garbage')).toBeNull();
  });

  it('resolves an edition ISBN pair and reports invalid values', () => {
    const r = resolveIsbns(['0857197681', '12345'], ['9780857197689', '9781804090114']);
    expect(r.isbn_13).toBe('9780857197689');
    expect(r.isbn_10).toBe('0857197681');
    expect(r.invalid).toEqual(['12345']);
    expect(r.extra13).toEqual(['9781804090114']);
  });
});

describe('text normalization', () => {
  it('matches titles regardless of subtitle, case, punctuation and leading article', () => {
    expect(titleKey('The Psychology of Money')).toBe('psychology of money');
    expect(titleKey('The Psychology of Money: Timeless lessons on wealth, greed, and happiness')).toBe('psychology of money');
    expect(titleKey('Harry Potter and the Philosopher’s Stone (Harry Potter, #1)')).toBe('harry potter and the philosophers stone');
    expect(splitTitle('Sapiens - A Brief History of Humankind')).toEqual({ title: 'Sapiens', subtitle: 'A Brief History of Humankind' });
  });

  it('normalizes author formatting', () => {
    expect(normalizeAuthorName('Rowling, J.K.')).toBe('J. K. Rowling');
    expect(authorKey('J.K. Rowling')).toBe('rowling j');
    expect(authorKey('Rowling, J. K.')).toBe('rowling j');
    expect(authorKey('Joanne K. Rowling')).toBe('rowling j');
    expect(authorKey('Gabriel García Márquez')).toBe('marquez g');
  });

  it('cleans HTML, entities and Open Library markdown from descriptions', () => {
    const d = cleanDescription('<p>Doing well with money isn&rsquo;t about <b>what</b> you know.</p><br>It&#39;s how you behave. ([source][1])\n\n----------\n**See also**\n[1]: https://example.com');
    expect(d).toBe('Doing well with money isn’t about what you know.\nIt\'s how you behave.');
    expect(cleanDescription('<p> </p>')).toBeNull();
  });

  it('builds a short description from whole sentences only', () => {
    const long = 'First sentence is here. '.repeat(30);
    const s = shortDescription(long, 100)!;
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.endsWith('.')).toBe(true);
  });

  it('parses years from free-form dates', () => {
    expect(parseYear('September 8, 2020')).toBe(2020);
    expect(parseYear('06/30/2025')).toBe(2025);
    expect(parseYear('n.d.')).toBeNull();
  });

  it('normalizes language codes', () => {
    expect(normalizeLanguage('/languages/eng')).toBe('en');
    expect(normalizeLanguage('hin')).toBe('hi');
    expect(normalizeLanguage('en-GB')).toBe('en');
    expect(normalizeLanguage('Tamil')).toBe('ta');
  });
});

describe('price parsing', () => {
  it('normalizes rupee strings to ISO-4217', () => {
    expect(parsePrice('₹499')).toEqual({ amount: 499, currency: 'INR' });
    expect(parsePrice('Rs. 1,299.00')).toEqual({ amount: 1299, currency: 'INR' });
    expect(parsePrice('INR 350')).toEqual({ amount: 350, currency: 'INR' });
    expect(parsePrice('£12.99')).toEqual({ amount: 12.99, currency: 'GBP' });
  });

  it('refuses ambiguous or invalid prices', () => {
    expect(parsePrice('$12.99')).toBeNull(); // ambiguous symbol without a default
    expect(parsePrice('$12.99', 'USD')).toEqual({ amount: 12.99, currency: 'USD' });
    expect(parsePrice('-₹10')).toBeNull();
    expect(parsePrice('free')).toBeNull();
    expect(isValidCurrency('INR')).toBe(true);
    expect(isValidCurrency('RUPEES')).toBe(false);
  });
});
