-- eisenmail schema. Idempotent: safe to run repeatedly against a new or an existing database
-- (the original lambda_email database only had lambda_inbox and webmail_users).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql

-- ---------------------------------------------------------------------------------------------
-- Raw mail store. One row per message, raw MIME kept verbatim.
--   inbound   received by SES, forwarded to the owner            (written by py/inbox.py)
--   junk      received by SES but failed SPF/DKIM/spam verdicts; stored, NOT forwarded (python)
--   relay_out the owner replied to a forward from their private mailbox; python rewrote the reply
--             and sent it to the correspondent from the alias address  (python)
--   sent      composed and sent from the webmail                    (written by the node backend)
-- The node backend indexes rows with processed_at is null into "messages".
-- ---------------------------------------------------------------------------------------------
create table if not exists lambda_inbox (
    message_id   text primary key,
    created_at   timestamp default current_timestamp,
    processed_at timestamp,
    s3_key       text,
    event        jsonb,
    email_raw    bytea
);
alter table lambda_inbox add column if not exists kind text not null default 'inbound';
alter table lambda_inbox add column if not exists meta jsonb;
do $$ begin
    alter table lambda_inbox add constraint lambda_inbox_kind_check
        check (kind in ('inbound', 'junk', 'relay_out', 'sent'));
exception when duplicate_object then null; end $$;
create index if not exists lambda_inbox_unprocessed on lambda_inbox (created_at) where processed_at is null;

-- meta for outbound kinds (relay_out, sent):
--   { "from": "alias@domain", "to": ["x@y"], "cc": [], "bcc": [], "in_reply_to_raw_id": "<lambda_inbox.message_id>|null" }
--   relay_out additionally: "relay_source_id" = SES messageId of the owner's reply (retry idempotency)
-- meta for inbound: { "forwarded": true } once the forward to the owner was sent (retry idempotency).
--   The node backend never writes meta on inbound rows.
create index if not exists lambda_inbox_relay_source on lambda_inbox ((meta ->> 'relay_source_id')) where kind = 'relay_out';

-- ---------------------------------------------------------------------------------------------
-- Reply relay (craigslist style). Every forward to the owner carries a relay address
-- reply-<token>@<domain>. When the owner replies to it, python looks the token up here and
-- re-sends the reply to the correspondent from the alias address.
-- ---------------------------------------------------------------------------------------------
create table if not exists relay_tokens (
    token              text primary key,            -- 32 lowercase hex chars (128 bits, secrets.token_hex)
    created_at         timestamptz not null default now(),
    inbox_message_id   text references lambda_inbox (message_id) on delete set null,
    alias_address      text not null,               -- our address that received the original; replies go out From it
    correspondent      text not null,               -- addr-spec replies are sent to (original Reply-To, else From)
    correspondent_name text,
    orig_message_id    text,                        -- Message-ID header of the original (In-Reply-To of the relayed reply)
    orig_references    text,                        -- References header of the original
    subject            text,
    last_used_at       timestamptz,
    use_count          int not null default 0
);
create index if not exists relay_tokens_inbox_message on relay_tokens (inbox_message_id);

-- ---------------------------------------------------------------------------------------------
-- Webmail index, maintained by the node backend from lambda_inbox.
-- ---------------------------------------------------------------------------------------------
create table if not exists messages (
    id                bigint generated always as identity primary key,
    raw_id            text not null unique references lambda_inbox (message_id) on delete cascade,
    direction         text not null check (direction in ('in', 'out')),
    mailbox           text not null check (mailbox in ('inbox', 'archive', 'trash', 'junk', 'sent')),
    prev_mailbox      text,                         -- where a trashed message came from (for "put back")
    addresses         text[] not null default '{}', -- OUR addresses on this message, lowercased:
                                                    --   inbound: SES envelope recipients; outbound: the From alias
    domains           text[] not null default '{}', -- domains of "addresses"
    from_name         text,
    from_addr         text,
    to_list           jsonb not null default '[]',  -- [{ "name": "", "address": "" }]
    cc_list           jsonb not null default '[]',
    reply_to          text,
    subject           text,
    snippet           text,
    body_text         text,                         -- plain text (capped) for search
    sent_at           timestamptz,                  -- Date header
    received_at       timestamptz not null default now(),
    message_id_header text,
    in_reply_to       text,
    refs              text[] not null default '{}',
    has_attachments   boolean not null default false,
    size_bytes        int,
    is_read           boolean not null default false,
    is_flagged        boolean not null default false,
    is_answered       boolean not null default false,
    auth              jsonb,                        -- SES verdicts { spf, dkim, dmarc, spam, virus }
    trashed_at        timestamptz
);
create index if not exists messages_mailbox_received on messages (mailbox, received_at desc, id desc);
create index if not exists messages_addresses on messages using gin (addresses);
create index if not exists messages_domains on messages using gin (domains);
create index if not exists messages_message_id_header on messages (message_id_header);

