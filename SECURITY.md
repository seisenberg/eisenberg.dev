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
  `npm run dev` creates, and that dev server listens on loopback only. The production server
  refuses to start outside `NODE_ENV=production`, and production has no seeded user.
- Screenshots and test fixtures use invented people on reserved example domains.
- CI runs with read-only permissions. Deployment uses short-lived AWS credentials obtained through
  GitHub OIDC, limited to the `main` branch and the `production` environment. Pull requests from
  forks never receive credentials. See [docs/SETUP.md](docs/SETUP.md).

## How the system is protected

### Sign-in and sessions
- Passwords are stored as scrypt hashes. Optional TOTP two-factor with replay protection, plus ten
  one-time recovery codes (stored as hashes, shown once). Turning two-factor on, changing the
  password, or running `user:set` signs out every other device.
- **Passkeys** (WebAuthn) sign in on their own, with user verification required. Challenges are
  single-use database rows with a five minute life. The sign-in request offers no credential list,
  so it reveals nothing about which accounts exist. Adding a passkey needs the password again,
  with one exception: a session that was created by a password sign-in less than ten minutes ago
  may add one directly (the offer shown after sign-in). A session created by a passkey never
  counts as fresh.
- **Sign-in code by email.** An account with a verification mailbox and no authenticator app must
  also enter a six digit code that is mailed after the password was accepted. Codes are stored as
  hashes, live ten minutes, are single use, and die after five wrong tries. Only the newest code
  is valid. At most one code a minute and six an hour are sent, and none unless the password was
  right, so someone without the password cannot fill the mailbox. Wrong codes count toward the login throttle. The
  mailbox must be outside the domains this system receives for, and it is confirmed with a code
  before the check is switched on. The response shows the address masked.
