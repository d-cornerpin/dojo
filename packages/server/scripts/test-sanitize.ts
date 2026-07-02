#!/usr/bin/env tsx
import { sanitizeForSpeech, StreamingSpeechBuffer } from '../src/voice/text-sanitize.js';

const cases: Array<[string, string]> = [
  // Bold/italic
  ['Hey **bold** word', 'Hey bold word'],
  ['Try *italic* now', 'Try italic now'],
  ['And ***both*** here', 'And both here'],
  ['Plain __bold__ underscore', 'Plain bold underscore'],
  ['snake_case_var should keep underscores', 'snake_case_var should keep underscores'],
  // Code
  ['Use `npm run dev` to start', 'Use npm run dev to start'],
  ['```ts\nconst x = 1;\n```', ' code block '],
  // Links
  ['Check [the docs](https://example.com/x) please', 'Check the docs please'],
  ['Image: ![banner](https://example.com/b.png)', 'Image: banner'],
  // Bare URLs
  ['Go to https://example.com/foo/bar', 'Go to link'],
  ['(see https://github.com/foo, then continue)', '(see link, then continue)'],
  // File paths
  ['Saved to ~/dev-smarter.md', 'Saved to dev-smarter.md'],
  ['Wrote /Users/jane/Documents/foo.txt as the result', 'Wrote foo.txt as the result'],
  ['Cleared /var/log/system', 'Cleared file'],
  // Headers + lists
  ['# Title\n- item one\n- item two', 'Title\nitem one\nitem two'],
  ['1. First\n2. Second', 'First\nSecond'],
  // ── Normalization: units / abbreviations / TLDs ──
  ['Temp is 72°F today', 'Temp is 72 degrees Fahrenheit today'],
  ['Set the oven to 200°C', 'Set the oven to 200 degrees Celsius'],
  ['Rotate by 90°', 'Rotate by 90 degrees'],
  ['Took 3m 37s to finish', 'Took 3 minutes 37 seconds to finish'],
  ['Backup ran for 1h 5m 30s', 'Backup ran for 1 hours 5 minutes 30 seconds'],
  ['Battery at 18%', 'Battery at 18 percent'],
  ['Snowfall: 30.01in last night', 'Snowfall: 30.01 inches last night'],
  ['Drove 12mi to the store', 'Drove 12 miles to the store'],
  ['Top speed 65mph', 'Top speed 65 miles per hour'],
  ['Weighs 5.2lbs', 'Weighs 5.2 pounds'],
  ['Free disk: 42.3GB', 'Free disk: 42.3 gigabytes'],
  ['Sample rate 16kHz', 'Sample rate 16 kilohertz'],
  ['Render at 1920x1080', 'Render at 1920 by 1080'],
  ['Total cost $5.99 plus tax', 'Total cost 5 dollars and 99 cents plus tax'],
  ['Costs $20', 'Costs 20 dollars'],
  ['Check example.com later', 'Check example dot com later'],
  ['Domain is example.org', 'Domain is example dot org'],
  ['Hosted on model.ai', 'Hosted on model dot A I'],
  ['Meeting Tue at 3pm', 'Meeting Tuesday at 3 p m'],
  ['Due by Fri', 'Due by Friday'],
  ['Scheduled for Feb 14', 'Scheduled for February 14th'],
  ['Released Oct 2026', 'Released October 2026'],
  // Date ordinals — also covers the months that month-abbreviation skips
  ['Meeting on May 22', 'Meeting on May 22nd'],
  ['Born August 1, 2026', 'Born August 1st, 2026'],
  ['Due July 3rd', 'Due July 3rd'],                 // already ordinal — leave alone
  ['Conference June 11', 'Conference June 11th'],   // 11/12/13 → "th" not "st/nd/rd"
  ['March 21 deadline', 'March 21st deadline'],
  // Compass directions
  ['Wind from the WNW', 'Wind from the west-north-west'],
  ['NE corner of the lot', 'north-east corner of the lot'],
  ['Heading SSE on I-95', 'Heading south-south-east on I-95'],
  ['NW to SE diagonal', 'north-west to south-east diagonal'],
  // Single letters NOT expanded (too ambiguous)
  ['the N letter', 'the N letter'],
  ['point W on the map', 'point W on the map'],
  // Email
  ['Email me at jane@example.com', 'Email me at jane at example dot com'],
  ['Send to alex.smith+work@company.org', 'Send to alex.smith+work at company dot org'],
  // AM/PM
  ['Meeting at 3pm', 'Meeting at 3 p m'],
  ['Wake up at 7AM', 'Wake up at 7 a m'],
  ['Lunch at 12:30 PM', 'Lunch at 12:30 p m'],
  ['I am 25 years old', 'I am 25 years old'],          // "am" verb, not meridian
  // Math
  ['5 + 3 = 8', '5 plus 3 equals 8'],
  ['10 × 4 = 40', '10 times 4 equals 40'],
  ['12 ÷ 3 = 4', '12 divided by 3 equals 4'],
  // Plus-or-minus
  ['Result: 5 ± 2', 'Result: 5 plus or minus 2'],
  ['Tolerance +/-5', 'Tolerance plus or minus 5'],
  // Number ranges
  ['Read pages 5-10', 'Read pages 5 to 10'],
  ['Years 2026-2030', 'Years 2026 to 2030'],
  ['Call 555-555-1234', 'Call 555-555-1234'],          // phone — leave alone
  // Street abbreviations
  ['123 Main Ave.', '123 Main Avenue.'],
  ['Live on Sunset Blvd', 'Live on Sunset Boulevard'],
  ['Unit 4 Apt B', 'Unit 4 Apartment B'],
  ['I love Aptitude tests', 'I love Aptitude tests'],   // word boundary keeps Apt safe
  // #N
  ['Task #5 is done', 'Task number 5 is done'],
  ['Follow #trending', 'Follow #trending'],            // no digit → no change
  ['Dr. Smith called', 'Doctor Smith called'],
  ['Foo vs. bar', 'Foo versus bar'],
  ['Apples, oranges, etc.', 'Apples, oranges, et cetera'],
  // Ambiguity guards — these must NOT be expanded
  ['I have 5 in 10 chances', 'I have 5 in 10 chances'],   // bare "in" stays
  ['May is a great month', 'May is a great month'],         // May not expanded
  ['Use snake_case_var', 'Use snake_case_var'],
];

