'use client';
import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';

export interface Country {
  name: string;
  iso: string; // ISO-3166 alpha-2, used to derive the flag emoji
  dial: string; // calling code, digits only
  // National-number length range for inline validation (set both equal for a single
  // exact length). Omit both → the general 6–15 rule.
  minDigits?: number;
  maxDigits?: number;
}

// Lebanon first (the ~98% default); the rest alphabetical. The flag is derived
// from the ISO code, so adding/adjusting a country is just one row here.
export const COUNTRIES: Country[] = [
  { name: 'Lebanon', iso: 'LB', dial: '961', minDigits: 7, maxDigits: 8 },
  { name: 'Afghanistan', iso: 'AF', dial: '93' },
  { name: 'Albania', iso: 'AL', dial: '355' },
  { name: 'Algeria', iso: 'DZ', dial: '213' },
  { name: 'Andorra', iso: 'AD', dial: '376' },
  { name: 'Angola', iso: 'AO', dial: '244' },
  { name: 'Argentina', iso: 'AR', dial: '54' },
  { name: 'Armenia', iso: 'AM', dial: '374' },
  { name: 'Australia', iso: 'AU', dial: '61' },
  { name: 'Austria', iso: 'AT', dial: '43' },
  { name: 'Azerbaijan', iso: 'AZ', dial: '994' },
  { name: 'Bahamas', iso: 'BS', dial: '1242' },
  { name: 'Bahrain', iso: 'BH', dial: '973' },
  { name: 'Bangladesh', iso: 'BD', dial: '880' },
  { name: 'Barbados', iso: 'BB', dial: '1246' },
  { name: 'Belarus', iso: 'BY', dial: '375' },
  { name: 'Belgium', iso: 'BE', dial: '32' },
  { name: 'Belize', iso: 'BZ', dial: '501' },
  { name: 'Benin', iso: 'BJ', dial: '229' },
  { name: 'Bhutan', iso: 'BT', dial: '975' },
  { name: 'Bolivia', iso: 'BO', dial: '591' },
  { name: 'Bosnia and Herzegovina', iso: 'BA', dial: '387' },
  { name: 'Botswana', iso: 'BW', dial: '267' },
  { name: 'Brazil', iso: 'BR', dial: '55' },
  { name: 'Brunei', iso: 'BN', dial: '673' },
  { name: 'Bulgaria', iso: 'BG', dial: '359' },
  { name: 'Burkina Faso', iso: 'BF', dial: '226' },
  { name: 'Burundi', iso: 'BI', dial: '257' },
  { name: 'Cambodia', iso: 'KH', dial: '855' },
  { name: 'Cameroon', iso: 'CM', dial: '237' },
  { name: 'Canada', iso: 'CA', dial: '1' },
  { name: 'Cape Verde', iso: 'CV', dial: '238' },
  { name: 'Central African Republic', iso: 'CF', dial: '236' },
  { name: 'Chad', iso: 'TD', dial: '235' },
  { name: 'Chile', iso: 'CL', dial: '56' },
  { name: 'China', iso: 'CN', dial: '86' },
  { name: 'Colombia', iso: 'CO', dial: '57' },
  { name: 'Comoros', iso: 'KM', dial: '269' },
  { name: 'Congo (Brazzaville)', iso: 'CG', dial: '242' },
  { name: 'Congo (Kinshasa)', iso: 'CD', dial: '243' },
  { name: 'Costa Rica', iso: 'CR', dial: '506' },
  { name: 'Côte d’Ivoire', iso: 'CI', dial: '225' },
  { name: 'Croatia', iso: 'HR', dial: '385' },
  { name: 'Cuba', iso: 'CU', dial: '53' },
  { name: 'Cyprus', iso: 'CY', dial: '357' },
  { name: 'Czech Republic', iso: 'CZ', dial: '420' },
  { name: 'Denmark', iso: 'DK', dial: '45' },
  { name: 'Djibouti', iso: 'DJ', dial: '253' },
  { name: 'Dominican Republic', iso: 'DO', dial: '1809' },
  { name: 'Ecuador', iso: 'EC', dial: '593' },
  { name: 'Egypt', iso: 'EG', dial: '20' },
  { name: 'El Salvador', iso: 'SV', dial: '503' },
  { name: 'Estonia', iso: 'EE', dial: '372' },
  { name: 'Eswatini', iso: 'SZ', dial: '268' },
  { name: 'Ethiopia', iso: 'ET', dial: '251' },
  { name: 'Finland', iso: 'FI', dial: '358' },
  { name: 'France', iso: 'FR', dial: '33' },
  { name: 'Gabon', iso: 'GA', dial: '241' },
  { name: 'Gambia', iso: 'GM', dial: '220' },
  { name: 'Georgia', iso: 'GE', dial: '995' },
  { name: 'Germany', iso: 'DE', dial: '49' },
  { name: 'Ghana', iso: 'GH', dial: '233' },
  { name: 'Greece', iso: 'GR', dial: '30' },
  { name: 'Guatemala', iso: 'GT', dial: '502' },
  { name: 'Guinea', iso: 'GN', dial: '224' },
  { name: 'Guyana', iso: 'GY', dial: '592' },
  { name: 'Haiti', iso: 'HT', dial: '509' },
  { name: 'Honduras', iso: 'HN', dial: '504' },
  { name: 'Hong Kong', iso: 'HK', dial: '852' },
  { name: 'Hungary', iso: 'HU', dial: '36' },
  { name: 'Iceland', iso: 'IS', dial: '354' },
  { name: 'India', iso: 'IN', dial: '91' },
  { name: 'Indonesia', iso: 'ID', dial: '62' },
  { name: 'Iran', iso: 'IR', dial: '98' },
  { name: 'Iraq', iso: 'IQ', dial: '964' },
  { name: 'Ireland', iso: 'IE', dial: '353' },
  { name: 'Israel', iso: 'IL', dial: '972' },
  { name: 'Italy', iso: 'IT', dial: '39' },
  { name: 'Jamaica', iso: 'JM', dial: '1876' },
  { name: 'Japan', iso: 'JP', dial: '81' },
  { name: 'Jordan', iso: 'JO', dial: '962' },
  { name: 'Kazakhstan', iso: 'KZ', dial: '7' },
  { name: 'Kenya', iso: 'KE', dial: '254' },
  { name: 'Kuwait', iso: 'KW', dial: '965' },
  { name: 'Kyrgyzstan', iso: 'KG', dial: '996' },
  { name: 'Laos', iso: 'LA', dial: '856' },
  { name: 'Latvia', iso: 'LV', dial: '371' },
  { name: 'Lesotho', iso: 'LS', dial: '266' },
  { name: 'Liberia', iso: 'LR', dial: '231' },
  { name: 'Libya', iso: 'LY', dial: '218' },
  { name: 'Liechtenstein', iso: 'LI', dial: '423' },
  { name: 'Lithuania', iso: 'LT', dial: '370' },
  { name: 'Luxembourg', iso: 'LU', dial: '352' },
  { name: 'Macau', iso: 'MO', dial: '853' },
  { name: 'Madagascar', iso: 'MG', dial: '261' },
  { name: 'Malawi', iso: 'MW', dial: '265' },
  { name: 'Malaysia', iso: 'MY', dial: '60' },
  { name: 'Maldives', iso: 'MV', dial: '960' },
  { name: 'Mali', iso: 'ML', dial: '223' },
  { name: 'Malta', iso: 'MT', dial: '356' },
  { name: 'Mauritania', iso: 'MR', dial: '222' },
  { name: 'Mauritius', iso: 'MU', dial: '230' },
  { name: 'Mexico', iso: 'MX', dial: '52' },
  { name: 'Moldova', iso: 'MD', dial: '373' },
  { name: 'Monaco', iso: 'MC', dial: '377' },
  { name: 'Mongolia', iso: 'MN', dial: '976' },
  { name: 'Montenegro', iso: 'ME', dial: '382' },
  { name: 'Morocco', iso: 'MA', dial: '212' },
  { name: 'Mozambique', iso: 'MZ', dial: '258' },
  { name: 'Myanmar', iso: 'MM', dial: '95' },
  { name: 'Namibia', iso: 'NA', dial: '264' },
  { name: 'Nepal', iso: 'NP', dial: '977' },
  { name: 'Netherlands', iso: 'NL', dial: '31' },
  { name: 'New Zealand', iso: 'NZ', dial: '64' },
  { name: 'Nicaragua', iso: 'NI', dial: '505' },
  { name: 'Niger', iso: 'NE', dial: '227' },
  { name: 'Nigeria', iso: 'NG', dial: '234' },
  { name: 'North Macedonia', iso: 'MK', dial: '389' },
  { name: 'Norway', iso: 'NO', dial: '47' },
  { name: 'Oman', iso: 'OM', dial: '968' },
  { name: 'Pakistan', iso: 'PK', dial: '92' },
  { name: 'Palestine', iso: 'PS', dial: '970' },
  { name: 'Panama', iso: 'PA', dial: '507' },
  { name: 'Papua New Guinea', iso: 'PG', dial: '675' },
  { name: 'Paraguay', iso: 'PY', dial: '595' },
  { name: 'Peru', iso: 'PE', dial: '51' },
  { name: 'Philippines', iso: 'PH', dial: '63' },
  { name: 'Poland', iso: 'PL', dial: '48' },
  { name: 'Portugal', iso: 'PT', dial: '351' },
  { name: 'Qatar', iso: 'QA', dial: '974' },
  { name: 'Romania', iso: 'RO', dial: '40' },
  { name: 'Russia', iso: 'RU', dial: '7' },
  { name: 'Rwanda', iso: 'RW', dial: '250' },
  { name: 'Saudi Arabia', iso: 'SA', dial: '966' },
  { name: 'Senegal', iso: 'SN', dial: '221' },
  { name: 'Serbia', iso: 'RS', dial: '381' },
  { name: 'Seychelles', iso: 'SC', dial: '248' },
  { name: 'Sierra Leone', iso: 'SL', dial: '232' },
  { name: 'Singapore', iso: 'SG', dial: '65' },
  { name: 'Slovakia', iso: 'SK', dial: '421' },
  { name: 'Slovenia', iso: 'SI', dial: '386' },
  { name: 'Somalia', iso: 'SO', dial: '252' },
  { name: 'South Africa', iso: 'ZA', dial: '27' },
  { name: 'South Korea', iso: 'KR', dial: '82' },
  { name: 'South Sudan', iso: 'SS', dial: '211' },
  { name: 'Spain', iso: 'ES', dial: '34' },
  { name: 'Sri Lanka', iso: 'LK', dial: '94' },
  { name: 'Sudan', iso: 'SD', dial: '249' },
  { name: 'Sweden', iso: 'SE', dial: '46' },
  { name: 'Switzerland', iso: 'CH', dial: '41' },
  { name: 'Syria', iso: 'SY', dial: '963' },
  { name: 'Taiwan', iso: 'TW', dial: '886' },
  { name: 'Tajikistan', iso: 'TJ', dial: '992' },
  { name: 'Tanzania', iso: 'TZ', dial: '255' },
  { name: 'Thailand', iso: 'TH', dial: '66' },
  { name: 'Togo', iso: 'TG', dial: '228' },
  { name: 'Trinidad and Tobago', iso: 'TT', dial: '1868' },
  { name: 'Tunisia', iso: 'TN', dial: '216' },
  { name: 'Turkey', iso: 'TR', dial: '90' },
  { name: 'Turkmenistan', iso: 'TM', dial: '993' },
  { name: 'Uganda', iso: 'UG', dial: '256' },
  { name: 'Ukraine', iso: 'UA', dial: '380' },
  { name: 'United Arab Emirates', iso: 'AE', dial: '971' },
  { name: 'United Kingdom', iso: 'GB', dial: '44' },
  { name: 'United States', iso: 'US', dial: '1' },
  { name: 'Uruguay', iso: 'UY', dial: '598' },
  { name: 'Uzbekistan', iso: 'UZ', dial: '998' },
  { name: 'Venezuela', iso: 'VE', dial: '58' },
  { name: 'Vietnam', iso: 'VN', dial: '84' },
  { name: 'Yemen', iso: 'YE', dial: '967' },
  { name: 'Zambia', iso: 'ZM', dial: '260' },
  { name: 'Zimbabwe', iso: 'ZW', dial: '263' },
];

