# Read-only Bot directory (personal fork)

The `botDirectory` Cordis service supplies versioned metadata to local integrations.
It does not expose the runtime, state store, tool calls, or permission-answer methods.
Each snapshot explicitly selects Bot names, role labels, identities, conversation
references and aggregate activity. Direct and group session parts retain their existing
semantics. An approval or question takes priority over working; a secondary read-only
host reports unknown activity rather than guessing idle.

A UUID stored in `directory-id` in the team home identifies the runtime across restarts
and profile changes. Copy it when moving the team, omit it when cloning an independent
team. The service loads the existing roster without bootstrapping a team or calling a
model. It creates only its identity file on first use.

The optional Herdr plugin owns the local HTTP boundary; Ovis owns browser authentication
and polls only while its Bots view is open. Chat and approvals remain in DS Bot.
