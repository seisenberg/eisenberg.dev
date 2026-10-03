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
}

export interface AttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
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
  /** forward a copy to the private mailbox */
  forward: boolean;
  /** push notification to installed web apps */
  notify: boolean;
  /** how a forward is laid out: the original inline, or a summary with the original attached */
  forwardStyle: ForwardStyle;
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
