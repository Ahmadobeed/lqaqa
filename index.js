const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();
const FV = admin.firestore.FieldValue;
const ADMIN_EMAIL = 'ahmadobeed2007@gmail.com';

function assertAdmin(req) {
  const t = req.auth && req.auth.token;
  if (!t || (t.email || '').toLowerCase() !== ADMIN_EMAIL || t.email_verified !== true)
    throw new HttpsError('permission-denied', 'للمشرف فقط');
}
const isAnon = (u) => !u.email && (u.providerData || []).length === 0;

async function listAllAuthUsers() {
  const out = []; let token;
  do { const r = await auth.listUsers(1000, token); out.push(...r.users); token = r.pageToken; } while (token);
  return out;
}

// يشيل المستخدم من qaqa_users_full (مخزن بـ kv) مشان ما يضل "الايميل مستخدم"
async function scrubKv(uid, email) {
  const ref = db.collection('kv').doc('qaqa_users_full');
  const s = await ref.get(); if (!s.exists) return;
  let arr; try { arr = JSON.parse(s.data().v); } catch { return; }
  if (!Array.isArray(arr)) return;
  const next = arr.filter(u => !((uid && u.uid === uid) || (email && u.email && u.email.toLowerCase() === email.toLowerCase())));
  if (next.length !== arr.length) await ref.update({ v: JSON.stringify(next), t: FV.serverTimestamp() });
}

// حذف كامل من كل الأماكن
async function wipeUser(uid, hint = {}) {
  let email = hint.email || null, username = hint.username || null;
  try { const a = await auth.getUser(uid); email = a.email || email; } catch {}
  const d = await db.collection('users').doc(uid).get();
  if (d.exists) { email = email || d.data().email; username = username || d.data().usernameLower || d.data().username; }
  try { await auth.deleteUser(uid); } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
  const batch = db.batch();
  batch.delete(db.collection('users').doc(uid));
  if (username) batch.delete(db.collection('usernames').doc(encodeURIComponent(String(username).replace(/^@/, '').toLowerCase())));
  const un = await db.collection('usernames').where('uid', '==', uid).get();
  un.forEach(x => batch.delete(x.ref));
  await batch.commit();
  await scrubKv(uid, email);
  return email;
}

// 1) حذف مستخدم (من Auth + Firestore). بالـ uid او بالايميل.
exports.deleteUserCompletely = onCall(async (req) => {
  assertAdmin(req);
  let { uid, email, confirmSelf } = req.data || {};
  if (!uid && email) {
    try { uid = (await auth.getUserByEmail(email)).uid; }
    catch {
      // مو موجود بـ Auth: نظّف اللي بـ Firestore
      const q = await db.collection('users').where('email', '==', email).get();
      for (const d of q.docs) await wipeUser(d.id, { email });
      await scrubKv(null, email);
      return { ok: true, note: 'مو موجود بـ Auth، تنظّف Firestore' };
    }
  }
  if (!uid) throw new HttpsError('invalid-argument', 'uid او email مطلوب');
  let target = null; try { target = await auth.getUser(uid); } catch {}
  if (target && (target.email || '').toLowerCase() === ADMIN_EMAIL && !confirmSelf)
    throw new HttpsError('failed-precondition', 'هاد حساب المشرف. ابعت confirmSelf لتأكيد حذفو');
  const mail = await wipeUser(uid);
  return { ok: true, uid, email: mail };
});

// 2) حذف كل الـ Anonymous (ما بيلمس اللي عندهم ايميل)
exports.cleanupAnonymous = onCall(async (req) => {
  assertAdmin(req);
  const dryRun = !!(req.data && req.data.dryRun);
  const anon = (await listAllAuthUsers()).filter(isAnon).map(u => u.uid);
  if (!dryRun) for (let i = 0; i < anon.length; i += 1000) await auth.deleteUsers(anon.slice(i, i + 1000));
  return { dryRun, count: anon.length };
});

// 3) مزامنة Auth <-> Firestore
//    data.apply=false (افتراضي): تقرير فقط
//    data.authOnly = 'delete' | 'backfill'  (حسابات Auth بدون مستند Firestore)
exports.syncAuthFirestore = onCall(async (req) => {
  assertAdmin(req);
  const apply = !!(req.data && req.data.apply);
  const mode = (req.data && req.data.authOnly) || 'delete';
  const authUsers = (await listAllAuthUsers()).filter(u => !isAnon(u));
  const docs = await db.collection('users').get();
  const docIds = new Set(docs.docs.map(d => d.id));
  const authIds = new Set(authUsers.map(u => u.uid));
  const authOnly = authUsers.filter(u => !docIds.has(u.uid) && (u.email || '').toLowerCase() !== ADMIN_EMAIL);
  const fsOnly = docs.docs.filter(d => !authIds.has(d.id));
  const report = {
    apply, mode,
    authOnly: authOnly.map(u => ({ uid: u.uid, email: u.email })),
    firestoreOnly: fsOnly.map(d => ({ uid: d.id, email: d.data().email, username: d.data().username })),
  };
  if (!apply) return report;
  for (const d of fsOnly) await wipeUser(d.id, { email: d.data().email, username: d.data().usernameLower });
  for (const u of authOnly) {
    if (mode === 'backfill') {
      const nm = (u.displayName || '').trim().split(/\s+/);
      const un = (u.email || 'user').split('@')[0];
      await db.collection('users').doc(u.uid).set({
        firstName: nm[0] || un, lastName: nm.slice(1).join(' '), username: un, usernameLower: un.toLowerCase(),
        email: u.email || '', photoURL: u.photoURL || '', createdAt: FV.serverTimestamp(),
      }, { merge: true });
    } else await wipeUser(u.uid, { email: u.email });
  }
  return report;
});
