import { httpError } from './security.mjs';
import { normalizeImportToken } from './repository-import.mjs';

/**
 * Asking another host what repositories it has.
 *
 * Importing one repository means pasting one URL. Moving off a host means
 * pasting forty, and getting one of them wrong. This is the part that asks the
 * forge instead: give it an owner, get back the list.
 *
 * **The API host is not something the caller chooses.** Every other place in
 * KukGit that fetches a URL somebody supplied has to do a DNS lookup and check
 * the address is not on our own network, because the server can reach things the
 * caller cannot. Here the caller supplies an *owner* and a forge *name*, and the
 * API base comes from the table below — so there is no URL to attack with. A
 * self-hosted forge will need an instance-level allow-list; it is deliberately
 * not "any host you like".
 */

export const FORGES = Object.freeze({
  github: Object.freeze({
    name: 'github',
    label: 'GitHub',
    host: 'github.com',
    api: 'https://api.github.com',
    tokenHint: 'a fine-grained personal access token with Contents: read',
  }),
  gitlab: Object.freeze({
    name: 'gitlab',
    label: 'GitLab',
    host: 'gitlab.com',
    api: 'https://gitlab.com/api/v4',
    tokenHint: 'a personal or group access token with read_api and read_repository',
  }),
});

export const DISCOVERY_LIMITS = Object.freeze({
  // Not silent. Anything dropped is reported in the result, because a list that
  // quietly stops at 500 reads exactly like an owner that has 500 repositories.
  maxRepositories: 500,
  perPage: 100,
  maxPages: 20,
  requestTimeoutMs: 20000,
});

const OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,98}[A-Za-z0-9]$/;

export function normalizeForge(value) {
  const name = String(value ?? '').trim().toLowerCase();
  const forge = FORGES[name];
  if (!forge) {
    throw httpError(400, `Unknown forge '${name}'. Supported: ${Object.keys(FORGES).join(', ')}.`, 'FORGE_UNSUPPORTED');
  }
  return forge;
}

export function normalizeOwner(value) {
  const owner = String(value ?? '').trim();
  if (!owner) throw httpError(400, 'An organization or user name is required.', 'FORGE_OWNER_REQUIRED');
  // A path separator here would let the owner escape the endpoint it is
  // interpolated into and address a different part of the forge's API.
  if (!OWNER.test(owner)) throw httpError(400, 'That organization or user name is not valid.', 'FORGE_OWNER_INVALID');
  return owner;
}

/**
 * A slug KukGit will accept, derived from whatever the other host called it.
 *
 * Forges permit names KukGit's own `assertSlug` refuses — leading digits are
 * fine, but dots, underscores and capitals are not. Renaming on the way in is
 * better than refusing halfway through a forty-repository import.
 */
export function slugForRepository(name) {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return slug || null;
}

function authorizationFor(forge, token) {
  const value = normalizeImportToken(token);
  if (!value) return null;
  // GitHub reads `Bearer`; GitLab reads its own header but also accepts Bearer
  // for personal access tokens, so one shape covers both.
  return `Bearer ${value}`;
}

async function readJson(response, context) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw httpError(502, `${context} did not return JSON.`, 'FORGE_BAD_RESPONSE'); }
}

/**
 * Turns a forge's refusal into something the person reading it can act on.
 *
 * A bare "403" is indistinguishable from "your token is fine but you have run
 * out of requests for the next forty minutes", and those need opposite actions.
 */
