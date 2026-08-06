import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCOVERY_LIMITS,
  FORGES,
  listForgeRepositories,
  normalizeForge,
  normalizeOwner,
  planImport,
  slugForRepository,
} from '../src/forge-discovery.mjs';

/**
 * Asking another host what repositories it has.
 *
 * `fetchImpl` is injected throughout, so these exercise pagination, the rate
 * limit, and the endpoint choice that decides whether private repositories are
 * seen at all — without a network or a real token.
 */

function repository(name, overrides = {}) {
  return {
    name,
    full_name: `kuklabs/${name}`,
    clone_url: `https://github.com/kuklabs/${name}.git`,
    private: false,
    archived: false,
    fork: false,
    size: 120,
    default_branch: 'main',
    description: '',
    ...overrides,
  };
}

function forge(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const result = handler(url, calls.length);
    return new Response(JSON.stringify(result.body ?? []), {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(result.headers ?? {}) },
    });
  };
  return { fetchImpl, calls };
}

test('the forge is chosen from a list, not supplied as a URL', async () => {
  // There is no URL here to point at our own network, which is why this module
  // does not need the DNS-resolution guard that webhook delivery needs.
  assert.equal(normalizeForge('GitHub').api, 'https://api.github.com');
  assert.throws(() => normalizeForge('https://internal.kuklabs.corp'), /Unknown forge/);
  assert.throws(() => normalizeForge(''), /Unknown forge/);
  assert.deepEqual(Object.keys(FORGES), ['github', 'gitlab']);
});

test('an owner cannot escape the path it is put into', async () => {
  assert.equal(normalizeOwner(' kuklabs '), 'kuklabs');
  // `../` or a slash here would address a different part of the forge's API.
  assert.throws(() => normalizeOwner('kuklabs/../../admin'), /not valid/);
  assert.throws(() => normalizeOwner('a b'), /not valid/);
  assert.throws(() => normalizeOwner(''), /required/);
});

test('a name the forge allows becomes a slug KukGit allows', async () => {
  assert.equal(slugForRepository('KukGit.Platform'), 'kukgit-platform');
  assert.equal(slugForRepository('my_repo'), 'my-repo');
  assert.equal(slugForRepository('---'), null);
});

test('an organization is listed, with the token attached', async () => {
  const { fetchImpl, calls } = forge((url) => {
    if (url.endsWith('/user')) return { body: { login: 'somebody-else' } };
    if (url.includes('/orgs/kuklabs/repos')) return { body: [repository('alpha'), repository('beta')] };
    return { status: 404, body: { message: 'Not Found' } };
  });

  const result = await listForgeRepositories({ forge: 'github', owner: 'kuklabs', token: 'github_pat_ABC' }, { fetchImpl });

  assert.deepEqual(result.repositories.map((entry) => entry.name), ['alpha', 'beta']);
  assert.equal(result.authenticated, true);
  assert.equal(result.truncated, false);
  assert.equal(calls.every((call) => call.headers.Authorization === 'Bearer github_pat_ABC'), true);
});

test('a user that is not an organization falls back rather than failing', async () => {
  const { fetchImpl } = forge((url) => {
    if (url.endsWith('/user')) return { body: { login: 'somebody-else' } };
    if (url.includes('/orgs/')) return { status: 404, body: { message: 'Not Found' } };
    if (url.includes('/users/amit/repos')) return { body: [repository('personal')] };
    return { status: 500, body: {} };
  });

  const result = await listForgeRepositories({ forge: 'github', owner: 'amit', token: 'github_pat_ABC' }, { fetchImpl });
  assert.deepEqual(result.repositories.map((entry) => entry.name), ['personal']);
});

