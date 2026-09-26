# Tawseelhub Website Live Agent Takeover

Implemented on 2026-08-19 as a local acceptance pass for the public website chat and Platform Agent inbox.

## Behavior

- Website visitors can ask for a human agent in English or Arabic.
- The conversation moves to `paused`, which is used as the website “Waiting for Human” state.
- While `paused`, Yousef sends only the one waiting acknowledgement and does not continue normal automated replies.
- Platform staff can open the waiting conversation, press **Take Over**, and the conversation moves to `human_active`.
- While `human_active`, customer messages are saved but Yousef remains suppressed.
- Platform staff can send a **Website Chat Reply**. It is saved as `platform_staff` on the website channel and appears to the customer as **Tawseelhub Team**.
- Platform internal comments remain private and are not returned through the public website conversation endpoint.
- Staff can press **Return to Yousef**, moving the conversation to `ai_resume`, after which Yousef can answer again.
- Before takeover, the visitor can write “Continue with Yousef” / Arabic equivalent to cancel the waiting state.

## Public transcript safety

The public conversation response returns only customer-visible inbound/outbound messages from:

- `user`
- `assistant`
- `platform_staff`

It excludes internal directions/comments and does not expose Platform account usernames.

## Local browser acceptance notes

Validated locally on:

- Public website: `http://localhost:5174`
- Platform Agent inbox: `http://localhost:5176/agent`
- API: `http://127.0.0.1:3000/api/v1`

Acceptance coverage:

- English human request enters waiting state.
- Platform shows Waiting for Human counter/filter and the waiting website conversation.
- Platform Take Over moves the conversation to Human Active and assigns ownership.
- Website Chat Reply appears in the customer browser without manual refresh.
- Yousef is suppressed while Human Active.
- Return to Yousef restores automated replies.
- Internal Platform comment does not appear in public chat.
- Cancel before takeover returns to Yousef.
- Arabic human request enters waiting state with readable Arabic text.

## Platform live console corrective pass

The Platform Agent Conversations screen now behaves as a live support inbox instead of a static administrative table.

### Real-time transport

The current implementation uses controlled polling while the Agent screen is active:

- inbox list refreshes automatically about every 4 seconds;
- the selected active conversation refreshes automatically about every 3 seconds;
- the page shows a small `Live` / `Updating…` / `Reconnecting…` state;
- filters, selected conversation, unsent reply draft, review draft, and internal comment draft are preserved during refresh.

The database remains the source of truth. Messages are persisted first, then Platform/Public chat polling reads the updated conversation state.

### Waiting-message logic

`waitingCustomerMessageCount` is distinct from unread count.

- `Unread` means Platform has not opened/seen customer messages.
- `Waiting messages` means customer inbound messages are awaiting the currently responsible responder.

Rules:

- In `Human Active`, waiting count is customer inbound messages after the latest Platform staff outbound reply.
- In `Waiting for Human`, waiting timer starts from the human handoff mode change; customer messages after that point count as waiting.
- When Platform staff replies, waiting count resets because the latest staff reply becomes the new response boundary.
- If the customer sends new messages after the staff reply, waiting count starts again from that new message.

`waitingSince` is derived from the first unanswered customer message where applicable, or the handoff time for Waiting for Human.

### Inbox UX

The left pane is an independently scrollable conversation inbox. Rows are compact operational cards showing:

- customer name;
- `View` action;
- classification and channel;
- distinct mode state (`Yousef Active`, `Waiting for Human`, `Human Active`);
- waiting-message badge such as `● 2 waiting`;
- waiting timer;
- unread badge;
- latest message preview;
- assignee, total message count, and latest Dubai-time activity.

Waiting-for-human and human-active rows have separate visual treatments. Human-active rows with unanswered customer messages have a higher-attention marker.

### Active conversation UX

The right pane is an independently scrollable active conversation detail.

The top operational header separates:

- Mode — who should reply, Yousef or Platform staff;
- Assignee — staff owner;
- waiting-message count/timer;
- Take Over / Return to Yousef controls;
- Reply to Customer composer.

The reply composer is separate from internal comments. Website replies show to the visitor as `Tawseelhub Team`; Platform usernames are not exposed to the public endpoint.

### Review controls

Conversation Review now separates business workflow from live-chat mode:

- Status: business follow-up state, separate from AI/Human chat mode.
- Classification: what the conversation is about; used for routing, filtering, and reporting.
- Assignee: Platform staff owner/follow-up person.
- Follow-up Action: internal task/reminder.
- Review Note: internal status/follow-up note.

Internal Comments remain a separate private Platform-only section and are never sent to the customer.

### Transcript

The primary transcript renders as readable chat bubbles:

- `Yousef` for assistant messages;
- `Tawseelhub Team` for Platform staff replies;
- customer name or `Customer` for visitor messages.

Technical sender labels/directions are no longer the primary display. Arabic text is rendered per-message with RTL direction detection, so Arabic messages remain readable without forcing the whole transcript to RTL.
