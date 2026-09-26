# BluelineGPT Shared Communication Backend Contracts

No communication persistence or transport currently exists. This is the mandatory contract boundary for the single shared mobile/web service.

## Security model

All authenticated routes derive Company and sender identity from the session. Clients request an Order conversation or Office support conversation and never submit recipient IDs. The server resolves membership: Trader–Office, Driver–Office, Customer–Office, or authorized Operator–mobile user. Cross-Company, cross-owner, unassigned-Driver, revoked-Customer-token, Driver–Trader, Customer–Driver, and Customer–Trader access returns a non-disclosing 403/404 and creates a security audit event.

## Required REST contracts

- `POST /communication/conversations/resolve`: type plus optional authorized Order ID; idempotently resolves membership.
- `GET /communication/conversations`: cursor, limit, unread/type/role/priority/waiting/status filters and bounded search; newest activity first.
- `GET /communication/conversations/{id}`: membership-authorized header and safe Order context.
- `GET /communication/conversations/{id}/messages`: reverse cursor history with stable sequence.
- `POST /communication/conversations/{id}/messages/text`: plain text, client message ID, original client time and idempotency key. Server supplies sender/recipients and returns authoritative Sent state.
- `POST /communication/conversations/{id}/voice-uploads`: approved format/size/duration initialization and protected upload grant.
- `POST /communication/conversations/{id}/voice-uploads/{uploadId}/complete`: checksum, duration and client message identifiers; atomically scans/finalizes media and message.
- `GET /communication/messages/{id}/voice`: membership-authorized protected stream or short-lived signed URL.
- `POST /communication/conversations/{id}/read`: visible-through sequence/message ID; never invoked by preload.
- `GET /communication/unread-counts`: authoritative total and per-conversation values.
- Operator-only assignment, priority, resolve and reopen mutations require dedicated permissions and optimistic version conflicts.

Responses require stable codes for unauthorized/not found, validation, rate limit, duplicate/idempotent replay, version conflict, upload expiry, scan rejection, retention/redaction, and service unavailable. Conversation/message lists require cursors and limits. Messages are append-only; legal deletion uses audited redaction.

## Real-time, push, media, and operations

An authenticated WebSocket handshake must bind session, Company, identity and permitted conversation subscriptions. Events require server event ID, monotonic cursor/sequence, conversation ID, safe payload and server time. Supported events include conversation/message created or updated, delivered/read receipts, unread totals and authorized system messages. Reconnect uses a REST/event replay cursor and deduplicates by server ID; heartbeat, token refresh and logout disconnect are mandatory.

FCM/APNS and browser alerts contain only safe routing identifiers and generic previews according to privacy preferences—never tokens, voice URLs, addresses, COD details or full private bodies. Device registration and notification read state require authenticated APIs.

Voice storage must be private and Company isolated, validate MIME/signature/size/duration/checksum, scan content where available, use randomized object names, protected streaming/short-lived access, quotas, upload expiry, abandoned-file cleanup and an approved retention/redaction schedule. Microphone limits, formats, bitrate, message length, rate limits, abuse response, delivery semantics, multi-device read semantics, notification preferences and retention require product/security approval before clients enable sending.
