'use client';
import { useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';

export interface Country {
  name: string;
  iso: string; // ISO-3166 alpha-2, used to derive the flag emoji
  dial: string; // calling code, digits only
}

// Curated list — Lebanon first (the ~98% default), then the common recipient
// countries (Gulf, Levant, major EU/NA, etc.). The flag is derived from the ISO
// code, so adding a country is just one row here.
export const COUNTRIES: Country[] = [
  { name: 'Lebanon', iso: 'LB', dial: '961' },
  { name: 'United Arab Emirates', iso: 'AE', dial: '971' },
  { name: 'Saudi Arabia', iso: 'SA', dial: '966' },
  { name: 'Qatar', iso: 'QA', dial: '974' },
  { name: 'Kuwait', iso: 'KW', dial: '965' },
  { name: 'Bahrain', iso: 'BH', dial: '973' },
  { name: 'Oman', iso: 'OM', dial: '968' },
  { name: 'Jordan', iso: 'JO', dial: '962' },
  { name: 'Syria', iso: 'SY', dial: '963' },
  { name: 'Iraq', iso: 'IQ', dial: '964' },
  { name: 'Egypt', iso: 'EG', dial: '20' },
  { name: 'Turkey', iso: 'TR', dial: '90' },
  { name: 'United States', iso: 'US', dial: '1' },
  { name: 'Canada', iso: 'CA', dial: '1' },
  { name: 'United Kingdom', iso: 'GB', dial: '44' },
  { name: 'France', iso: 'FR', dial: '33' },
  { name: 'Germany', iso: 'DE', dial: '49' },
  { name: 'Italy', iso: 'IT', dial: '39' },
  { name: 'Spain', iso: 'ES', dial: '34' },
  { name: 'Netherlands', iso: 'NL', dial: '31' },
  { name: 'Belgium', iso: 'BE', dial: '32' },
  { name: 'Switzerland', iso: 'CH', dial: '41' },
  { name: 'Sweden', iso: 'SE', dial: '46' },
  { name: 'Greece', iso: 'GR', dial: '30' },
  { name: 'Cyprus', iso: 'CY', dial: '357' },
  { name: 'Australia', iso: 'AU', dial: '61' },
  { name: 'India', iso: 'IN', dial: '91' },
  { name: 'Nigeria', iso: 'NG', dial: '234' },
  { name: 'Brazil', iso: 'BR', dial: '55' },
];

const DEFAULT_COUNTRY = COUNTRIES[0]; // Lebanon

// Longest dial-code first so e.g. +961 wins over +96 — important for prefix matching.
const BY_DIAL_DESC = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);

function flagEmoji(iso: string): string {
  return iso.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

/** Split a stored phone string into a selected country + the national digits. */
function parse(value: string): { country: Country; national: string } {
  const digits = value.replace(/\D/g, '');
  if (value.trim().startsWith('+')) {
    const match = BY_DIAL_DESC.find((c) => digits.startsWith(c.dial));
    if (match) return { country: match, national: digits.slice(match.dial.length) };
  }
  // No country code (legacy local number, or empty) → show under the default country.
  return { country: DEFAULT_COUNTRY, national: digits };
}

/** Compose E.164 (`+<dial><national>`); empty national → empty string (so it stays optional/invalid-empty). */
function compose(country: Country, national: string): string {
  const digits = national.replace(/\D/g, '');
  return digits ? `+${country.dial}${digits}` : '';
}

/**
 * Phone input with a country selector (default Lebanon 🇱🇧 +961). Controlled: holds
 * an E.164 string in `value` and calls `onChange` with the recomposed E.164 on any
 * edit. Pasting a full `+<code>…` number into the national field auto-detects the
 * country. The transfer service strips the `+` to a bare msisdn before sending.
 */
export function PhoneInput({
  value,
  onChange,
  id,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  className?: string;
}) {
  const { country, national } = useMemo(() => parse(value), [value]);

  return (
    <div className={cn('flex gap-2', className)}>
      <select
        aria-label="Country code"
        className="h-9 shrink-0 rounded-md border border-input bg-background px-2 text-sm"
        value={country.iso}
        onChange={(e) => {
          const next = COUNTRIES.find((c) => c.iso === e.target.value) ?? DEFAULT_COUNTRY;
          onChange(compose(next, national));
        }}
      >
        {COUNTRIES.map((c) => (
          <option key={c.iso} value={c.iso}>
            {flagEmoji(c.iso)} +{c.dial} {c.name}
          </option>
        ))}
      </select>
      <Input
        id={id}
        inputMode="tel"
        autoComplete="tel-national"
        placeholder={placeholder ?? 'Phone number'}
        value={national}
        onChange={(e) => {
          const raw = e.target.value;
          // Pasting a full international number (with +) re-detects the country.
          if (raw.trim().startsWith('+')) {
            const p = parse(raw);
            onChange(compose(p.country, p.national));
          } else {
            onChange(compose(country, raw));
          }
        }}
      />
    </div>
  );
}
