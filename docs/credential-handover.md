# Credential handover

How a vendor credential gets from a person's password manager into
`platform_secrets` without passing through chat, GitHub, shell history, the
process table, or any log.

This is the runbook for the two credentials the transcription path needs. It
generalises to any future one, because the vault and the tool are not specific
to either.

---

## 0. What the vault actually is

Migration `20260903000003` created two tables and made one decision worth
restating before anyone runs a command against them:

**The application encrypts. The database holds ciphertext and no key.**

That is not a detail. It means a full database dump — a backup, a replica, a
compromised `service_role` — is inert on its own. It also means the encryption
key is the single point of failure: *lose it and every row in
`platform_secrets` is unrecoverable, permanently, with no support path.*

There is no `SECRET_ENCRYPTION_KEY`. The contract is a **key ring**: any
environment variable named `TUGPT_SECRET_KEY_<ID>` holding a base64-encoded
32-byte key becomes key id `<id>`, lowercased with `_` replaced by `.`. So:

| Environment variable            | Key id        |
| ------------------------------- | ------------- |
| `TUGPT_SECRET_KEY_PLATFORM_V1`  | `platform.v1` |
| `TUGPT_SECRET_KEY_ORG_V1`       | `org.v1`      |

A ring rather than a variable because rotation has to be possible: several keys
can be present at once, every row records which key encrypted it
(`platform_secrets.key_id`), and retiring a key is therefore a query —
"which rows are still on `platform.v1`" — rather than a guess.

---

## 1. Install the key ring (once per environment)

Run on the server, as root, in `/opt/tugpt`:

```bash
{ printf 'TUGPT_SECRET_KEY_PLATFORM_V1='; openssl rand -base64 32; } \
  | sudo tee -a /etc/tugpt/worker.env >/dev/null
```

Then confirm nothing else changed:

```bash
sudo stat -c '%a %U:%G %n' /etc/tugpt /etc/tugpt/worker.env
# expect: 700 root:root /etc/tugpt
#         600 root:root /etc/tugpt/worker.env
sudo grep -c TUGPT_SECRET_KEY_PLATFORM_V1 /etc/tugpt/worker.env   # expect 1
```

**Why it is shaped like that.** No secret appears on a command line, so nothing
reaches `~/.bash_history`. `printf` is a shell builtin, so no argv containing
the key is ever visible in `ps` or `/proc`. The key travels to `tee` over a
pipe. And the command *appends* rather than creating, because `/etc/tugpt` is
already `0700` and `worker.env` already `0600` — an `install -d -m 0750` here
would quietly loosen both.

### Back the key up before writing anything with it

Out of band — a password manager entry, not the repo and not a chat message.
The database holds no copy by design, so a lost key is not a recoverable
incident.

### What about `web.env`?

Nothing today: the web app reads no secrets from the vault. When the dashboard
grows the connected-accounts UI it will need the same key id present in its own
environment. That is a deploy-time change, not a re-encryption.

---

## 2. Store a credential

The workers run as Docker containers (see `docker-compose.yml`), so this is a
one-off container run rather than a host command. Overriding the command means
no poll loop starts, so it does not violate the one-consumer-per-queue rule at
the top of that file.

```bash
cd /opt/tugpt
sudo docker compose -p tugpt run --rm -it draft-worker \
  node dist/secrets-cli.js put --provider gladia --secret-name api_key
```

It prompts twice with echo off, compares the two entries, and refuses on
mismatch or empty. On success it prints one line of JSON:

```json
{"stored":"gladia/api_key","id":"…","keyId":"platform.v1","fingerprint":"3f9c2a1b7e05"}
```

The `fingerprint` is the first 12 hex characters of the SHA-256 of the value.
Keep it: months later it is how you confirm the stored key is the one you meant
without printing the key.

Then restart the workers so a running process picks it up on its next job:

```bash
sudo systemctl restart tugpt.service
```