-- ---------------------------------------------------------------------------------------------
-- Webmail auth.
-- ---------------------------------------------------------------------------------------------
create table if not exists webmail_users (
    id         int generated always as identity,
    created_at timestamp default current_timestamp,
    email      text unique,                         -- the login name
    passhash   text                                 -- scrypt$N$r$p$salt_b64$hash_b64 (set with: npm run user:set)
);
alter table webmail_users add column if not exists totp_secret text;          -- base32; null = 2FA off
alter table webmail_users add column if not exists totp_last_step bigint;     -- replay protection
alter table webmail_users add column if not exists settings jsonb not null default '{}';
create unique index if not exists webmail_users_id on webmail_users (id);

create table if not exists webmail_sessions (
    token_hash   bytea primary key,                 -- sha256 of the cookie value; the token itself is never stored
    user_id      int not null,
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    expires_at   timestamptz not null,
    ip           text,
    user_agent   text
);
create index if not exists webmail_sessions_user on webmail_sessions (user_id);

-- Browsers that have signed in successfully before. A login attempt from one of them is exempt
-- from the per-username lockout, so an attacker hammering the login from many addresses cannot
-- lock the owner out of their own devices.
create table if not exists webmail_devices (
    token_hash   bytea primary key,                 -- sha256 of the device cookie
    user_id      int not null,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz not null default now()
);

create table if not exists webmail_login_attempts (
    id       bigint generated always as identity primary key,
    at       timestamptz not null default now(),
    username text not null,
    ip       text not null,
    success  boolean not null
);
create index if not exists webmail_login_attempts_at on webmail_login_attempts (at);

-- ---------------------------------------------------------------------------------------------
-- Delivery rules: what happens when mail arrives on a receiving address.
--   forward  send a copy to the owner's private mailbox (FORWARD_TO), with the reply relay
--   notify   send a push notification to the owner's installed web app(s)
-- The python lambda creates a row from mail_settings the first time an address receives mail, so
-- flipping the defaults later only affects addresses that have not been seen yet. The webmail
-- edits rows. Mail is always stored and shown in the webmail whatever the rule says.
-- ---------------------------------------------------------------------------------------------
create table if not exists mail_settings (
    id              boolean primary key default true check (id),   -- single row
    default_forward boolean not null default true,
    default_notify  boolean not null default true,
    updated_at      timestamptz not null default now()
);
insert into mail_settings (id) values (true) on conflict (id) do nothing;

create table if not exists address_rules (
    address    text primary key,                  -- lowercased receiving address
    forward    boolean not null,
    notify     boolean not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- How a forward is laid out, per address (it used to be one global FORWARD_STYLE setting):
--   inline  the original message body, so a reply quotes it naturally
--   attach  a short summary with the original attached as a message/rfc822 file
alter table mail_settings add column if not exists default_forward_style text not null default 'inline';
alter table address_rules add column if not exists forward_style text not null default 'inline';
do $$ begin
    alter table mail_settings add constraint mail_settings_forward_style_check check (default_forward_style in ('inline', 'attach'));
exception when duplicate_object then null; end $$;
do $$ begin
    alter table address_rules add constraint address_rules_forward_style_check check (forward_style in ('inline', 'attach'));
exception when duplicate_object then null; end $$;

-- Where an address forwards to. null: the deployment's FORWARD_TO (the owner's private mailbox).
-- A list makes the address a small group: every mailbox in it receives the forward, and each of
-- them may answer through the reply relay. relay_tokens.forwarded_to records who a particular
-- forward went to, which is who may answer it.
alter table address_rules add column if not exists forward_to text[];
alter table relay_tokens add column if not exists forwarded_to text[];

