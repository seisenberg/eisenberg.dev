# Security

This repository is public, and the system it describes handles private mail. Nothing here relies on
the code being secret: the design assumes an attacker has read all of it.

## Reporting a problem

Please do not open a public issue for a security problem. Use GitHub's private vulnerability
reporting for this repository (Security tab, "Report a vulnerability"), or write to
`security@eisenberg.dev`. You will get an answer within a few days.

## What is and is not in this repository

- No credentials, keys, account ids, hostnames of private infrastructure, or real mail. Runtime
  secrets live in AWS SSM Parameter Store and are read by the functions at start-up.
- The sign-in in `scripts/seed.ts` exists only for the throwaway local database that
  `npm run dev` creates. The production server refuses to start outside `NODE_ENV=production`,
  and production has no seeded user.
- Screenshots and test fixtures use invented people on reserved example domains.
- CI runs with read-only permissions. Deployment uses short-lived AWS credentials obtained through
  GitHub OIDC, limited to the `main` branch and the `production` environment. Pull requests from
  forks never receive credentials. See [docs/SETUP.md](docs/SETUP.md).

## How the system is protected

### Sign-in and sessions
- One login, stored as a scrypt hash. Optional TOTP two-factor (Security settings in the UI) with
  replay protection. Turning it on, changing the password, or running `user:set` signs out every
  other device.
- Session cookie flags: `__Host-eisenmail`, `HttpOnly`, `Secure`, `SameSite=Strict`. A session
  lasts 30 days from its last use (so a phone in regular use stays signed in) and is extended at
  most once a day. "Sign out other devices" and a password change end the others at once.
  The server refuses to start without `NODE_ENV=production`, so these cannot be switched off by
  a missing setting.
- Every `/api` route except login requires a session. Unknown API paths answer 401 to anonymous
  callers, so they reveal nothing.
- Throttling counts failures in the database, because Lambda instances share no memory. The client
  address is taken from the proxy-added end of `X-Forwarded-For` (`TRUSTED_PROXY_HOPS`), never from
  the client-supplied part.
- A browser that has signed in before holds a device cookie and is exempt from the per-username
  limit. Without that, anyone who knows the username could keep the owner locked out by failing
  logins from many addresses. The cookie grants nothing else: the password (and code) are still
  required, and the per-address limits still apply.

### Hostile email content
Inbound mail is attacker-controlled in every byte. The reading pane uses three independent layers,
so a failure of any one is not enough:
1. DOMPurify removes scripts, event handlers, forms, frames, embeds, SVG and `javascript:` links.
2. The result renders in a sandboxed `<iframe>` that does **not** have `allow-scripts`. Nothing in
   a message can execute, whatever the sanitiser missed.
3. A Content-Security-Policy inside the frame blocks every network load. Remote images (the usual
   open-tracking pixel) stay blocked until you click "Load remote content" for that message.

Plain-text bodies, subjects and sender names are rendered as text, never as HTML. Attachments are
always served as downloads with `Content-Disposition: attachment`, `nosniff` and a `sandbox` CSP.

### Sending
- The From address must be on a domain listed in `MAIL_DOMAINS`. Any local part is allowed.
- Recipients are validated. Subject and display name are stripped of control characters, so they
  cannot inject headers. Bcc recipients never appear in the stored or sent headers.
- No `X-Mailer` or client-identifying header is added.

### Reply relay (python)
A relayed reply is the one place a mistake would expose your private mailbox, so it is the most
defended and the most tested part (about 250 tests in `py/tests`).
- A reply is relayed only if the token exists, the From header holds exactly one address which is
  in `OWNER_ADDRESSES`, two different parsers and SES's own parse agree on that address, SES reports
  DMARC `PASS`, and it is not an auto-reply or bounce.
- The outgoing message is rebuilt. Only the body survives. Every header from your mail client is
  dropped (Received, originating IP, mailer, message id, DKIM signature).
- Your private address and the relay address are replaced inside quoted text, in every encoding.
- A final check scans the finished message (raw bytes, decoded headers, every decoded part) and
  refuses to send if a private or relay address is still present. You get a notice instead.
- Signed or encrypted replies cannot be rewritten safely and are refused with a notice.

Residual risks to be aware of: whoever controls your private mailbox can write as your aliases to
people who already wrote to them. Your name, signature and time zone are not rewritten. Metadata
inside attachments (photo EXIF, document properties) is not inspected. Relay tokens do not expire.

### Installed web app and push notifications
- The service worker has no fetch handler and caches nothing. Mail and attachments are never
  written to a browser cache, on a phone or anywhere else.
- A push subscription is a URL chosen by the browser, so it is never trusted. Both lambdas only
  send to `https` URLs on the push services of Apple, Google, Mozilla and Microsoft. Anything else
  is rejected when the device subscribes and skipped again before sending. Redirects are not followed.
- Notification content (sender, subject, receiving address) is encrypted end to end to the
  device. The push service cannot read it. It does appear on the lock screen unless you hide
  previews in the phone's notification settings.
- The VAPID private key is a secret: with it someone could send notifications to your devices,
  though not read anything. Keep it in SSM. Subscription URLs and keys are never returned by the API.
- Tapping a notification can only open a path on this site.
- Delivery rules can only be changed by the signed-in owner, for addresses on configured domains.

### File drop
- File names are restricted to a safe character set with no path separators, so a name can never
  address anything outside its prefix.
- The public route can only ever sign URLs for the public location. Marking a file public moves it
  there, and marking it private moves it back.
