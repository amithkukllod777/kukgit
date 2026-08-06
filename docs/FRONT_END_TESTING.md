# Front-end testing

## Why this exists

Six front-end bugs reached the live server. All six were found by opening
`https://git.kuklabs.com` in a browser and watching the network panel. None was
found by the test suite, which had close to seven hundred passing tests at the
time.

| What was wrong | How it showed up |
| --- | --- |
| The sign-in form was prefilled with a working password | Every visitor had the founder's credentials |
| `Cache-Control: max-age=3600` on `app.js` | Deploys did not reach anyone who had already visited |
| A signed-out `401` cached as "you are not an administrator" | The instance owner could not see his own admin panel |
| `#/instance-admin` reset to `#/` before the panel loaded | The admin panel was unreachable even once visible |
| The generic instance-admin handler answered before the specific ones | Every operator API route returned `404` in production |
| No memory of a `404` answer | The same request forty-four times in two seconds, then the rate limiter |

The pattern is one thing: every one of them is a **behaviour over time**, not a
value a function returned. Testing `usagePanel()` returns the right HTML says
nothing about whether it is called once or forty-four times, or whether the
element it attaches to exists. `public/*.js` could not even be imported under
`node --test`, because importing them touches `document`.

## What was added

`test-support/browser.mjs` — a DOM shim, deliberately not a dependency.

It is one file, about five hundred lines, and it covers exactly what our own
front-end uses: an HTML parser for the markup our templates emit, the subset of
CSS selectors we write, `MutationObserver` delivering on a microtask, a `fetch`
that records every call, `FormData` over a form element, and `hashchange`.

`window` **is** `globalThis`, as it is in a browser, because
`external-access-reviews-ui.js` reassigns `window.fetch` and expects the bare
`fetch` call to follow.

### What it is not

It is not a browser. No layout, no CSS, no real event ordering, no history, no
form submission, no `requestAnimationFrame`. A test that passes here is evidence
about our logic and **not** about how anything renders. Browser verification
before a release is still the check that matters; this is the one that runs on
every commit.

Unsupported CSS combinators (`>`, `+`, `~`) throw rather than matching the wrong
element, because a shim that silently returns the wrong node turns every test
written against it into a passing test about nothing.

### No new dependency

`CLAUDE.md` requires licensing and security review for third-party libraries,
and `pg` is still the only declared npm dependency. `jsdom` would have been
about a hundred transitive packages in the build of a product whose selling
point includes supply-chain posture. The shim is smaller than the review would
have been.

## Using it

```js
import { installBrowser, importFresh } from '../test-support/browser.mjs';

test('a 404 panel is asked for once', async (t) => {
  const browser = installBrowser({
    hash: '#/org/kuklabs',
    html: '<main class="content"><section id="kg-collaboration-panel" data-org="kuklabs"></section></main>',
    routes: { '*': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found.' } } } },
  });
  t.after(() => browser.restore());

  await importFresh('../public/external-access-reviews-ui.js');
  await browser.settle();

  assert.equal(browser.countPath('/api/external-access/kuklabs/reviews'), 1);
  assert.equal(browser.looped, false);
});
```

`installBrowser({ html, hash, origin, routes })` installs the globals and
returns:

| Member | What it is for |
| --- | --- |
| `document`, `location`, `calls` | The page and the raw request log |
| `requests()` | `["GET /api/orgs", …]` — what was asked, in order |
| `countPath(path)` | How many times a path was asked for |
| `busiest()` | `[path, count]` — the shape a request storm has |
| `html()` | Everything currently rendered |
| `navigate('#/x')` | Sets the hash and fires `hashchange`, as a link would |
| `settle()` | Drains microtasks and timers until the page stops working |
| `looped` | `true` when the DOM never settled — a render loop, not a slow test |
| `restore()` | Removes every installed global. **Every test must call it.** |

`routes` is keyed `"GET /api/thing"` or `"/api/thing"`, with `*` as a fallback.
A value is either `{ status, body }` or a function of the request, so a test can
answer differently the second time and prove the client noticed — which is how
"a signed-out 401 is not remembered" is expressed.

`importFresh('../public/thing.js')` imports with a fresh module instance. These
modules install themselves on import and keep state at module scope, so without
it the second test in a file inherits the first one's caches.

### Render loops