### The credentials the transcription path needs

| Provider | Secret name          | What it is                                                            |
| -------- | -------------------- | --------------------------------------------------------------------- |
| `gladia` | `api_key`            | Gladia API key. Sent as `x-gladia-key`; Gladia does not use Bearer auth. |
| `meta`   | `graph_access_token` | Meta Graph token used **only** to download inbound audio.               |

The Meta token is a System User token from the WhatsApp Business account with
`whatsapp_business_messaging`. It is a standing credential and touches Meta
account configuration, so creating it is an owner decision, not an operational
step.

**It does not open outbound messaging.** The client that holds it issues GET
requests to two endpoints — the media metadata endpoint and the CDN URL that
returns — and has no code path that POSTs. `whatsapp_integration` still gates
every send, and `apps/worker/tests/outbound-gate.test.ts` asserts both of those
against the source rather than trusting them.

### What the tool refuses to do

- **Take the secret as an argument.** `--api-key`, `--secret`, `--token` and
  their siblings are rejected outright, not ignored: a flag that is silently
  dropped ends with an operator who believes the key was stored, walks away,
  and finds out at the first customer voice note — by which point the value is
  in shell history anyway.
- **Echo the value back**, in a prompt, a confirmation, an error, or a length.
  With echo off, a reported length is the main hint an onlooker gets.
- **Write anything on a mismatch.** A wrong key does not fail here; it fails
  later as a 401 from the vendor, on a path that looks like a provider outage.
- **Reach the database with plaintext.** Encryption happens in the process, so
  the statement log holds ciphertext.

---

## 3. Rotate a credential

The same command. `writePlatformSecret` upserts on
`(provider, secret_name)`, so re-running it replaces the row in place and the
next job picks up the new value — no deploy, no restart of anything but the
workers.

To rotate the **encryption key** rather than the credential:

1. Add `TUGPT_SECRET_KEY_PLATFORM_V2` alongside V1 in `worker.env`.
2. Re-store each credential with `--key-id platform.v2`.
3. Confirm nothing is left on the old key:
   `select provider, secret_name from platform_secrets where key_id = 'platform.v1';`
4. Only then remove `TUGPT_SECRET_KEY_PLATFORM_V1`.

Step 3 is the one that makes step 4 safe, and it is possible only because
`key_id` is a mandatory column. A store that could not answer "which rows use
key X" could never retire X, so the first compromised key would be compromised
forever.

---

## 4. Verifying without revealing

```sql
select provider, secret_name, key_id, algorithm,
       octet_length(ciphertext) as bytes, updated_at
from platform_secrets
order by provider, secret_name;
```

This says which credentials exist, which key opens each, and when each last
changed. It reveals nothing about their values, and it is the query to run
before enabling `voice_transcription` for anyone.

---

## 5. When a credential is missing

The transcription worker dead-letters the job with a code that names which
credential, so the dead-letter report is the diagnosis:

| `failed_jobs.error_code`               | Meaning                                                   |
| -------------------------------------- | --------------------------------------------------------- |
| `TRANSCRIPTION_PROVIDER_CONFIG_ERROR`  | No `gladia/api_key` row, or the key ring cannot open it.   |
| `TRANSCRIPTION_MEDIA_AUTH_ERROR`       | No `meta/graph_access_token` row, or Meta rejected it.     |
| `TRANSCRIPTION_PROVIDER_AUTH_ERROR`    | Gladia has a key and rejected it. Rotate, do not install.  |

**The honest cost of that design:** jobs claimed while a credential is missing
are dead-lettered rather than held, and there is no replay tooling. The
alternative — retrying — reaches the same answer three times and dead-letters
them anyway, just slower. So the safe order is: install the credentials, verify
with the query in §4, *then* enable `voice_transcription` for one organization.

Both flags ship false everywhere, so nothing reaches this path until someone
deliberately turns it on.