-- Web Push subscriptions of the owner's browsers / installed web apps (written by the node backend,
-- read by both lambdas). Rows are removed when the push service reports the subscription gone.
create table if not exists push_subscriptions (
    endpoint        text primary key,             -- push service URL (https, allow-listed hosts only)
    p256dh          text not null,                -- client public key, base64url
    auth            text not null,                -- client auth secret, base64url
    user_id         int not null,
    user_agent      text,
    created_at      timestamptz not null default now(),
    last_success_at timestamptz,
    failure_count   int not null default 0
);

-- =============================================================================================
-- Additions (2026-10): schema bookkeeping, users and roles, passkeys, recovery codes, blocked
-- addresses and notes, retention, conversations, drafts, filters, delivery log.
-- =============================================================================================

-- The web lambda applies this file at start-up when its hash differs from the one stored here.
create table if not exists schema_meta (
    id         boolean primary key default true check (id),
    hash       text not null,
    applied_at timestamptz not null default now()
);

-- ---- users: an owner sees everything; a member sees only the listed domains -----------------
alter table webmail_users add column if not exists role text not null default 'owner';
alter table webmail_users add column if not exists domains text[];            -- members only; null for owners
alter table webmail_users add column if not exists signature text not null default '';
do $$ begin
    alter table webmail_users add constraint webmail_users_role_check check (role in ('owner', 'member'));
exception when duplicate_object then null; end $$;

-- One-time codes that replace the authenticator code when the phone is lost.
create table if not exists webmail_recovery_codes (
    code_hash  bytea primary key,                 -- sha256 of the code
    user_id    int not null,
    created_at timestamptz not null default now(),
    used_at    timestamptz
);
create index if not exists webmail_recovery_codes_user on webmail_recovery_codes (user_id);

-- Passkeys (WebAuthn).
create table if not exists webauthn_credentials (
    credential_id text primary key,               -- base64url
    user_id       int not null,
    public_key    bytea not null,                 -- COSE key
    counter       bigint not null default 0,
    transports    text[] not null default '{}',
    name          text not null default 'Passkey',
    created_at    timestamptz not null default now(),
    last_used_at  timestamptz
);
create index if not exists webauthn_credentials_user on webauthn_credentials (user_id);

create table if not exists webauthn_challenges (
    id         uuid primary key,
    challenge  text not null,
    kind       text not null check (kind in ('register', 'login')),
    user_id    int,
    expires_at timestamptz not null
);

-- ---- addresses: block a leaked alias, remember who it was given to ------------------------------
--   blocked: mail to this address is dropped on arrival (python), counted here, never stored.
alter table address_rules add column if not exists blocked boolean not null default false;
alter table address_rules add column if not exists note text not null default '';
alter table address_rules add column if not exists blocked_count int not null default 0;
alter table address_rules add column if not exists last_blocked_at timestamptz;

-- ---- retention: Trash and Junk empty themselves ---------------------------------------------------
alter table mail_settings add column if not exists purge_after_days int not null default 30;
alter table mail_settings add column if not exists last_purge_at timestamptz;

-- ---- conversations ---------------------------------------------------------------------------------
alter table messages add column if not exists thread_id bigint;
create index if not exists messages_thread on messages (thread_id);
update messages set thread_id = id where thread_id is null;
-- join replies to the conversation of the message they answer (repeat until stable)
do $$
declare changed int;
begin
    for i in 1..25 loop
        update messages m set thread_id = least(m.thread_id, p.thread_id)
          from messages p
         where p.message_id_header is not null
           and (p.message_id_header = m.in_reply_to or p.message_id_header = any (m.refs))
           and p.thread_id < m.thread_id;
        get diagnostics changed = row_count;
        exit when changed = 0;
    end loop;
end $$;

-- ---- drafts (autosaved by the compose window) ----------------------------------------------------
create table if not exists drafts (
    id         uuid primary key,                  -- chosen by the client
    user_id    int not null,
    updated_at timestamptz not null default now(),
    payload    jsonb not null                     -- { mode, from, fromName, to, cc, bcc, subject, text, inReplyToId, forwardAttachments }
);
create index if not exists drafts_user on drafts (user_id, updated_at desc);

