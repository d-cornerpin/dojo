// The optional `task_id` every person-reaching send tool's schema carries (these bytes sit in the cached
// tool array). Nothing is recorded from it: the stall ladder tells the owner once a
// day per task by card, whatever the agent sends.
export const TOLD_ABOUT_TASK_PROPERTY = {
  type: 'string',
  description: 'Optional. The id of the task this message tells them about (e.g. raising a blocked task), so the platform knows they were told.',
};
