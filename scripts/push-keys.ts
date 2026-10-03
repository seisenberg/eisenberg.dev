// Generates the VAPID key pair for push notifications:  npm run push:keys
//   VAPID_PUBLIC_KEY   -> web lambda environment
//   VAPID_PRIVATE_KEY  -> store as an SSM SecureString and set VAPID_PRIVATE_KEY_SSM on BOTH lambdas
//                         (or set VAPID_PRIVATE_KEY directly). Keep it secret; it never needs to change.
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
