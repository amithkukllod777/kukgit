import { AsyncLocalStorage } from 'node:async_hooks';

const identityStorage = new AsyncLocalStorage();

export function runWithRequestIdentity(identity, callback) {
  return identityStorage.run(Object.freeze({
    resolved: true,
    mode: identity?.mode ?? 'anonymous',
    user: identity?.user ? Object.freeze({ ...identity.user }) : null,
    session: identity?.session ? Object.freeze({ ...identity.session }) : null,
  }), callback);
}

export function currentRequestIdentity() {
  return identityStorage.getStore() ?? null;
}
