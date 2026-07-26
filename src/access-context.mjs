import { AsyncLocalStorage } from 'node:async_hooks';

const repositoryAccessStorage = new AsyncLocalStorage();

export function runWithRepositoryAccess(context, callback) {
  return repositoryAccessStorage.run(Object.freeze({ ...context }), callback);
}

export function currentRepositoryAccess() {
  return repositoryAccessStorage.getStore() ?? null;
}
