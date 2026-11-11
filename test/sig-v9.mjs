// The ledger 8 signing helpers the tests used, on ledger 9 (branch ledger9, 11-09). Ledger 9 tags keys and signatures
// ({ tag: 'schnorr', value: hex }); the Hall's claims carry plain hex, so these take and give plain hex as before.
import * as L9 from '@midnightntwrk/ledger-v9';
const tag = (x) => (typeof x === 'string' ? { tag: 'schnorr', value: x } : x);
const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
export const sampleSigningKey = () => val(L9.sampleSigningKey());
export const signatureVerifyingKey = (sk) => val(L9.signatureVerifyingKey(tag(sk)));
export const signData = (sk, data) => val(L9.signData(tag(sk), data));
export const verifySignature = (vk, data, sig) => L9.verifySignature(tag(vk), data, tag(sig));
export const addressFromKey = (vk) => L9.addressFromKey(tag(vk));
