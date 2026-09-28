Write the calendar packet for Hunter's Daily Brief for {{DATE}}. Read
{{ROOT}}/daily-brief/contribution-contract.md first; the packet follows it
with `domain: calendar` and `since: {{CURSOR}}`. The run started at {{NOW}}; `generated_at` is the real clock time when you write, not a guess, and `data_as_of` is your source's real freshness.

Using the Google Calendar tools, list every calendar, skip any whose name
contains "holiday", and read the events on the rest between
{{WINDOW_START}} and {{WINDOW_END}}. Times are America/Chicago.

Rules:
- Drop events Hunter has declined. Keep tentative ones and say they are
  tentative.
- One `upcoming` item per event, `horizon` set to the event's date. The
  headline names the event, who else is on it if the invite says, where
  (or that it is a video call), and the start time as Chicago clock time,
  with the end time when the event runs longer than two hours. Today's
  events are `upcoming` too; the curator sorts them into Today.
- An event that appears on two calendars is one item.
- A recurring routine block (a standing meeting, a gym block) that repeats
  inside the window is one item saying which days it lands on.
- All-day entries are one item each; say they are all day.
- Nothing that is not on the calendar. No inference about what an event is
  for.
- An empty window is `status: ok` with `items: []`.

This is a non-interactive scheduled run: do not ask anything. Write the
packet to {{ROOT}}/daily-brief/contributions/{{DATE}}/calendar.yaml and
stop.
