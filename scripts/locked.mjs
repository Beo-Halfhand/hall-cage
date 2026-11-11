// A maintenance authority nobody can use: more signatures needed than there are members. cage4 has [] with threshold 1.
// Split out of deploy-locked.mjs (which builds ledger 8 deploys, refused after the fork) for the ledger 9 build, 11-09.
export const isLocked = (authority) => authority.threshold > authority.committee.length;