- Neither bucket needs a public policy. Downloads are presigned URLs that last 60 seconds (private)
  or 5 minutes (public). Upload URLs are bound to one name, one size and one content type.

### Database
- All SQL is parameterised. Message ids, cursors, addresses and domains are format-checked before
  they reach a query. Search input has its `LIKE` wildcards escaped.
- Permanent deletion is only possible from Trash or Junk, so it always takes two deliberate steps.

## Independent review

Before the first release, a second reviewer with no knowledge of the design audited the Node server and
the UI adversarially, probing the running app. It found no way to run script, read mail without
signing in, inject SQL or mail headers, or cross the private/public file boundary. It did find
the issues below. All are fixed, each with a regression test.

| Severity | Finding | Fix |
| --- | --- | --- |
| High | One crafted email could stop mail indexing for good: a NUL byte or broken Unicode in a header made the database insert fail, and the same message was retried first forever. | Every stored string is cleaned. Each message is indexed in its own savepoint. A message that still fails gets a placeholder and is marked done. |
| High | Cheap denial of service: an HTML-only message of deeply nested tags made the HTML-to-text step take minutes (2 MB took 41 s). | That converter is no longer used. Text comes from a bounded, linear conversion. Indexing is time-boxed. |
| Medium | An attacker who knew the username could keep the owner locked out from a handful of addresses. | Browsers that signed in before are exempt from the per-username limit. IPv6 addresses are counted per /64. |
| Medium | The failure limit was checked before the attempt was recorded, so a parallel burst could exceed it, including for two-factor codes. | Attempts are recorded first, under a per-user and per-address lock. A two-factor code is claimed atomically. |
| Medium | With `TRUSTED_PROXY_HOPS=2`, a request sent straight to the function URL could supply its own client address. | A chain shorter than expected never uses a client-supplied entry. |
| Medium | The tunnel host key was optional, with only a warning. | Required in production in both lambdas. |
| Medium | Forgetting `NODE_ENV=production` silently turned off secure cookies, HSTS, database TLS and real mail delivery. | The server refuses to start unless it is set. |
| Low | A crafted `<style>` block could smuggle form fields past the sanitiser into the (script-less, sandboxed) message frame. | Stylesheet text is escaped so it can never become markup. |
| Low | "Load remote content" could briefly carry over to the next message opened. | The choice is bound to one message. |
| Low | Overlapping private and public file prefixes were only rejected when identical. | Prefixes must end in `/` and must not overlap each other or the mail prefix. |

Known and accepted:
- Messages, attachments and raw source are sent in one piece, so anything over Lambda's 6 MB
  response limit cannot be opened until response streaming is switched on (see the README).
- A message is parsed again each time it is opened. This is bounded now, but storing the parsed
  result would be cheaper.
- Check after deploying that Security settings shows your real address under "Signed-in devices".
  If it shows a proxy address, `TRUSTED_PROXY_HOPS` is wrong for your setup.

## AWS settings the code relies on

**Tunnel account on the database host.** Create a user that can do nothing but forward to
postgres, and use it instead of `ubuntu`:

```
# /home/tunnel/.ssh/authorized_keys
restrict,port-forwarding,permitopen="127.0.0.1:5432",command="/bin/false" ssh-ed25519 AAAA... eisenmail
```

Store the private key as an SSM SecureString, set `SSH_TUNNEL_KEY_SSM` to its name, and set
`SSH_TUNNEL_HOST_KEY` to the output of `ssh-keyscan -t ed25519 <host>`. Limit port 22 on the host's
security group as far as you can. Longer term, RDS or Aurora Serverless with IAM authentication
removes the ssh key entirely, at higher cost. The code already supports a direct TLS connection:
leave `SSH_TUNNEL_HOST` unset.

**Database role.** Give the application its own role with only `SELECT, INSERT, UPDATE, DELETE` on
the eisenmail tables, not the database owner.

**IAM, web lambda:** `ses:SendEmail` and `ses:SendRawEmail` limited to your domain identities,
`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on the two file prefixes, `s3:ListBucket` on those
buckets, `s3:DeleteObject` on the mail prefix, and `ssm:GetParameter` on the one key parameter.

**IAM, inbox lambda:** `s3:GetObject` on the mail prefix, `ses:SendRawEmail`, `ses:SendBounce`,
and `ssm:GetParameter` on the one key parameter.

Both lambdas also need `ssm:GetParameter` on the VAPID private key parameter if you use push
notifications. The inbox lambda needs outbound internet access to reach the push services.

**Secrets.** `POSTGRES_DB_PASSWORD` in the Lambda environment is visible to anyone with
`lambda:GetFunctionConfiguration`. Keep that permission narrow, or move the value to SSM.

**SES.** DKIM, a custom MAIL FROM and a DMARC record on every domain. Without DMARC alignment your
relayed and webmail replies may land in spam, and other people can spoof your domains.

**S3.** Block Public Access on for every bucket. Default encryption on. Versioning on for the file
drop if you want protection from accidental deletes. CORS on the private bucket limited to your
site's origin, method `PUT`.

**Front door.** If you put CloudFront in front, set `TRUSTED_PROXY_HOPS=2` and allow only
CloudFront to invoke the function URL (origin access control), so nothing can reach it directly. Add an AWS WAF rate
rule on `/api/auth/login` and `/public/*` if you see abuse. Lambda reserved concurrency caps the
cost of a flood.
