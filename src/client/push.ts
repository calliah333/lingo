import type { PushKey } from '../shared/contracts';
import { api, json } from './api';

/** Web Push needs a service worker, the Push API, and a secure context (HTTPS or localhost). */
export function pushSupported(): boolean {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window &&
    typeof Notification !== 'undefined';
}

/** iOS only offers Web Push to apps installed on the home screen. */
export function pushNeedsInstall(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !('PushManager' in window);
}

export function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/sw.js');
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration ? registration.pushManager.getSubscription() : null;
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64Url.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function sameKey(current: ArrayBuffer | null, expected: Uint8Array): boolean {
  if (!current || current.byteLength !== expected.length) return false;
  const bytes = new Uint8Array(current);
  return bytes.every((byte, index) => byte === expected[index]);
}

/**
 * Subscribes this device (reusing a subscription made with the server's current key) and
 * registers it under the current session. A device the server rejects is unsubscribed again.
 */
async function subscribe(): Promise<void> {
  await registerServiceWorker();
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await api<PushKey>('/api/push/key');
  const key = keyBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  try {
    await api<unknown>('/api/push/subscriptions', json('POST', subscription.toJSON()));
  } catch (error) {
    await subscription.unsubscribe().catch(() => {});
    throw error;
  }
}

export async function enablePush(): Promise<void> {
  if (!pushSupported()) {
    throw new Error(pushNeedsInstall()
      ? 'On iPhone and iPad, add Lingo to the home screen and open it from there to enable push.'
      : 'Push notifications are not supported here. They need HTTPS (or localhost) and a supporting browser.');
  }
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Allow notifications in your browser to enable push.');
  await subscribe();
}

export async function disablePush(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  await api<unknown>('/api/push/subscriptions', json('DELETE', { endpoint: subscription.endpoint }));
  await subscription.unsubscribe();
}

/**
 * Re-registers an existing device subscription after sign-in: subscriptions belong to the
 * session that registered them, and the browser may have rotated the endpoint meanwhile.
 */
export async function syncPush(): Promise<boolean> {
  const subscription = await currentPushSubscription();
  if (!subscription) return false;
  if (Notification.permission !== 'granted') {
    await subscription.unsubscribe();
    return false;
  }
  await subscribe();
  return true;
}

/** Stops pushes to this device when signing out; the server drops its row with the session. */
export async function forgetPush(): Promise<void> {
  await (await currentPushSubscription())?.unsubscribe();
}
