// تشغيل: node gen-vapid.mjs   → يطبع مفاتيح الإشعارات (مرة وحدة فقط)
import { generateKeyPairSync } from 'node:crypto';
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const j = publicKey.export({ format: 'jwk' });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url');
console.log('VAPID_PUBLIC      =', pub);
console.log('VAPID_PRIVATE_JWK =', JSON.stringify(privateKey.export({ format: 'jwk' })));