let pass = 0;
let fail = 0;
for (const [input, want] of cases) {
  const got = sanitizeForSpeech(input).trim();
  const expected = want.trim();
  if (got === expected) {
    pass++;
    console.log(`  PASS  ${JSON.stringify(input)}`);
  } else {
    fail++;
    console.log(`  FAIL  ${JSON.stringify(input)}`);
    console.log(`        want: ${JSON.stringify(expected)}`);
    console.log(`         got: ${JSON.stringify(got)}`);
  }
}

console.log(`\n${pass} pass, ${fail} fail (sanitizeForSpeech)\n`);

// Streaming buffer — markdown spans chunks
console.log('--- StreamingSpeechBuffer ---');
{
  const buf = new StreamingSpeechBuffer();
  const emitted: string[] = [];
  emitted.push(buf.push('Sure thing! '));
  emitted.push(buf.push('Here are the **'));
  emitted.push(buf.push('bold** '));
  emitted.push(buf.push('words. '));
  emitted.push(buf.push('Done.'));
  emitted.push(buf.flushUnsafe());
  const joined = emitted.filter(Boolean).join('|');
  console.log(`  chunks emitted in order: ${joined}`);
  const combined = emitted.join('');
  const expected = 'Sure thing! Here are the bold words. Done.';
  if (combined.replace(/\s+/g, ' ').trim() === expected) {
    console.log('  PASS  markdown rejoined cleanly across chunks');
    pass++;
  } else {
    console.log(`  FAIL  got: ${JSON.stringify(combined)}`);
    fail++;
  }
}

process.exit(fail > 0 ? 1 : 0);
