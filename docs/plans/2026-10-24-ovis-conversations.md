# Native Ovis conversations in the personal fork

Ovis is another authenticated UI for DS Bot; DS Bot owns all conversation execution.
The existing metadata directory remains version 1. A bridge target is a runtime ID,
Bot ID and optional room ID. A room must contain that Bot. Room messages use the normal
room Session through the public session controller, so admin routing and mentions
remain unchanged. The first native group view exposes the most recent 60 room log
entries; full older history and group creation/settings stay in DSH.

Generic files use the public fileUploads service to obtain receipts bound to the
receiving Session. Sends pass those receipts to sessionController.prompt. The bridge
caps uploads and downloads at 10 MiB each and sends at eight files. A Session rotation
refuses old draft receipts. Download handles are generated only for references found
in displayed history, expire after 15 minutes, and are bounded to 2,000 entries.
They are scoped to the selected Bot and room. No user-supplied filesystem path or
attachment reference is accepted. Ovis serves downloads as inert attachments.

Direct approvals participate in DSH's public Remote event protocol through an
in-process owner Peer, active only while a native direct chat is subscribed. The
public Gateway wire stream supplies `$events`; the public Connection Fetch adapter
returns `$events/result` envelopes. DSH owns first-answer arbitration and cancellation.
Other agents and unhandled event types delegate immediately. Group approvals already
belong to DS Bot's approval service and reuse its answer method. Each decision names
the exact pending request and Session, offers only allow-once or reject, and preserves
read-only checks. No new policy or automatic grants are introduced.

Validation: boundary unit tests for group ownership, receipt rotation, download scope
and expiry, stale approval decisions; real mock DSH browser tests for file round trips,
group sends, and direct/group rejection; the full DS Bot smoke suite.
