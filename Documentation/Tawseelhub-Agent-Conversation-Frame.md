# Tawseelhub Agent Conversation Frame

Yousef uses a deterministic Conversation Frame before workflow handling and model replies. The frame answers one question first: what is the visitor doing in this turn?

## State model

- `mode`: `conversation`, `workflow`, or `human_handoff`
- `topic`: product area such as `trader`, `drivers`, `pricing`, `cod`, `integrations`, or `send_package`
- `workflow`: `none`, `shipment_quote`, `trader_registration`, `demo_request`, or `human_handoff`
- `workflowState`: `inactive`, `active`, `paused`, `cancelled`, or `completed`
- `lastExplicitUserAction`: `explain`, `start`, `continue`, `cancel`, `pause`, `switch_topic`, `clarify`, `handoff`, or `unknown`

## Precedence

The frame applies decisions in this order:

1. Human handoff
2. Privacy boundary
3. Explicit cancel
4. Explicit workflow start
5. Explicit workflow continuation
6. Clarification
7. Workflow pause for explanation
8. Bare informational topic
9. Current workflow slot response
10. General informational topic

## Workflow-start policy

Bare topics do not start workflows. Examples:

- `traders`
- `pricing`
- `drivers`
- `التجار`
- `إدارة السائقين`
- `السعر`

These are treated as explanation requests unless the visitor uses an explicit action signal such as:

- `I want to register my store`
- `I want a delivery quote`
- `Book a demo`
- `أريد التسجيل كتاجر`
- `أريد إرسال شحنة`
- `أريد ديمو`

## Identity collection

Public website conversations collect the visitor name, company/store name and email before normal assistance. This identity collection is not a workflow and must not trigger demo, Trader registration, shipment quote, or sales submission.

## Pause, cancel and clarification

If a visitor is inside a workflow and asks for explanation, the workflow is paused and Yousef answers the question. If the visitor explicitly says to continue, Yousef may resume the workflow. Clarification questions keep the active slot in place.

## Privacy

Yousef must not disclose private Delivery Company, Trader, customer, staff, financial, internal ID, credential or secret information. A privacy-boundary decision clears pending workflow action and returns a safe refusal.

## Logging

Frame decisions are emitted as structured application logs with sanitized context: decision, topic, mode, workflow and reason. Raw PII is not logged by the frame.
