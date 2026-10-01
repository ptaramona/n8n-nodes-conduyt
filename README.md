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
| Contact | Create, Get, Get Many, Search (by email or text), Update, Add Tags |
| Company | Create, Get, Get Many, Update |
| Deal | Create (with pipeline and stage pickers), Get, Get Many, Update |
| Task | Create, Get, Get Many, Update |
| Note | Create (on a contact or deal), Get Many |
| Message | Send (SMS or email to a contact), Get Many |
| Tag | Create, Get Many |

Tags on Create / Update Contact must already exist in your account. Custom fields are passed as a JSON object.

Message > Send gives every item its own idempotency key and keeps the evaluated request with it, so Retry On Fail and a manual Retry of a failed execution resend the same request under the same key and Conduyt does not send it twice. For SMS the key stays with the message. For email Conduyt keeps the key for 24 hours: a retry within 24 hours never sends twice, a retry after 24 hours sends the email again. Set Idempotency Key to supply your own, such as a record or event ID from the upstream item, sent exactly as given (SMS: 8 to 200 characters; email: up to 255): the key survives a worker crash between Conduyt accepting the request and n8n saving the run, which the generated key cannot, but the saved request snapshot does not survive that crash, so give the same key the same item data every time. Each key must belong to one item; reusing it for a different item or node is rejected. Left empty, the node generates a key, snapshot included, for retries of the same execution.

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