const DEFAULT_COUNTRY = COUNTRIES[0]; // Lebanon
const MAX_DIGITS = 15; // E.164 hard ceiling on the national part when a country has no exact length

/** National digits for a country: stripped to digits and capped at its max length (or the E.164 ceiling). */
function capNational(input: string, country: Country): string {
  return input.replace(/\D/g, '').slice(0, country.maxDigits ?? MAX_DIGITS);
}

/** Human label for a digit-length rule, e.g. "8 digits", "7 or 8 digits", "6–15 digits". */
function lengthLabel(min: number, max: number): string {
  if (min === max) return `${min} digits`;
  if (max === min + 1) return `${min} or ${max} digits`;
  return `${min}–${max} digits`;
}

// Longest dial-code first so e.g. +961 wins over +96, and +1242 over +1.
const BY_DIAL_DESC = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);

function flagEmoji(iso: string): string {
  return iso.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

/** Split a stored phone string into a detected country + the national digits. */
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
  const national = useMemo(() => parse(value).national, [value]);
  // The selected country lives in local state, NOT derived from `value`: an empty
  // number composes to '' (no dial code to detect), so deriving it from `value`
  // would snap the selector back to the default whenever the number is blank —
  // making it impossible to pick a country before typing. Initialise from the
  // incoming value, then the user owns it; a pasted +code still re-detects below.
  const [country, setCountry] = useState<Country>(() => parse(value).country);

  const selectCountry = (iso: string) => {
    const next = COUNTRIES.find((c) => c.iso === iso) ?? DEFAULT_COUNTRY;
    setCountry(next);
    // Re-cap the digits to the new country's length (e.g. switching to Lebanon
    // trims anything past 8) so the value can't carry an invalid length.
    onChange(compose(next, capNational(national, next)));
  };

  const editNational = (raw: string) => {
    // Pasting a full international number (with +) re-detects the country.
    if (raw.trim().startsWith('+')) {
      const p = parse(raw);
      setCountry(p.country);
      onChange(compose(p.country, capNational(p.national, p.country)));
    } else {
      onChange(compose(country, capNational(raw, country)));
    }
  };

  // Inline validity — flagged only once the user has typed something: a country
  // with a known exact length (e.g. Lebanon → 8) must match it; otherwise the
  // general 6–15 digit range. Catches a too-short/wrong number before submit.
  const minLen = country.minDigits ?? 6;
  const maxLen = country.maxDigits ?? 15;
  const hasLengthRule = country.minDigits !== undefined || country.maxDigits !== undefined;
  const invalid = national.length > 0 && (national.length < minLen || national.length > maxLen);
  const hint = hasLengthRule
    ? `${country.name} numbers are ${lengthLabel(minLen, maxLen)}`
    : `Enter ${lengthLabel(6, 15)}`;

  return (
    <div className={className}>
      <div className="flex gap-2">
        {/* Country selector: a compact "flag +dial ⌄" pill. The real <select> sits
          transparent on top, so we keep the native dropdown (full country names),
          keyboard nav, and the mobile picker for free — only the collapsed look is
          ours, which is what keeps the control narrow (no full name shown). */}
        <div className="relative shrink-0 rounded-md ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
          <div
            aria-hidden
            className="pointer-events-none flex h-10 items-center gap-1.5 rounded-md border border-input bg-muted/50 pl-2.5 pr-7 text-sm"
          >
            <span className="leading-none">{flagEmoji(country.iso)}</span>
            <span className="font-medium tabular-nums">+{country.dial}</span>
            <ChevronDown className="absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          </div>
          <select
            aria-label="Country code"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            value={country.iso}
            onChange={(e) => selectCountry(e.target.value)}
          >
            {COUNTRIES.map((c) => (
              <option key={c.iso} value={c.iso}>
                {flagEmoji(c.iso)} +{c.dial} {c.name}
              </option>
            ))}
          </select>
        </div>
        <Input
          id={id}
          className={cn('flex-1', invalid && 'border-destructive focus-visible:ring-destructive')}
          inputMode="tel"
          autoComplete="tel-national"
          aria-invalid={invalid || undefined}
          placeholder={placeholder ?? 'Phone number'}
          value={national}
          onChange={(e) => editNational(e.target.value)}
        />
      </div>
      {invalid && <p className="mt-1 text-xs text-destructive">{hint}</p>}
    </div>
  );
}