function refusal(forge, response, body) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  if (response.status === 403 && remaining === '0') {
    const at = reset ? new Date(Number(reset) * 1000).toISOString() : 'shortly';
    return httpError(429, `${forge.label} rate limit reached. It resets at ${at}. An access token raises the limit considerably.`, 'FORGE_RATE_LIMITED');
  }
  if (response.status === 401) {
    return httpError(401, `${forge.label} rejected the access token. Check it has not expired and grants ${forge.tokenHint}.`, 'FORGE_UNAUTHORIZED');
  }
  if (response.status === 404) {
    return httpError(404, `${forge.label} has no such organization or user visible to this token. A private organization needs a token that can see it.`, 'FORGE_OWNER_NOT_FOUND');
  }
  const detail = typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`;
  return httpError(502, `${forge.label} refused the request: ${detail}`, 'FORGE_REQUEST_FAILED');
}

function githubRepository(entry) {
  return {
    name: String(entry.name ?? ''),
    fullName: String(entry.full_name ?? ''),
    cloneUrl: String(entry.clone_url ?? ''),
    private: Boolean(entry.private),
    archived: Boolean(entry.archived),
    fork: Boolean(entry.fork),
    empty: Number(entry.size ?? 0) === 0,
    defaultBranch: entry.default_branch ? String(entry.default_branch) : null,
    description: entry.description ? String(entry.description).slice(0, 500) : '',
    sizeKb: Number(entry.size ?? 0),
  };
}

function gitlabRepository(entry) {
  return {
    name: String(entry.path ?? entry.name ?? ''),
    fullName: String(entry.path_with_namespace ?? ''),
    cloneUrl: String(entry.http_url_to_repo ?? ''),
    private: String(entry.visibility ?? 'private') !== 'public',
    archived: Boolean(entry.archived),
    fork: Boolean(entry.forked_from_project),
    empty: Boolean(entry.empty_repo),
    defaultBranch: entry.default_branch ? String(entry.default_branch) : null,
    description: entry.description ? String(entry.description).slice(0, 500) : '',
    sizeKb: Number(entry.statistics?.repository_size ?? 0) / 1024,
  };
}

/**
 * Which endpoint lists an owner's repositories.
 *
 * The detail that decides whether this feature is useful: for a *user*,
 * `/users/{owner}/repos` never returns private repositories, even with a token
 * that owns every one of them. Only `/user/repos` does. So when the token
 * belongs to the owner being listed, that is the endpoint to use — otherwise
 * "import all my repositories" silently skips every private one, which is the
 * only kind anybody was worried about moving.
 */
async function githubEndpoints({ owner, token, request }) {
  const organization = `/orgs/${encodeURIComponent(owner)}/repos?type=all&sort=full_name&per_page=${DISCOVERY_LIMITS.perPage}`;
  if (!token) return { paths: [`/users/${encodeURIComponent(owner)}/repos?sort=full_name&per_page=${DISCOVERY_LIMITS.perPage}`], organizationFirst: organization };

  let login = null;
  const me = await request('/user', { allowFailure: true });
  if (me.ok) {
    const body = await readJson(me, 'GitHub');
    login = typeof body?.login === 'string' ? body.login : null;
  }
  if (login && login.toLowerCase() === owner.toLowerCase()) {
    return { paths: [`/user/repos?visibility=all&affiliation=owner&sort=full_name&per_page=${DISCOVERY_LIMITS.perPage}`], organizationFirst: null };
  }
  return { paths: [`/users/${encodeURIComponent(owner)}/repos?sort=full_name&per_page=${DISCOVERY_LIMITS.perPage}`], organizationFirst: organization };
}

/**
 * Lists what an owner has, on one of the forges above.
 *
 * `fetchImpl` is injectable so the tests exercise pagination, rate limiting and
 * the private-repository endpoint choice without a network or a real token.
 */
export async function listForgeRepositories({ forge: forgeName, owner: ownerName, token = null } = {}, { fetchImpl = fetch } = {}) {
  const forge = normalizeForge(forgeName);
  const owner = normalizeOwner(ownerName);
  const authorization = authorizationFor(forge, token);

  const request = async (path, { allowFailure = false } = {}) => {
    const headers = { 'User-Agent': 'KukGit', Accept: forge.name === 'github' ? 'application/vnd.github+json' : 'application/json' };
    if (authorization) headers.Authorization = authorization;
    if (forge.name === 'github') headers['X-GitHub-Api-Version'] = '2022-11-28';
    let response;
    try {
      response = await fetchImpl(`${forge.api}${path}`, { headers, signal: AbortSignal.timeout(DISCOVERY_LIMITS.requestTimeoutMs) });
    } catch (error) {
      if (allowFailure) return { ok: false, status: 0, headers: new Headers() };
      throw httpError(504, `${forge.label} did not answer: ${String(error?.message ?? error).slice(0, 200)}`, 'FORGE_UNREACHABLE');
    }
    if (!response.ok && !allowFailure) {
      throw refusal(forge, response, await readJson(response, forge.label).catch(() => null));
    }
    return response;
  };

  // An owner is an organization or a user, and the forge will not say which
  // without being asked. Each candidate is tried in turn; the last one is
  // allowed to fail loudly, so a genuinely bad token or missing owner still
  // produces the forge's own reason rather than "none of them worked".
  let candidates;
  if (forge.name === 'github') {
    const chosen = await githubEndpoints({ owner, token, request });
    candidates = chosen.organizationFirst ? [chosen.organizationFirst, ...chosen.paths] : chosen.paths;
  } else {
    candidates = [
      `/groups/${encodeURIComponent(owner)}/projects?include_subgroups=true&order_by=path&per_page=${DISCOVERY_LIMITS.perPage}`,
      `/users/${encodeURIComponent(owner)}/projects?order_by=path&per_page=${DISCOVERY_LIMITS.perPage}`,
    ];
  }

  for (const [index, path] of candidates.entries()) {
    const last = index === candidates.length - 1;
    const response = await request(path, { allowFailure: !last });
    if (response.ok) return collect(response, path);
  }
  // Unreachable: the last candidate throws rather than returning a failure.
  throw httpError(404, `${forge.label} listed no repositories for '${owner}'.`, 'FORGE_OWNER_NOT_FOUND');

  async function collect(firstResponse, path) {
    const normalize = forge.name === 'github' ? githubRepository : gitlabRepository;
    const repositories = [];
    let truncated = false;
    let response = firstResponse;
    for (let page = 1; page <= DISCOVERY_LIMITS.maxPages; page += 1) {
      const body = await readJson(response, forge.label);
      if (!Array.isArray(body)) throw httpError(502, `${forge.label} returned something that is not a list of repositories.`, 'FORGE_BAD_RESPONSE');
      for (const entry of body) {
        if (repositories.length >= DISCOVERY_LIMITS.maxRepositories) { truncated = true; break; }
        repositories.push(normalize(entry));
      }
      if (truncated || body.length < DISCOVERY_LIMITS.perPage) break;
      if (page === DISCOVERY_LIMITS.maxPages) { truncated = true; break; }
      response = await request(`${path}&page=${page + 1}`);
    }
    return {
      forge: forge.name,
      owner,
      authenticated: Boolean(authorization),
      repositories,
      truncated,
      // Said out loud rather than left for somebody to notice. A list that stops
      // at the cap looks exactly like an owner who has that many.
      note: truncated ? `Only the first ${repositories.length} repositories are listed; this owner has more than KukGit will enumerate in one request.` : null,
    };
  }
}

/**
 * What is worth importing, and what each skip was for.
 *
 * Returned rather than filtered away: somebody who expected forty repositories
 * and got thirty-one needs the other nine accounted for, by name.
 */
export function planImport(repositories, { includeForks = false, includeArchived = false } = {}) {
  const selected = [];
  const skipped = [];
  const seen = new Set();
  for (const repository of repositories) {
    const slug = slugForRepository(repository.name);
    if (repository.empty) skipped.push({ ...repository, reason: 'it has no commits' });
    else if (!repository.cloneUrl) skipped.push({ ...repository, reason: 'the forge gave no clone URL' });
    else if (repository.fork && !includeForks) skipped.push({ ...repository, reason: 'it is a fork' });
    else if (repository.archived && !includeArchived) skipped.push({ ...repository, reason: 'it is archived' });
    else if (!slug) skipped.push({ ...repository, reason: 'its name contains nothing KukGit can use as a slug' });
    else if (seen.has(slug)) skipped.push({ ...repository, reason: `another repository already takes the slug '${slug}'` });
    else { seen.add(slug); selected.push({ ...repository, slug }); }
  }
  return { selected, skipped };
}
