import webpush from 'web-push';
import type { PushNotification } from '../shared/contracts.ts';
import type { PushTarget, Store } from './store.ts';

const THROTTLE_MS = 30_000;
const SEND_TIMEOUT_MS = 10_000;
/** Undelivered pushes (device offline) expire after a day rather than arriving stale. */
const TTL_SECONDS = 24 * 60 * 60;

/** Delivers an encrypted payload to one subscription and resolves with the push service's HTTP status. */
export type PushSender = (target: PushTarget, payload: string) => Promise<number>;

export type VapidKeys = { publicKey: string; privateKey: string };

/** The server's VAPID key pair, generated and stored on first use. */
export function vapidKeys(store: Store): VapidKeys {
  return JSON.parse(store.serverSetting('vapid', () => JSON.stringify(webpush.generateVAPIDKeys()))) as VapidKeys;
}

/** Encrypts with `web-push` (aes128gcm, VAPID JWT) and posts with `fetch`. */
export function webPushSender(keys: VapidKeys, subject: string): PushSender {
  return async (target, payload) => {
    const request = webpush.generateRequestDetails(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      payload,
      { vapidDetails: { subject, ...keys }, TTL: TTL_SECONDS, urgency: 'high' },
    );
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.toLowerCase() !== 'content-length') headers.set(name, String(value));
    }
    const response = await fetch(request.endpoint, {
      method: 'POST', headers, body: request.body && new Uint8Array(request.body), signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return response.status;
  };
}

export class PushNotifier {
  private readonly lastSent = new Map<number, number>();

  constructor(
    private readonly store: Store,
    readonly publicKey: string,
    private readonly send: PushSender,
    private readonly now: () => number = Date.now,
  ) {}

  /** Pushes a buffer notification to every device of the user, at most once per buffer every 30 s. */
  notify(userId: number, notification: PushNotification & { bufferId: number }): void {
    const time = this.now();
    const last = this.lastSent.get(notification.bufferId);
    if (last !== undefined && time - last < THROTTLE_MS) return;
    this.lastSent.set(notification.bufferId, time);
    void this.deliver(userId, notification);
  }

  /** Sends to every device of the user; resolves with the number the push services accepted. */
  async deliver(userId: number, notification: PushNotification): Promise<number> {
    const payload = JSON.stringify(notification);
    const results = await Promise.all(this.store.listPushSubscriptions(userId).map(async (subscription) => {
      let status: number;
      try {
        status = await this.send(subscription, payload);
      } catch (error) {
        console.warn('Push delivery failed:', error instanceof Error ? error.message : error);
        return false;
      }
      if (status >= 200 && status < 300) {
        this.store.markPushDelivered(subscription.id, this.now());
        return true;
      }
      if (status === 404 || status === 410) this.store.removePushSubscription(subscription.id);
      else console.warn(`Push delivery failed with HTTP ${status}`);
      return false;
    }));
    return results.filter(Boolean).length;
  }
}
