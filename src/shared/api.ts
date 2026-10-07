// Types shared by the node backend and the UI. Types only: nothing here may have runtime behaviour.

export type Mailbox = 'inbox' | 'archive' | 'trash' | 'junk' | 'sent';
/** What the message list can be scoped to. "flagged" is a virtual mailbox. */
export type MailboxView = Mailbox | 'flagged';

export interface Person {
  name: string;
  address: string;
}

export interface Counts {
  total: number;
  unread: number;
}

export interface AddressNode extends Counts {
  address: string;
}

export interface DomainNode extends Counts {
  domain: string;
  /** Receiving addresses that currently have mail in the inbox. Empty addresses are not listed. */
  addresses: AddressNode[];
}

export interface MailboxTree {
  inbox: Counts;
  flagged: Counts;
  sent: Counts;
  archive: Counts;
  junk: Counts;
  trash: Counts;
  domains: DomainNode[];
}

export interface MessageSummary {
  id: string;
  direction: 'in' | 'out';
  mailbox: Mailbox;
  /** Our addresses on this message: the receiving addresses (inbound) or the sending alias (outbound). */
  addresses: string[];
  from: Person;
  to: Person[];
  subject: string;
  snippet: string;
  date: string;
  isRead: boolean;
  isFlagged: boolean;
  isAnswered: boolean;
  hasAttachments: boolean;
  /** conversation this message belongs to, and how many messages it has */
  threadId: string;
  threadCount: number;
}

export interface AttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  /** an image the browser can show safely in place */
  previewable: boolean;
}

export interface MessageDetail extends MessageSummary {
  cc: Person[];
  replyTo: Person[];
  /** Raw, UNSANITISED html from the sender. The UI must sanitise it and render it sandboxed. */
  html: string | null;
  text: string;
  attachments: AttachmentInfo[];
  messageIdHeader: string | null;
  auth: Record<string, string> | null;
  /** The address a reply should be sent from by default. */
  replyFrom: string;
  /** The whole conversation, oldest first (includes this message). */
  thread: MessageSummary[];
}

export interface MessageList {
  messages: MessageSummary[];
  nextCursor: string | null;
}

export interface MessagePatch {
  ids: string[];
  set: {
    isRead?: boolean;
    isFlagged?: boolean;
    /** "restore" puts a trashed/junked message back where it came from. */
    mailbox?: 'inbox' | 'archive' | 'trash' | 'junk' | 'restore';
  };
}

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  /** base64 */
  content: string;
}

export interface SendRequest {
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  /** id of the message being replied to or forwarded (sets threading headers, marks it answered). */
  inReplyToId?: string;
  /** forward: re-attach these attachment indexes of inReplyToId. */
  forwardAttachments?: number[];
  attachments?: OutgoingAttachment[];
  /** the autosaved draft this message was written in; deleted once sent */
  draftId?: string;
}

export interface Identities {
  /** Domains mail may be sent from. */
  domains: string[];
  /** Addresses seen so far (received on, or sent from), most recently used first. */
  addresses: string[];
  defaultFrom: string | null;
}

export interface FileEntry {
  name: string;
  size: number;
  modified: string;
  isPublic: boolean;
  /** Path on this site where anyone can download the file (public files only). */
  publicPath: string | null;
}

export interface FileListing {
  files: FileEntry[];
  maxBytes: number;
}

