// Spoken-form normalization for TTS: expands shorthand ("72°F", "3m 37s", "example.com") into words.
// Run after markdown stripping and before synthesis. Patterns apply in order, so compound time must
// precede single units and email must precede the TLD rules.

// [pattern, replacement] pairs, applied in order.
type Replacer = string | ((substring: string, ...args: string[]) => string);
const PATTERNS: Array<[RegExp, Replacer]> = [
  [/(\d+)\s*h\s+(\d+)\s*m\s+(\d+)\s*s\b/gi, (_m, h, mn, s) => `${h} hours ${mn} minutes ${s} seconds`],
  [/(\d+)\s*h\s+(\d+)\s*m\b/gi, (_m, h, mn) => `${h} hours ${mn} minutes`],
  [/(\d+)\s*m\s+(\d+)\s*s\b/gi, (_m, mn, s) => `${mn} minutes ${s} seconds`],
  [/(\d+)\s*d\s+(\d+)\s*h\b/gi, (_m, d, h) => `${d} days ${h} hours`],

  [/(-?\d+(?:\.\d+)?)\s*°\s*F\b/g, '$1 degrees Fahrenheit'],
  [/(-?\d+(?:\.\d+)?)\s*°\s*C\b/g, '$1 degrees Celsius'],
  [/(-?\d+(?:\.\d+)?)\s*°(?![\w])/g, '$1 degrees'],

  [/(\d+(?:\.\d+)?)\s*%/g, '$1 percent'],

  // Comma-grouped thousands stay as written; the comma form is tried first so \d+ cannot stop at the comma.
  [/\$(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\b/g, (_m, whole: string, cents: string) =>
    cents === '00' ? `${whole} dollars` : `${whole} dollars and ${cents} cents`,
  ],
  [/\$(\d{1,3}(?:,\d{3})+|\d+)\b/g, '$1 dollars'],

  // Only the attached form ("30in") is expanded; "5 in 10" is a preposition.
  // Single-letter units (m, s, h, d, g) are expanded only in the paired compound-time forms above.
  [/(\d+(?:\.\d+)?)in\b(?!\w)/g, '$1 inches'],
  [/(\d+(?:\.\d+)?)\s*ft\b/g, '$1 feet'],
  [/(\d+(?:\.\d+)?)\s*yd\b/g, '$1 yards'],
  [/(\d+(?:\.\d+)?)\s*mi\b/g, '$1 miles'],
  [/(\d+(?:\.\d+)?)\s*mm\b/g, '$1 millimeters'],
  [/(\d+(?:\.\d+)?)\s*cm\b/g, '$1 centimeters'],
  [/(\d+(?:\.\d+)?)\s*km\b/g, '$1 kilometers'],

  [/(\d+(?:\.\d+)?)\s*mph\b/gi, '$1 miles per hour'],
  [/(\d+(?:\.\d+)?)\s*kph\b/gi, '$1 kilometers per hour'],
  [/(\d+(?:\.\d+)?)\s*fps\b/gi, '$1 frames per second'],

  [/(\d+(?:\.\d+)?)\s*lbs?\b/g, '$1 pounds'],
  [/(\d+(?:\.\d+)?)\s*oz\b/g, '$1 ounces'],
  [/(\d+(?:\.\d+)?)\s*kg\b/g, '$1 kilograms'],
  [/(\d+(?:\.\d+)?)\s*mg\b/g, '$1 milligrams'],

  [/(\d+(?:\.\d+)?)\s*ms\b/g, '$1 milliseconds'],
  [/(\d+(?:\.\d+)?)\s*sec\b/g, '$1 seconds'],
  [/(\d+(?:\.\d+)?)\s*mins?\b/g, '$1 minutes'],
  [/(\d+(?:\.\d+)?)\s*hrs?\b/g, '$1 hours'],
  [/(\d+(?:\.\d+)?)\s*yrs?\b/g, '$1 years'],

  // Digit-prefixed so "I am 25" is untouched. Uppercase "A M"/"P M" is read as letter names; lowercase
  // "a m" would be phonemized as the article plus "m".
  [/(\d+(?::\d+)?)\s*[Pp]\.?\s*[Mm]\.?(?!\w)/g, '$1 P M'],
  [/(\d+(?::\d+)?)\s*[Aa]\.?\s*[Mm]\.?(?!\w)/g, '$1 A M'],

  [/(\d+(?:\.\d+)?)\s*GB\b/g, '$1 gigabytes'],
  [/(\d+(?:\.\d+)?)\s*MB\b/g, '$1 megabytes'],
  [/(\d+(?:\.\d+)?)\s*KB\b/g, '$1 kilobytes'],
  [/(\d+(?:\.\d+)?)\s*TB\b/g, '$1 terabytes'],
  [/(\d+(?:\.\d+)?)\s*PB\b/g, '$1 petabytes'],

  [/(\d+(?:\.\d+)?)\s*GHz\b/g, '$1 gigahertz'],
  [/(\d+(?:\.\d+)?)\s*MHz\b/g, '$1 megahertz'],
  [/(\d+(?:\.\d+)?)\s*kHz\b/g, '$1 kilohertz'],
  [/(\d+(?:\.\d+)?)\s*Hz\b/g, '$1 hertz'],

  [/(\d+)\s*x\s*(\d+)\b/g, '$1 by $2'],

  // Before the TLD rules, so "jane@example.com" ends as "jane at example dot com".
  [/([A-Za-z0-9._+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1 at $2'],

  [/±/g, 'plus or minus '],
  [/\+\/-/g, 'plus or minus '],

  // Subtraction is excluded: its symbol is the hyphen of the number ranges below, which are far more common.
  [/(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)/g, '$1 plus $2'],
  [/(\d+(?:\.\d+)?)\s*=\s*(\d+(?:\.\d+)?)/g, '$1 equals $2'],
  [/(\d+(?:\.\d+)?)\s*×\s*(\d+(?:\.\d+)?)/g, '$1 times $2'],
  [/(\d+(?:\.\d+)?)\s*÷\s*(\d+(?:\.\d+)?)/g, '$1 divided by $2'],

  // Year pairs and 1-3 digit pairs; lookarounds keep phone numbers ("555-555-1234") intact. En-dash accepted.
  [/\b((?:19|20)\d{2})\s*[-–]\s*((?:19|20)\d{2})\b(?!-\d)/g, '$1 to $2'],
  [/(?<!\d-)\b(\d{1,3})\s*[-–]\s*(\d{1,3})\b(?!-\d)/g, '$1 to $2'],

  // Letter-acronym TLDs get spaced letters so each is read aloud; word TLDs stay one word.
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

  [/\bMon\b\.?/g, 'Monday'],
  [/\bTues?\b\.?/g, 'Tuesday'],
  [/\bWed\b\.?/g, 'Wednesday'],
  [/\bThurs?\b\.?/g, 'Thursday'],
  [/\bThu\b\.?/g, 'Thursday'],
  [/\bFri\b\.?/g, 'Friday'],
  [/\bSat\b\.?/g, 'Saturday'],
  [/\bSun\b\.?/g, 'Sunday'],

  // Jan/Mar/May/Jun/Aug are skipped: they collide with people's names.
  [/\bFeb\b\.?/g, 'February'],
  [/\bApr\b\.?/g, 'April'],
  [/\bJul\b\.?/g, 'July'],
  [/\bSept?\b\.?/g, 'September'],
  [/\bOct\b\.?/g, 'October'],
  [/\bNov\b\.?/g, 'November'],
  [/\bDec\b\.?/g, 'December'],

  // Runs after month expansion. Negative lookaheads skip a day already suffixed ("May 1st") and
  // a longer digit run ("May 222").
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

  // Uppercase 2-3 letter forms only (single N/E/S/W are too ambiguous); longest first so NNE beats NE.
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

  // St. is skipped (collides with Saint). The trailing period is not consumed, so a sentence-final "Ave." keeps it.
  [/\bAve\b/g, 'Avenue'],
  [/\bBlvd\b/g, 'Boulevard'],
  [/\bRd\b/g, 'Road'],
  [/\bApt\b/g, 'Apartment'],
  [/\bSte\b/g, 'Suite'],

  [/\bMr\.\s*/g, 'Mister '],
  [/\bMrs\.\s*/g, 'Missus '],
  [/\bMs\.\s+/g, 'Miss '],
  [/\bDr\.\s*/g, 'Doctor '],
  [/\bProf\.\s*/g, 'Professor '],

  [/\bvs\.?\s+/gi, 'versus '],
  [/\betc\./gi, 'et cetera'],
  [/\be\.g\./gi, 'for example'],
  [/\bi\.e\./gi, 'that is'],
  [/\bapprox\./gi, 'approximately'],
  [/\bw\/o\b/gi, 'without'],
  [/\bw\/\s/gi, 'with '],

  // "#5" becomes "number 5" only before a digit, so hashtags and code refs stay intact.
  [/#(\d+)/g, 'number $1'],
  [/\s+&\s+/g, ' and '],
  // Collapse doubled spaces left behind by a replacement.
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
