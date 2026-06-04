/**
 * Spoken-form normalization for text being sent to TTS.
 *
 * Kokoro will dutifully read "30.01in" as "thirty point zero one eye en" and
 * "°F" as "degree symbol eff". This module expands the common shorthand into
 * something a TTS engine can pronounce naturally:
 *
 *   72°F          → 72 degrees Fahrenheit
 *   3m 37s        → 3 minutes 37 seconds
 *   18%           → 18 percent
 *   30.01in       → 30.01 inches      (Kokoro reads "30.01" as "thirty point zero one")
 *   kevin.com     → kevin dot com
 *   Tue           → Tuesday
 *   $5.99         → 5 dollars and 99 cents
 *
 * Design notes:
 *  - Ordering matters. Compound time ("3m 37s") runs before single-unit ("3m")
 *    so the pair is recognized as a unit. TLDs run last so they don't collide
 *    with decimal numbers.
 *  - Single-letter units (m, s, h, d, g) without a clearly-paired sibling are
 *    intentionally NOT expanded — too ambiguous with prose ("3 in 10 chances",
 *    "5 g of sugar"). Only attached-form ("30in") or paired-form ("3m 37s")
 *    is expanded for those.
 *  - Month names that collide with people-names (Jan/Mar/May/Jun/Aug) are
 *    intentionally left alone.
 *  - Run AFTER markdown stripping but BEFORE TTS synthesis.
 */