-- ---- filters: applied when a received message is indexed ---------------------------------------
--   every non-empty match_* must be contained in the corresponding field (case-insensitive)
create table if not exists mail_filters (
    id            bigint generated always as identity primary key,
    position      int not null default 0,
    enabled       boolean not null default true,
    match_from    text not null default '',       -- sender name or address contains
    match_subject text not null default '',       -- subject contains
    match_address text not null default '',       -- one of OUR receiving addresses contains
    action        text not null check (action in ('archive', 'read', 'flag', 'junk', 'trash')),
    created_at    timestamptz not null default now()
);

-- ---- delivery log: one row per SES message the python lambda has finished with --------------------
-- Lets the scheduled reconcile job tell "never processed" (replay it from S3) from "processed and
-- deliberately not stored" (virus, DMARC reject, blocked address, relayed owner reply).
create table if not exists inbox_log (
    message_id text primary key,                  -- SES messageId
    outcome    text not null,
    at         timestamptz not null default now()
);
create index if not exists inbox_log_at on inbox_log (at);

-- Usernames are compared case-insensitively at sign-in, so they must be unique that way too.
create unique index if not exists webmail_users_email_lower on webmail_users (lower(email));

-- Key for signing image-proxy links (generated on first use). A link is only valid for the exact
-- image address it was issued for.
alter table mail_settings add column if not exists proxy_secret text;

-- ---------------------------------------------------------------------------------------------
-- Authenticator: one-time-code secrets for OTHER services, kept per user. The secret is stored
-- encrypted (AES-256-GCM) with a key that lives in SSM, not in this database, so a copy of the
-- database or of a backup does not contain usable secrets.
-- ---------------------------------------------------------------------------------------------
create table if not exists totp_entries (
    id         bigint generated always as identity primary key,
    user_id    int not null,
    issuer     text not null default '',
    account    text not null default '',
    secret_enc bytea not null,                    -- iv (12) | auth tag (16) | ciphertext
    algorithm  text not null default 'SHA1' check (algorithm in ('SHA1', 'SHA256', 'SHA512')),
    digits     int not null default 6 check (digits between 6 and 8),
    period     int not null default 30 check (period between 10 and 300),
    created_at timestamptz not null default now()
);
create index if not exists totp_entries_user on totp_entries (user_id, id);

-- ---------------------------------------------------------------------------------------------
-- Sign-in check by email: a six digit code sent to a mailbox OUTSIDE this system.
-- ---------------------------------------------------------------------------------------------
alter table webmail_users add column if not exists verify_email text;
create table if not exists login_challenges (
    id         uuid primary key,
    user_id    int not null,
    purpose    text not null check (purpose in ('login', 'set_email')),
    email      text not null,                     -- where the code was sent
    code_hash  bytea not null,                    -- sha256 of the code
    attempts   int not null default 0,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
);
create index if not exists login_challenges_user on login_challenges (user_id, created_at desc);

-- how a session was started: a fresh password sign-in may add a passkey without retyping the password
alter table webmail_sessions add column if not exists method text not null default 'password';

-- ---------------------------------------------------------------------------------------------
-- People: an address book per sign-in. Rows appear by themselves when mail arrives or is sent
-- (src/server/people.ts) and can be made and edited by hand. A member's book is built only from
-- mail that member can see.
-- ---------------------------------------------------------------------------------------------
create table if not exists contacts (
    id          bigint generated always as identity primary key,
    user_id     int not null references webmail_users (id) on delete cascade,
    name        text not null default '',
    company     text not null default '',
    note        text not null default '',
    source      text not null default 'mail' check (source in ('mail', 'manual')),
    hidden      boolean not null default false,   -- "not a person": out of the list and of autocomplete
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists contacts_user on contacts (user_id, hidden, name);

-- An address belongs to exactly one contact per book; a contact can have several.
create table if not exists contact_addresses (
    user_id     int not null references webmail_users (id) on delete cascade,
    address     text not null,                         -- lowercased
    contact_id  bigint not null references contacts (id) on delete cascade,
    name_seen   text not null default '',              -- the display name the other side used last
    first_seen  timestamptz not null default now(),
    last_seen   timestamptz,
    received    int not null default 0,                -- messages from this address
    sent        int not null default 0,                -- messages written to it
    primary key (user_id, address)
);
create index if not exists contact_addresses_contact on contact_addresses (contact_id);

-- "all mail with this person"
create index if not exists messages_from_addr_lower on messages (lower(from_addr));
