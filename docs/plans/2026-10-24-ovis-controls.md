# Native Ovis controls (personal fork)

The authenticated `botBridge` service adds a bounded model catalog and two explicit
controls: selecting a Bot's model and cancelling its displayed direct session.
Ovis renders these at `/dsh` using its own browser authentication. The Herdr plugin
continues to own the loopback HTTP boundary and shared server credential.

Catalog reads never bootstrap a Bot or initiate a model turn. Model changes use
the existing `updateBot` behavior, including the initial welcome reply after model
selection. Unconfigured providers cannot be selected through this control.
Stopping checks the displayed session before and after resolving its agent; it
never cancels group sessions. Runtime identity and read-only ownership checks
apply to every control. Bounded request deduplication prevents replay in one
process; a lost acknowledgement is not retried automatically.

No DSH core files, credentials, approvals, permissions, or team roles are changed.
