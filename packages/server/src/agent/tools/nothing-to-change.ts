// B11: the refusal a calendar update gives when it carries nothing to change (an empty patch is not
// sent, and leaves no receipt for a change that never happened). Shared by both calendar providers.
export const CALENDAR_NOTHING_TO_CHANGE =
  'Error: nothing to change — pass at least one of title, start, end, description. Nothing was sent to the calendar.';