export interface UploadTicket {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

export interface SessionUser {
  username: string;
  totpEnabled: boolean;
  /** owner: everything. member: mail for `domains` only, no file drop, no user management. */
  role: 'owner' | 'member';
  domains: string[] | null;
  /** masked address that sign-in codes are emailed to, or null when the email check is off */
  emailCheck: string | null;
  /** true right after a password sign-in: a passkey may be added without retyping the password */
  fresh?: boolean;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
}

export interface ApiError {
  error: string;
  /** machine readable, e.g. "totp_required" */
  code?: string;
}

// ---- delivery rules -------------------------------------------------------------------------

export type ForwardStyle = 'inline' | 'attach';

export interface DeliveryRule {
  address: string;
  /** mail to a blocked address is dropped on arrival */
  blocked: boolean;
  /** how many messages were dropped since it was blocked */
  blockedCount: number;
  /** free text: who this address was given to */
  note: string;
  /** messages received on this address that are still stored, and when the last one came */
  total: number;
  lastReceived: string | null;
  /** forward a copy to the private mailbox */
  forward: boolean;
  /** push notification to installed web apps */
  notify: boolean;
  /** how a forward is laid out: the original inline, or a summary with the original attached */
  forwardStyle: ForwardStyle;
  /**
   * Mailboxes this address forwards to instead of the default private mailbox. Each of them
   * receives the forward and may answer it through the reply relay. Empty: the default mailbox.
   * Only the owner sees and sets this (a member always gets an empty list).
   */
  forwardTo: string[];
  /** false: no rule stored yet, the values shown are the current defaults */
  explicit: boolean;
}

export interface DeliveryRules {
  /** applied to addresses the first time they receive mail */
  defaults: { forward: boolean; notify: boolean; forwardStyle: ForwardStyle };
  rules: DeliveryRule[];
}

// ---- push notifications ---------------------------------------------------------------------

export interface PushDevice {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
}

export interface PushStatus {
  /** false when the server has no VAPID keys configured */
  available: boolean;
  publicKey: string | null;
  devices: PushDevice[];
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// ---- drafts, contacts, settings, filters ------------------------------------------------------

export interface DraftPayload {
  mode: 'new' | 'reply' | 'replyAll' | 'forward';
  from: string;
  fromName?: string;
  to: string;
  cc: string;
  bcc?: string;
  subject: string;
  text: string;
  inReplyToId?: string;
  forwardAttachments?: number[];
  forwardedNames?: string[];
}

export interface Draft {
  id: string;
  updatedAt: string;
  payload: DraftPayload;
}

export interface Contact {
  name: string;
  address: string;
}

// ---- people (the address book) ---------------------------------------------------------------

export interface PersonSummary {
  id: string;
  name: string;
  company: string;
  /** out of the list and of autocomplete: a newsletter, a no-reply sender */
  hidden: boolean;
  /** made or edited by hand (otherwise it came from mail) */
  manual: boolean;
  addresses: string[];
  lastSeen: string | null;
  /** messages received from and sent to this person */
  messages: number;
}

export interface PersonAddress {
  address: string;
  /** the display name the other side used last */
  nameSeen: string;
  firstSeen: string;
  lastSeen: string | null;
  received: number;
  sent: number;
}

export interface PersonDetail {
  id: string;
  name: string;
  company: string;
  note: string;
  hidden: boolean;
  manual: boolean;
  createdAt: string;
  addresses: PersonAddress[];
}

export interface PersonInput {
  name?: string;
  company?: string;
  note?: string;
  hidden?: boolean;
  /** the full list; an address of another person moves over (merge) */
  addresses?: string[] | string;
}

export type FilterAction = 'archive' | 'read' | 'flag' | 'junk' | 'trash';

export interface MailFilter {
  id: string;
  enabled: boolean;
  matchFrom: string;
  matchSubject: string;
  matchAddress: string;
  action: FilterAction;
}

export interface MailSettings {
  signature: string;
  /** Trash and Junk are emptied of messages older than this */
  purgeAfterDays: number;
  /** owner only; empty for members */
  filters: MailFilter[];
}

// ---- users, passkeys ----------------------------------------------------------------------------

export interface UserInfo {
  id: number;
  username: string;
  role: 'owner' | 'member';
  domains: string[] | null;
  totpEnabled: boolean;
  passkeys: number;
  createdAt: string;
}

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// ---- authenticator ------------------------------------------------------------------------------

export interface OtpEntry {
  id: string;
  issuer: string;
  account: string;
  /** the code right now */
  code: string;
  /** the code that follows it, shown when the current one is about to expire */
  next: string;
  period: number;
  /** seconds until `code` expires */
  remaining: number;
}

export interface OtpListing {
  /** false when the server has no vault key: the feature is switched off */
  available: boolean;
  entries: OtpEntry[];
}
