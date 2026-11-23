# n8n-nodes-conduyt

Community node for [Conduyt CRM](https://conduyt.com) in [n8n](https://n8n.io). Create and update contacts, companies, deals, tasks and notes, send SMS or email to a contact, and start workflows from CRM events with a webhook trigger.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) · [Trigger](#trigger) · [Compatibility](#compatibility) · [Resources](#resources)

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/). Package name: `n8n-nodes-conduyt`.

## Credentials

1. In Conduyt, open **Settings > API & Webhooks** and create an API key (it starts with `cdy_`). Give it the scopes you need: `contacts`, `companies`, `deals`, `tasks`, `notes`, `messages`, `tags`, and `webhooks` for the trigger.
2. In n8n, create **Conduyt API** credentials and paste the key. Leave Base URL as `https://conduyt.app/api/v1` unless you run Conduyt on a custom domain.

## Operations

| Resource | Operations |
|---|---|
| Automation | Trigger Webhook (start an automation that has a webhook trigger) |
| Contact | Create, Get, Get Many, Search (by email or text), Update, Add Tags |
| Company | Create, Get, Get Many, Update |
| Deal | Create (with pipeline and stage pickers), Create for Contact (find or create the contact by phone or email, then create the deal, in one step), Get, Get Many, Update |
| Task | Create, Get, Get Many, Update |
| Note | Create (on a contact or deal), Get Many |
| Message | Send (SMS or email to a contact), Get Many |
| Tag | Create, Get Many |

Tags on Create / Update Contact must already exist in your account. Custom fields are passed as a JSON object (contacts and deals); deals also take a Source.

**Deal > Create for Contact** finds the contact by phone or email under Conduyt's duplicate rules (the name confirms a match, it never finds one) or creates it, and creates the deal on it, in one transaction. Give it an **Idempotency Key** built from your upstream event (at most 255 characters): sending the same key with the same data again returns the stored deal with `replayed: true` instead of creating a second one, and the same key with different data is rejected. Conduyt keeps the key for 24 hours. With a key, a copy of the same request that is still being processed (409) or a request Conduyt rolled back and asks to retry (503) is sent again under the same key every 3 seconds, up to **Wait for In-Flight Copy (Seconds)** (default 60); no other error is repeated. The key needs the `deals` and `contacts` scopes, plus `companies` edit when you send a company or email for a contact that already exists (Conduyt links it).

**Automation > Trigger Webhook** posts a JSON payload to an automation's webhook (`/api/v1/webhooks/automation/<id>`) without your API key (the receiver is public) and returns `{ ok, triggered, deduplicated, replayed }`. Conduyt runs the automation before it answers. **Fail If Nothing Ran** (on by default) fails the item when no automation ran (none matches the webhook, or it is switched off); a repeat Conduyt recognised (by the Idempotency Key, else by the identical body) is `deduplicated` and never a failure. A run with a failed step inside the automation still answers `triggered: 1`.

Message > Send gives every item its own idempotency key and keeps the evaluated request with it, so Retry On Fail and a manual Retry of a failed execution resend the same request under the same key rather than resend a request Conduyt already confirmed. An SMS whose delivery Conduyt could not confirm is reported on the item instead, flagged `deliveryUnconfirmed`, and is never retried by this node within the same saved run; the provider may already have delivered it, and you decide whether to send it again. That protection lives only in the run n8n saves after the report: if the worker crashes before n8n saves it, the retry has no record of the report, and Conduyt still allows another dispatch under the same key, caller-supplied or generated, so it can be sent again. Check the conversation (or your own log) before retrying a Message > Send node you cannot rule a crash out of. For email Conduyt keeps the key for 24 hours: a retry within 24 hours never sends twice, a retry after 24 hours sends the email again. Set Idempotency Key to supply your own, such as a record or event ID from the upstream item, sent exactly as given (SMS: 8 to 200 characters; email: up to 255): the key survives a worker crash between Conduyt accepting the request and n8n saving the run, which the generated key cannot, but the saved request snapshot does not survive that crash, so give the same key the same item data every time. Each key must belong to one item, with no leading or trailing whitespace; reusing it for a different item or node is rejected. Left empty, the node generates a key, snapshot included, for retries of the same execution.

## Trigger

**Conduyt Trigger** registers a webhook in your Conduyt account when the workflow is activated and removes it when deactivated. Pick one or more events, for example `contact.created`, `deal.won`, `form.submitted`, `message.received`, `appointment.booked`. Deliveries are verified against the `X-Conduyt-Signature` HMAC header using the secret Conduyt returns when the webhook is created.

The payload is `{ event, accountId, timestamp, data }` where `data` is the record that changed.

## Compatibility

Built and tested with n8n 1.x (n8n-workflow 1.48+). Node.js 18 or newer.

## Resources

- [Conduyt API reference](https://conduyt.app/api-reference)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## License

[MIT](LICENSE)
