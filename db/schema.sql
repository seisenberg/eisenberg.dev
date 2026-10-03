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