test("listing your own account uses the endpoint that can see private repositories", async (t) => {
  // The detail the whole feature rests on. `/users/{owner}/repos` never returns
  // private repositories, even with a token that owns every one of them — so
  // "import all my repositories" would silently skip exactly the ones anybody
  // was worried about moving.
  const { fetchImpl, calls } = forge((url) => {
    if (url.endsWith('/user')) return { body: { login: 'Amit' } };
    if (url.includes('/user/repos')) return { body: [repository('private-one', { private: true })] };
    return { status: 404, body: { message: 'Not Found' } };
  });

  const result = await listForgeRepositories({ forge: 'github', owner: 'amit', token: 'github_pat_ABC' }, { fetchImpl });

  assert.deepEqual(result.repositories.map((entry) => entry.name), ['private-one']);
  assert.equal(result.repositories[0].private, true);
  const listed = calls.map((call) => call.url).filter((url) => url.includes('repos'));
  assert.ok(listed.every((url) => url.includes('/user/repos')), listed.join(' '));
  assert.ok(listed.some((url) => url.includes('affiliation=owner')), listed.join(' '));
});

test('without a token it does not ask who the token belongs to', async () => {
  const { fetchImpl, calls } = forge((url) => {
    if (url.includes('/orgs/kuklabs/repos')) return { body: [repository('public-one')] };
    return { status: 404, body: {} };
  });

  const result = await listForgeRepositories({ forge: 'github', owner: 'kuklabs' }, { fetchImpl });
  assert.equal(result.authenticated, false);
  assert.equal(calls.some((call) => call.url.endsWith('/user')), false);
  assert.equal(calls.every((call) => !('Authorization' in call.headers)), true);
});

test('every page is read, and the page after the last is not asked for', async () => {
  const full = Array.from({ length: DISCOVERY_LIMITS.perPage }, (_, index) => repository(`repo-${index}`));
  const { fetchImpl, calls } = forge((url) => {
    if (url.endsWith('/user')) return { body: { login: 'other' } };
    if (!url.includes('/orgs/')) return { status: 404, body: {} };
    if (url.includes('page=2')) return { body: [repository('last')] };
    return { body: full };
  });

  const result = await listForgeRepositories({ forge: 'github', owner: 'kuklabs', token: 'tok-value-here' }, { fetchImpl });

  assert.equal(result.repositories.length, DISCOVERY_LIMITS.perPage + 1);
  // A short page is the end. Asking for the one after it is a wasted round trip
  // against a rate limit that is counted per request.
  assert.equal(calls.filter((call) => call.url.includes('&page=')).length, 1);
});

test('an owner with more repositories than the cap says so out loud', async () => {
  const full = Array.from({ length: DISCOVERY_LIMITS.perPage }, (_, index) => repository(`repo-${index}`));
  const { fetchImpl } = forge((url) => {
    if (url.endsWith('/user')) return { body: { login: 'other' } };
    if (!url.includes('/orgs/')) return { status: 404, body: {} };
    return { body: full };
  });

  const result = await listForgeRepositories({ forge: 'github', owner: 'kuklabs', token: 'tok-value-here' }, { fetchImpl });

  assert.equal(result.repositories.length, DISCOVERY_LIMITS.maxRepositories);
  // Silence here would be indistinguishable from an owner who has exactly 500.
  assert.equal(result.truncated, true);
  assert.match(result.note, /more than KukGit will enumerate/);
});

test('a spent rate limit is told apart from a bad token', async () => {
  const limited = forge(() => ({
    status: 403,
    body: { message: 'API rate limit exceeded' },
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1786000000' },
  }));
  await assert.rejects(
    () => listForgeRepositories({ forge: 'github', owner: 'kuklabs' }, { fetchImpl: limited.fetchImpl }),
    (error) => {
      // 429, not 403: one of these is fixed by waiting and the other by getting
      // a different token, and they are worth telling apart.
      assert.equal(error.status, 429);
      assert.equal(error.code, 'FORGE_RATE_LIMITED');
      assert.match(error.message, /2026-/);
      assert.match(error.message, /access token raises the limit/);
      return true;
    },
  );

  const rejected = forge(() => ({ status: 401, body: { message: 'Bad credentials' } }));
  await assert.rejects(
    () => listForgeRepositories({ forge: 'github', owner: 'kuklabs', token: 'expired-token-value' }, { fetchImpl: rejected.fetchImpl }),
    (error) => {
      assert.equal(error.code, 'FORGE_UNAUTHORIZED');
      assert.match(error.message, /Contents: read/);
      return true;
    },
  );
});