An observer that changes the DOM it observes is the exact shape of the storm
bug. The shim caps mutation deliveries at 300 and sets `looped`, rather than
throwing: an exception raised in a microtask takes the whole test process with
it, and the count is the finding anyway. A test that spins therefore **fails**
instead of hanging the run.

## The sweep

`test/no-storms.test.mjs` imports **every** file in `public/` into a page,
changes the DOM under it, and asserts it does not spiral — in two worlds, one
where every request 404s and one where every request succeeds.

It says nothing about whether a module works. It says only that the module does
not do the one thing that has broken the live site four times. A module added
later is covered without anybody remembering to add it, which matters more here
than the depth of any single case.

### What it asserts is growth, not a number

A threshold has to be wrong in one direction. Two calls it a storm when
`git-lfs-ui` legitimately settles at three; three lets the collaboration panel's
storm through. Neither number is about the defect — **the defect is that the
count never stops rising.**

So the page is churned twice, with a settle after each, and what is asserted is
that the second round produced **no new requests**. A module that has finished
stays finished however much the DOM moves under it; a module in a loop adds
another turn every round, whatever count it happened to reach.

### Where it stands matters as much as what it answers

The first version swept one route and passed everything. Most of `public/` does
nothing at all off its own page, so one route exercises a handful of modules and
reports the rest as clean.

That blind spot hid a live bug. Six scenarios now: the organizations list, a
repository settings page, a pull request page and account settings, each with a
world where everything fails and, for two of them, one where everything answers.

### What it found

| Module | Symptom |
| --- | --- |
| `collaboration-ui` | refetched and stacked another error card on every DOM change when its load failed |
| `repository-access-ui` | the same, measured at **120 requests and 120 identical error cards** |
| `git-lfs-ui` | one extra fetch per DOM change on a repository whose LFS the visitor cannot see |
| `external-collaborators-ui` | the same, on a repository they cannot manage |
| `notifications-ui` | the same, on the notification preferences panel |

All five are one defect: **the guard tests for a rendered element, and a
refused load never renders one.** 403, 404 and a failed load are answers, and an
answer has to be remembered until navigation.

**It is still a net, not a proof.** Reintroducing the collaboration panel's
*success-path* storm passes the sweep, because a generic payload does not
reproduce the exact render that drives that loop; `ui-behaviour.test.mjs`
catches that one. Neither file covers everything alone.

## The test files

- `test/browser-harness.test.mjs` — the shim, tested before anything is tested
  with it. Parser, selectors, `closest`, `<select>` values, `FormData`, event
  bubbling, the fetch recorder, loop detection, and that `restore()` leaks
  nothing into the next file in the process.
- `test/ui-behaviour.test.mjs` — the real `public/*.js` files, driven the way a
  visitor drives them.

Every guard these cover was mutation-tested: the fix was reverted one at a time
and the intended test confirmed to fail.

| Reverted | Test that failed |
| --- | --- |
| The `kgReviewAnswered` guard | *a 404 review panel is asked for once* |
| `kgReviewAnswered.clear()` on `hashchange` | *coming back to a page asks again* |
| `kgAdminStatus = error.status === 401 ? null : false` → `false` | *a signed-out 401 is not remembered* |
| The same line → `null` | *a 403 is an answer* |
| `:not([data-kg-usage])` on the org card | *an organization card gets its usage once* |
| The bell's minimum interval | *the notification bell is not re-read on every DOM change* |
| The collaboration panel's guard-before-fetch | *the organization list is not fetched to find out there is nothing to do* |

### The two storms this suite did not prevent

The harness was built after four bugs; it did not stop the next two. A browser
pointed at the organizations page counted **43× `/api/notifications`** and **40×
`/api/orgs`** in six seconds, both ending at the rate limiter.

Same defect, two new shapes. `notifications-ui.js` re-read the unread count on
every observer pass, and rendering the bell is a DOM change that wakes the
observer. `collaboration-ui.js` fetched the organization list **before** the
render-key guard, so every pass paid for a list it then correctly discarded.

Both now have tests here. The lesson is the one in the last section: this suite
shortens what browser verification has to catch, and does not replace it.

## What is still not covered

- Anything visual. Spacing, contrast, whether a panel is readable on a phone.
- **Most of what each module does.** Twenty-five modules are swept for storms;
  five are driven through their actual behaviour. The other twenty could render
  nonsense and pass.
- Real event ordering, focus, scrolling, and anything the browser does that we
  do not.

Browser verification before a release stays in the process. This suite shortens
the list of things that verification has to catch; it does not replace it.