// Each entry is [pattern, replacement]. Replacement can be a string with $1
// backrefs or a function. Patterns are applied in order; earlier wins.
type Replacer = string | ((substring: string, ...args: string[]) => string);
const PATTERNS: Array<[RegExp, Replacer]> = [
  // ── Compound time (before single-unit forms) ────────────────────────
  // "1h 5m 30s", "3m 37s", "2d 4h", etc. All units required, all digits required.
  [/(\d+)\s*h\s+(\d+)\s*m\s+(\d+)\s*s\b/gi, (_m, h, mn, s) => `${h} hours ${mn} minutes ${s} seconds`],
  [/(\d+)\s*h\s+(\d+)\s*m\b/gi, (_m, h, mn) => `${h} hours ${mn} minutes`],
  [/(\d+)\s*m\s+(\d+)\s*s\b/gi, (_m, mn, s) => `${mn} minutes ${s} seconds`],
  [/(\d+)\s*d\s+(\d+)\s*h\b/gi, (_m, d, h) => `${d} days ${h} hours`],

  // ── Temperature ─────────────────────────────────────────────────────
  // Catches "72°F", "72 °F", "-5°C", and bare "90°" (no F/C → "degrees").
  [/(-?\d+(?:\.\d+)?)\s*°\s*F\b/g, '$1 degrees Fahrenheit'],
  [/(-?\d+(?:\.\d+)?)\s*°\s*C\b/g, '$1 degrees Celsius'],
  [/(-?\d+(?:\.\d+)?)\s*°(?![\w])/g, '$1 degrees'],

  // ── Percent ─────────────────────────────────────────────────────────
  [/(\d+(?:\.\d+)?)\s*%/g, '$1 percent'],

  // ── Currency ────────────────────────────────────────────────────────
  // "$5.99" → "5 dollars and 99 cents"; "$5" → "5 dollars".
  [/\$(\d+)\.(\d{2})\b/g, (_m, whole: string, cents: string) =>
    cents === '00' ? `${whole} dollars` : `${whole} dollars and ${cents} cents`,
  ],
  [/\$(\d+)\b/g, '$1 dollars'],

  // ── Distance / size (number-attached or with space) ─────────────────
  // "in" is special: as a preposition it'd false-match ("5 in 10"). Only
  // expand when attached with no space ("30in") OR followed by sentence end.
  [/(\d+(?:\.\d+)?)in\b(?!\w)/g, '$1 inches'],
  [/(\d+(?:\.\d+)?)\s*ft\b/g, '$1 feet'],
  [/(\d+(?:\.\d+)?)\s*yd\b/g, '$1 yards'],
  [/(\d+(?:\.\d+)?)\s*mi\b/g, '$1 miles'],
  [/(\d+(?:\.\d+)?)\s*mm\b/g, '$1 millimeters'],
  [/(\d+(?:\.\d+)?)\s*cm\b/g, '$1 centimeters'],
  [/(\d+(?:\.\d+)?)\s*km\b/g, '$1 kilometers'],

  // ── Speed ───────────────────────────────────────────────────────────
  [/(\d+(?:\.\d+)?)\s*mph\b/gi, '$1 miles per hour'],
  [/(\d+(?:\.\d+)?)\s*kph\b/gi, '$1 kilometers per hour'],
  [/(\d+(?:\.\d+)?)\s*fps\b/gi, '$1 frames per second'],

  // ── Weight ──────────────────────────────────────────────────────────
  [/(\d+(?:\.\d+)?)\s*lbs?\b/g, '$1 pounds'],
  [/(\d+(?:\.\d+)?)\s*oz\b/g, '$1 ounces'],
  [/(\d+(?:\.\d+)?)\s*kg\b/g, '$1 kilograms'],
  [/(\d+(?:\.\d+)?)\s*mg\b/g, '$1 milligrams'],

  // ── Time (single unit, unambiguous abbreviations only) ──────────────
  [/(\d+(?:\.\d+)?)\s*ms\b/g, '$1 milliseconds'],
  [/(\d+(?:\.\d+)?)\s*sec\b/g, '$1 seconds'],
  [/(\d+(?:\.\d+)?)\s*mins?\b/g, '$1 minutes'],
  [/(\d+(?:\.\d+)?)\s*hrs?\b/g, '$1 hours'],
  [/(\d+(?:\.\d+)?)\s*yrs?\b/g, '$1 years'],

  // ── AM/PM (digit-prefixed so "I am 25" doesn't get caught) ─────────
  // Catches "3pm", "10AM", "8:30 PM", "11 a.m.", "1 P.M." — any digit
  // followed by an optional space and the meridian letters with or
  // without inner periods. Replaced with uppercase letter-name form
  // ("A M" / "P M") because lowercase space-separated letters ("a m")
  // get phonemized as the article "a" plus the letter "m" and slur
  // together; uppercase letters get read out as letter names.
  [/(\d+(?::\d+)?)\s*[Pp]\.?\s*[Mm]\.?(?!\w)/g, '$1 P M'],
  [/(\d+(?::\d+)?)\s*[Aa]\.?\s*[Mm]\.?(?!\w)/g, '$1 A M'],

  // ── Storage / data ──────────────────────────────────────────────────
  [/(\d+(?:\.\d+)?)\s*GB\b/g, '$1 gigabytes'],
  [/(\d+(?:\.\d+)?)\s*MB\b/g, '$1 megabytes'],
  [/(\d+(?:\.\d+)?)\s*KB\b/g, '$1 kilobytes'],
  [/(\d+(?:\.\d+)?)\s*TB\b/g, '$1 terabytes'],
  [/(\d+(?:\.\d+)?)\s*PB\b/g, '$1 petabytes'],

  // ── Frequency ───────────────────────────────────────────────────────
  [/(\d+(?:\.\d+)?)\s*GHz\b/g, '$1 gigahertz'],
  [/(\d+(?:\.\d+)?)\s*MHz\b/g, '$1 megahertz'],
  [/(\d+(?:\.\d+)?)\s*kHz\b/g, '$1 kilohertz'],
  [/(\d+(?:\.\d+)?)\s*Hz\b/g, '$1 hertz'],

  // ── Dimensions (e.g. "1920x1080", "4x6") ────────────────────────────
  [/(\d+)\s*x\s*(\d+)\b/g, '$1 by $2'],

  // ── Email addresses ────────────────────────────────────────────────
  // Run BEFORE TLD rules so "jane@example.com" first becomes
  // "jane at example.com", then the .com rule turns it into
  // "jane at example dot com".
  [/([A-Za-z0-9._+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1 at $2'],

  // ── Plus-or-minus (before the math + rule below) ───────────────────
  [/±/g, 'plus or minus '],
  [/\+\/-/g, 'plus or minus '],

  // ── Math operators (only when sandwiched between numbers) ──────────
  // Subtraction is intentionally NOT included — same symbol as a hyphen
  // in number ranges below, which are far more common in agent chat.
  [/(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)/g, '$1 plus $2'],
  [/(\d+(?:\.\d+)?)\s*=\s*(\d+(?:\.\d+)?)/g, '$1 equals $2'],
  [/(\d+(?:\.\d+)?)\s*×\s*(\d+(?:\.\d+)?)/g, '$1 times $2'],
  [/(\d+(?:\.\d+)?)\s*÷\s*(\d+(?:\.\d+)?)/g, '$1 divided by $2'],

  // ── Number ranges ──────────────────────────────────────────────────
  // "pages 5-10" → "pages 5 to 10". Two patterns: year-pair (1900s/2000s)
  // and small numbers (1-3 digits each). Lookarounds guard against phone
  // numbers — "555-555-1234" stays as-is because of the trailing -1234
  // segment. Em/en-dash variants included.
  [/\b((?:19|20)\d{2})\s*[-–]\s*((?:19|20)\d{2})\b(?!-\d)/g, '$1 to $2'],
  [/(?<!\d-)\b(\d{1,3})\s*[-–]\s*(\d{1,3})\b(?!-\d)/g, '$1 to $2'],

  // ── Domain TLDs (after URL stripping has already handled http URLs) ─
  // Catches bare-domain refs like "kevin.com", "example.org", "model.ai".
  // Common letter-acronym TLDs get a space between letters so Kokoro reads
  // each letter ("dot a i" not "dot eye"). Word TLDs stay as one word.
  [/\.com\b/gi, ' dot com'],
  [/\.org\b/gi, ' dot org'],
  [/\.net\b/gi, ' dot net'],
  [/\.gov\b/gi, ' dot gov'],
  [/\.edu\b/gi, ' dot edu'],
  [/\.dev\b/gi, ' dot dev'],
  [/\.app\b/gi, ' dot app'],
  [/\.me\b/gi, ' dot me'],
  [/\.tv\b/gi, ' dot T V'],
  [/\.io\b/gi, ' dot I O'],
  [/\.ai\b/gi, ' dot A I'],
  [/\.co\b/gi, ' dot co'],
  [/\.uk\b/gi, ' dot U K'],
  [/\.us\b/gi, ' dot U S'],
  [/\.ca\b/gi, ' dot C A'],

  // ── Days of week (capitalized abbrevs only) ─────────────────────────
  [/\bMon\b\.?/g, 'Monday'],
  [/\bTues?\b\.?/g, 'Tuesday'],
  [/\bWed\b\.?/g, 'Wednesday'],
  [/\bThurs?\b\.?/g, 'Thursday'],
  [/\bThu\b\.?/g, 'Thursday'],
  [/\bFri\b\.?/g, 'Friday'],
  [/\bSat\b\.?/g, 'Saturday'],
  [/\bSun\b\.?/g, 'Sunday'],

  // ── Months (skip Jan/Mar/May/Jun/Aug — collide with people names) ──
  [/\bFeb\b\.?/g, 'February'],
  [/\bApr\b\.?/g, 'April'],
  [/\bJul\b\.?/g, 'July'],
  [/\bSept?\b\.?/g, 'September'],
  [/\bOct\b\.?/g, 'October'],
  [/\bNov\b\.?/g, 'November'],
  [/\bDec\b\.?/g, 'December'],

  // ── Date ordinals ───────────────────────────────────────────────────
  // "May 22" → "May 22nd", "August 1, 2026" → "August 1st, 2026". Runs AFTER
  // month-abbreviation expansion so "Feb 14" becomes "February 14th" via two
  // passes. Includes the abbreviation-skipped months (Jan/May/Jun/etc.) since
  // the trailing day number disambiguates them from people's names.
  // Negative lookaheads: skip when the day is already ordinal-suffixed ("May
  // 1st" stays as-is) and when more digits follow ("May 222" isn't a date).
  [/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?!\d)(?!\s*(?:st|nd|rd|th)\b)\b/g,
    (match: string, month: string, day: string) => {
      const n = parseInt(day, 10);
      if (n < 1 || n > 31) return match;
      const lastTwo = n % 100;
      let suffix: string;
      if (lastTwo >= 11 && lastTwo <= 13) suffix = 'th';
      else if (n % 10 === 1) suffix = 'st';
      else if (n % 10 === 2) suffix = 'nd';
      else if (n % 10 === 3) suffix = 'rd';
      else suffix = 'th';
      return `${month} ${n}${suffix}`;
    },
  ],

  // ── Compass directions (uppercase only, 2-3 letter forms) ──────────
  // Single letters N/E/S/W are intentionally NOT expanded — far too
  // ambiguous in English prose ("the N word", initials, etc). Two- and
  // three-letter forms in uppercase essentially only appear as compass
  // directions. Longest first so the alternation matches NNE before NE.
  [/\bNNE\b/g, 'north-north-east'],
  [/\bENE\b/g, 'east-north-east'],
  [/\bESE\b/g, 'east-south-east'],
  [/\bSSE\b/g, 'south-south-east'],
  [/\bSSW\b/g, 'south-south-west'],
  [/\bWSW\b/g, 'west-south-west'],
  [/\bWNW\b/g, 'west-north-west'],
  [/\bNNW\b/g, 'north-north-west'],
  [/\bNE\b/g, 'north-east'],
  [/\bSE\b/g, 'south-east'],
  [/\bSW\b/g, 'south-west'],
  [/\bNW\b/g, 'north-west'],

  // ── Street abbreviations (skip St. — collides with Saint) ──────────
  // "St." stays as-is because "St. Louis Ave." would otherwise become
  // "Street Louis Avenue". Word boundary keeps "Average", "Aptitude" safe.
  // No trailing-period consumption so sentence-final "...on Main Ave."
  // keeps its terminating period.
  [/\bAve\b/g, 'Avenue'],
  [/\bBlvd\b/g, 'Boulevard'],
  [/\bRd\b/g, 'Road'],
  [/\bApt\b/g, 'Apartment'],
  [/\bSte\b/g, 'Suite'],

  // ── Titles ──────────────────────────────────────────────────────────
  [/\bMr\.\s*/g, 'Mister '],
  [/\bMrs\.\s*/g, 'Missus '],
  [/\bMs\.\s+/g, 'Miss '],
  [/\bDr\.\s*/g, 'Doctor '],
  [/\bProf\.\s*/g, 'Professor '],

  // ── Common abbreviations ────────────────────────────────────────────
  [/\bvs\.?\s+/gi, 'versus '],
  [/\betc\./gi, 'et cetera'],
  [/\be\.g\./gi, 'for example'],
  [/\bi\.e\./gi, 'that is'],
  [/\bapprox\./gi, 'approximately'],
  [/\bw\/o\b/gi, 'without'],
  [/\bw\/\s/gi, 'with '],

  // ── Misc symbols ────────────────────────────────────────────────────
  // "#5" → "number 5". Only fires when a digit follows so hashtags
  // ("#trending") and code-style refs ("#main") stay intact.
  [/#(\d+)/g, 'number $1'],
  [/\s+&\s+/g, ' and '],
  // Clean up doubled spaces a normalization left behind.
  [/  +/g, ' '],
];

export function normalizeForSpeech(text: string): string {
  let s = text;
  for (const [pattern, replacement] of PATTERNS) {
    s = typeof replacement === 'string'
      ? s.replace(pattern, replacement)
      : s.replace(pattern, replacement as (substring: string, ...args: string[]) => string);
  }
  return s;
}
