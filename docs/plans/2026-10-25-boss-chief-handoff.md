# Board handoffs in the personal fork

Projects owns one handoff per board task. Boss can draft; the human sends from the
board after seeing Chief, the scope, origin and end condition. There is no agent
send command. Chief remains the DSH team coordinator. The browser's drive/watch
boundary applies, and the backend derives origin rather than trusting a form field.
This is application authorization, not isolation from other programs under the same
OS account.

The Bot bridge exposes create, status and close through a separately authenticated
handoff route in the Herdr plugin. Its credential cannot use ordinary chat, tools,
settings or approval endpoints. Credentials stay server-side. The normal DSH agent
loop, session controller and approvals execute the request.

DS Bot durably records identity before prompt admission. The key is board ID plus
task ID; handoff ID and target IDs must also match. Duplicate creates return the
saved result, including after restart. A lost result is uncertain, never a reason
to replay. Records and closure tombstones are retained; reaching the 1,000-record
limit refuses new admissions rather than forgetting deduplication history. The
board's own record also claims sending before network I/O.

The original request ID appears in the public session user-message source rpcId.
Only its correlated turn can produce a report. A merged user message makes the
outcome uncertain. Reports contain displayed assistant text, no tools or thoughts,
are bounded, and are rendered as plain text. A restart makes incomplete requests
uncertain; transcript recovery is manual in this first version. Chief's conversation
shows the task, origin and end condition in the submitted message.

One request and at most one report impose a two-hop cap. A report never prompts
Boss, executes its text, or changes the task stage. Projects polls one pending
record per keeper tick and stores reports for Boss's next normal turn. Task closure
ends the relay and sends an idempotent close; a remote tombstone also blocks a late
create. It does not cancel Chief's unrelated work. Approvals remain with the human.