test('an owner nobody can see reports the forge, not a stack trace', async () => {
  const { fetchImpl } = forge(() => ({ status: 404, body: { message: 'Not Found' } }));
  await assert.rejects(
    () => listForgeRepositories({ forge: 'github', owner: 'nobody' }, { fetchImpl }),
    (error) => {
      assert.equal(error.code, 'FORGE_OWNER_NOT_FOUND');
      assert.match(error.message, /private organization needs a token/);
      return true;
    },
  );
});

test('a forge that never answers is a timeout, not a hang', async () => {
  const fetchImpl = async () => { throw new Error('connect ETIMEDOUT'); };
  await assert.rejects(
    () => listForgeRepositories({ forge: 'github', owner: 'kuklabs' }, { fetchImpl }),
    (error) => {
      assert.equal(error.status, 504);
      assert.equal(error.code, 'FORGE_UNREACHABLE');
      return true;
    },
  );
});

test('GitLab projects are read too, group first', async () => {
  const { fetchImpl } = forge((url) => {
    if (url.includes('/groups/kuklabs/projects')) {
      return { body: [{ path: 'platform', path_with_namespace: 'kuklabs/platform', http_url_to_repo: 'https://gitlab.com/kuklabs/platform.git', visibility: 'private', default_branch: 'main' }] };
    }
    return { status: 404, body: { message: '404 Group Not Found' } };
  });

  const result = await listForgeRepositories({ forge: 'gitlab', owner: 'kuklabs', token: 'glpat-value-here' }, { fetchImpl });
  assert.equal(result.repositories[0].name, 'platform');
  assert.equal(result.repositories[0].private, true);
  assert.equal(result.repositories[0].cloneUrl, 'https://gitlab.com/kuklabs/platform.git');
});

test('the plan accounts for every repository, including the ones it skips', async () => {
  const { selected, skipped } = planImport([
    { name: 'alpha', cloneUrl: 'https://github.com/k/alpha.git' },
    { name: 'a-fork', cloneUrl: 'https://github.com/k/a-fork.git', fork: true },
    { name: 'old', cloneUrl: 'https://github.com/k/old.git', archived: true },
    { name: 'nothing', cloneUrl: 'https://github.com/k/nothing.git', empty: true },
    { name: 'Alpha', cloneUrl: 'https://github.com/k/Alpha.git' },
    { name: '---', cloneUrl: 'https://github.com/k/dashes.git' },
  ]);

  assert.deepEqual(selected.map((entry) => entry.slug), ['alpha']);
  // Nine missing out of forty needs to be nine named reasons, not a smaller
  // number and a shrug.
  assert.deepEqual(skipped.map((entry) => `${entry.name}: ${entry.reason}`), [
    'a-fork: it is a fork',
    'old: it is archived',
    'nothing: it has no commits',
    "Alpha: another repository already takes the slug 'alpha'",
    '---: its name contains nothing KukGit can use as a slug',
  ]);
});

test('forks and archives can be asked for', async () => {
  const repositories = [
    { name: 'a-fork', cloneUrl: 'https://github.com/k/a-fork.git', fork: true },
    { name: 'old', cloneUrl: 'https://github.com/k/old.git', archived: true },
  ];
  const { selected } = planImport(repositories, { includeForks: true, includeArchived: true });
  assert.deepEqual(selected.map((entry) => entry.slug), ['a-fork', 'old']);
});