- **Authenticator vault** (the Codes page). Secrets of other sites' two-factor are encrypted with
  AES-256-GCM under a key that is not in the database (SSM parameter, readable by the web
  function's role only and explicitly denied to the inbox function). Each record is bound to its
  owner as authenticated data, so a row copied to another user does not decrypt. The API returns
  the current and next code and never the secret; there is no export. Database dumps and
  snapshots therefore do not contain usable secrets.
- **Members** are separate sign-ins limited to chosen domains. The restriction is applied inside
  every mail query, not in the interface: a message the member may not see answers "not found"
  whether it is read, changed, downloaded or replied to. Members cannot use the file drop, manage
  users, or change global settings. Owners can only be created from the command line.
- The site is served on one name. Requests for its `www.` name get a permanent redirect whose
  target is always the site's own origin, with only the path and query carried over, and nothing
  else is reachable there: no API, no sign-in.
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
Inbound mail is attacker-controlled in every byte. The reading pane uses independent layers, so a
failure of any one is not enough:
1. DOMPurify removes scripts, event handlers, forms, frames, embeds, SVG and `javascript:` links.
2. The result renders in a sandboxed `<iframe>` that does **not** have `allow-scripts`. Nothing in
   a message can execute, whatever the sanitiser missed.
3. A Content-Security-Policy inside the frame, and the site's own, allow images from this site and
   nothing else. The browser cannot contact a sender's server at all.

### Remote images and the image proxy
Remote images are replaced by same-size placeholders. Loading them reveals that the message was
opened, so it happens only on request, and then through the server: the sender sees an AWS
address and a generic user agent, never the reader's IP address, browser, cookies or referrer.

A proxy that fetches addresses chosen by strangers must not be usable against internal services.
- A link is issued only for an address that occurs in a message the viewer can open, and it is
  signed. The proxy route cannot be pointed at anything else.
- Only `http` and `https` on their standard ports. No credentials, no literal IP addresses.
- The host name is resolved by the server. Every address it resolves to must be public: loopback,
  private, link-local (cloud metadata), carrier NAT, multicast and reserved ranges are refused. The
  connection is pinned to the address that was checked, so DNS cannot change the answer in between.
- Redirects are followed by hand, at most four, each checked the same way.
- The response must be a raster image, judged from its first bytes and not from the header the
  remote server sends. SVG and anything else is refused. It is size capped and served with a
  `sandbox` policy and `nosniff`, so it can never act as a document on this site.

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
  in `OWNER_ADDRESSES` or is one of the mailboxes that very forward was sent to, two different
  parsers and SES's own parse agree on that address, SES reports DMARC `PASS`, and it is not an
  auto-reply or bounce.
- An address can forward to its own list of outside mailboxes (a group). Only the owner can set
  that list, and a member never sees it or removes it. A mailbox on a domain this system receives
  for is refused (it would loop).
- A message to several addresses is forwarded once per list: addresses with different mailboxes
  get separate forwards, each with its own token. So the people behind one address never see the
  mailboxes of another, and can only answer as an address they receive for. The default mailboxes
  (`FORWARD_TO`) get no such right from receiving a forward: for them `OWNER_ADDRESSES` decides.
- Every mailbox on any list counts as private: all of them are scrubbed from a relayed reply and
  looked for by the final scan. The one exception is the correspondent's own address.
- Mail that arrives on a `reply-<token>@` address without being relayed (a refused reply, an
  out-of-office) is stored for the owner only. Members of that domain neither see it nor get a
  notification, because it shows a private mailbox's address.
- The outgoing message is rebuilt. Only the body survives. Every header from your mail client is
  dropped (Received, originating IP, mailer, message id, DKIM signature).
- Your private address and the relay address are replaced inside quoted text, in every encoding.
- A final check scans the finished message (raw bytes, decoded headers, every decoded part) and
  refuses to send if a private or relay address is still present. You get a notice instead.
- Signed or encrypted replies cannot be rewritten safely and are refused with a notice.

Residual risks to be aware of: whoever controls your private mailbox can write as your aliases to
people who already wrote to them. The same holds for each mailbox on an address's forward list,
for the mail that was forwarded to it, and it stays true for that mail after the mailbox is taken
off the list. The people on one list see each other's addresses on the forward. Your name, signature and time zone are not rewritten. Metadata
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

### Delivery, blocking and replay (python)
- Mail to a blocked address is dropped before anything is stored, forwarded or notified.
- A scheduled job replays messages that reached S3 but were never processed. A replayed message
  is never relayed as an owner reply, whatever its headers say, because the evidence SES gave at
  delivery time (the DMARC verdict) is not available for a replay. Its verdicts are read only from
  the header block SES itself wrote, identified by the message id, so headers supplied by the
  sender cannot stand in for them.

### Database
- The schema is applied by the web function at start-up when `db/schema.sql` has changed, under an
  advisory lock. The file only ever adds.
- Backups: the database host can write dumps to the backup bucket but cannot read or delete
  them, so a compromised host cannot destroy its own history.
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

### Second review: members, passkeys, recovery codes

When additional users and passkeys were added, that code was reviewed the same way. The reviewer
confirmed that a member cannot read, change, delete or send as another domain, that every
owner-only function is gated, and that passkey challenges, recovery codes and the start-up
migration behave correctly under concurrency. It found six lower-severity gaps, all fixed with
tests:

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | Notification subscriptions and passkeys survived a password change or reset, so someone who had the old password could keep receiving mail previews or keep signing in. | A password change or reset now removes passkeys, trusted browsers and notification subscriptions. Signing out removes that device's subscription. |
| Low | Any outside sender could plant a look-alike address at the top of recipient autocomplete. | People actually written to always rank first, and a display name that imitates an address is not shown. |
| Low | A member could discover an address on another domain that shared a message with them, through search, folder filters or a notification. | Search, filters and notifications only ever use addresses on the member's own domains. |
| Low | The conversation size shown to a member counted messages they could not see. | Counted per viewer. |
| Low | A member with many devices could crowd the owner out of notifications. | At most five devices per user, owners first. |
| Low | A member could block an address, which outlived the member. | Blocking is owner-only. Rules are capped per domain. |

### Third review: authenticator vault, sign-in code by email, the passkey offer

The reviewer confirmed that a wrong password looks the same whether or not the account uses the
email check, that no code is mailed without the right password, that codes are bound to the user
and single use under races, that the vault uses a fresh nonce per record with the owner bound in,
and that secrets appear in no response or log. It found seven gaps, all fixed with tests:

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | After asking for a second code, wrong guesses were counted on the newest code only, while an older live code could still be matched: the five-try limit could be sidestepped. | Sending a code ends every earlier one. Counting the try and comparing the code happen in one statement, and a used-up code is never compared again. |
| Medium | A Google Authenticator export with a negative batch number was rejected as damaged. | The reader accepts the full ten-byte number form. |
| Low | The mailbox for sign-in codes survived a password reset, including one somebody else had planted. | A reset from the command line or by the owner switches the email check off unless a mailbox is given again. A password change names the mailbox the codes go to. |
| Low | Correcting a mistyped mailbox within a minute reported "sent" although nothing was sent, and the first address could still be confirmed. | The answer is "wait a minute", and the earlier code is dead once a new one is sent. |
| Low | The command-line `--email` was not validated. | Same rule as in the settings. |
| Low | Removing a member left their encrypted authenticator entries and pending codes behind. | Removed with the member. |
| Low | A malformed setup link produced a server error instead of a refusal. | Refused as invalid. |

Two things are by design. A session can add a passkey without the password for ten minutes after
a password sign-in, so a session stolen in that window could add one; passkeys are listed in the
settings and removed by a password change. And the owner operates the system and holds the vault
key, so a member's authenticator entries are not protected from the owner.

### Fourth review: addresses that forward to a group

Per-address forward lists change who may answer through the relay, so that change was reviewed
before it shipped. Seven findings, all fixed with tests:

| Severity | Finding | Fix |
| --- | --- | --- |
| High | A message to several addresses was forwarded once to all their mailboxes together. The lists saw each other and the owner's mailbox, and anyone on one list could answer as the first address. | One forward and one token per list, made for an address of that list. |
| Medium | Every default mailbox became an allowed sender, bypassing `OWNER_ADDRESSES`. | Only an address's own list is recorded as allowed to answer. |
| Medium | A reply was blocked when the correspondent was on a list, or when a list mailbox was the tail of the correspondent's address. | The correspondent's own address is not treated as private, and is skipped where it stands in full. |
| Medium | A member's "Reset to the defaults" removed the owner's forward list, or a block. | A member's reset only puts the switches back. |
| Low | A notice about a reply that could not be sent went to the whole list instead of its writer. | It goes to the writer. |
| Low | A refused reply was visible to members of that domain in the webmail and announced to them. | Owner only. |
| Low | The list of mailboxes to scrub was capped. | All of them are read. |

## AWS settings the code relies on

The CloudFormation templates in `infra/` create all of this. It is listed here so the reasoning is
in one place.

**Database host.** PostgreSQL listens on localhost only. The functions reach it through an ssh
account that can do exactly one thing, forward a port to PostgreSQL:

```
restrict,port-forwarding,permitopen="127.0.0.1:5432",command="/bin/false" ssh-ed25519 AAAA... eisenmail
```

The key pair is generated on the host. The private half goes straight into SSM Parameter Store
and is deleted from the disk, so no person ever handles it. The functions pin the host's public
key and refuse to connect to anything else. Administrative access is through Session Manager, so
there is no personal ssh key and password logins are off. Port 22 is open to the internet because
Lambda has no fixed addresses. The tunnel account is the only one reachable by key. The code
also supports a direct TLS connection (RDS, for example) by leaving the tunnel unset.

**Secrets.** The database password, the tunnel key and the push signing key are SSM SecureStrings
under `/eisenmail/`, read by the functions at runtime. None appears in a template parameter, a
Lambda environment variable, a container image, or a GitHub secret.

**IAM, web function:** send mail through SES for the account's identities. Read, write and delete
objects under the file drop prefixes and the `tmp/` staging prefix. List those two buckets. Delete
raw mail objects. Read its own SSM parameters.

**IAM, inbox function:** read and list raw mail under its prefix. Send and bounce through SES. Read
its own SSM parameters.

**IAM, database host:** write (not read, not delete) backups. Write its three SSM parameters.
Publish one backup metric.

**IAM, GitHub deploy role:** push images to one repository, update the code of the two functions,
invoke the web function once per deploy for a health check. Assumable only by this repository's
`production` environment through OIDC.

**SES.** DKIM, a custom MAIL FROM and a DMARC record on every domain. Without DMARC alignment
relayed and webmail replies may land in spam, and other people can spoof the domains.

**S3.** Block Public Access on every bucket, default encryption, TLS-only bucket policies. The file
drop is versioned. Browser uploads are limited by CORS to the site's own origin.

**Front door.** API Gateway throttles requests, which caps what a flood can cost. If CloudFront is
ever put in front, set `TrustedProxyHops=2` and allow only CloudFront to reach the API.

**Alarms.** Function errors, API 5xx responses, SES bounce and complaint rates, and a missing
nightly backup all notify the address given as `AlertEmail`.
