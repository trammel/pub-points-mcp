# Confirmations

Eight tools change your account: they activate offers, redeem points or codes, join groups, claim the birthday gift, and change favourites or message settings. None of them acts on the assistant's say-so alone.

To take them away entirely, use [read-only mode](configuration.md#read-only-mode).

## Check, then ask

Every action tool first checks the request against your account: enough points, the offer is still open, the code really is a group code, and so on. Then it asks you before changing anything, in one of two ways.

- **If your MCP client supports elicitation**, the server asks you directly, through the client, with the exact action ("redeeming $10.00 credit for 1,000 points"). It acts only if you accept and tick Confirm. Declining or cancelling changes nothing. If the client says it supports elicitation but cannot ask (no handler for the request), you get the token below instead. A question that times out or fails any other way cancels the action.
- **Otherwise** the tool returns "Confirmation needed" with a single-use `confirmationToken`. The assistant must describe that action to you and, only if you agree, call the tool again with the same arguments plus the token. The token expires after 5 minutes and works once, only for the same tool and the same arguments.

Your MCP client will usually ask permission before running any tool as well.

## What a confirmation is bound to

Either way, the confirmation covers the specific thing you were shown, and the tool checks your account again before acting:

| Tool | A confirmation stops working if this changes |
|---|---|
| Redeem points | The reward's id, points cost or credit amount |
| Activate offer | The offer's id, value, type or reward strategy |
| Redeem a code, join an organisation | What kind of code the API says it is |
| Birthday gift | The gift's value |
| Add or remove a favourite | The venue (and, for removal, the favourite record) |
| Communication preferences | The exact set of switches to turn on and off |

Other changes do not void a confirmation, but the re-check still refuses anything no longer possible: for example, if your balance has dropped below the reward's cost, nothing is redeemed.

## When the outcome is unknown

If a write fails in a way that leaves its outcome unknown (a timeout, a network error or a server error), the tool says the action "may have been applied" and names the read tool to check with, so nothing is retried blindly.

A failed balance read after a successful write is reported as a note, not as an error: the write still happened.
