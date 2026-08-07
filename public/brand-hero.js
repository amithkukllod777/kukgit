/**
 * The page somebody sees before they are signed in.
 *
 * There are five of them — sign in, create an account, ask for a reset link,
 * choose a new password, confirm an address — and until now only the first one
 * looked like KukGit. The other four rendered a bare card in the middle of an
 * empty page, because they were written as "a screen that takes over" rather
 * than as "a page of this product". Somebody arriving from an email, or from
 * the sign-in form's own link, went from a designed page to a floating box.
 *
 * So the frame lives here, once, and both `app.js` and `account-screens-ui.js`
 * render into it. Copying the markup into the second file would have been
 * fewer lines today and two pages that drift apart the first time anybody edits
 * the wording.
 *
 * Nothing here reads state or talks to a server. It is markup and it stays
 * markup, so importing it cannot make either page fail to render.
 */

/** The left column: the brand, the pitch, and what the product is. */
export function heroHtml() {
  return `<section class="login-hero">
      <div class="brand-lockup"><img class="brand-logo" src="/assets/kuklabs-k.png" alt="Kuklabs K" /> KukGit</div>
      <div class="login-copy">
        <div class="eyebrow">AI Developer Operating System</div>
        <h1>Build, review and deploy with <span class="gradient-text">one intelligent platform.</span></h1>
        <p>KukGit combines secure Git hosting, team collaboration, repository intelligence and deployment workflows inside the Kuklabs ecosystem.</p>
        <div class="login-points">
          <div class="login-point"><b>Real Git hosting</b><span>Bare repositories, branches, commits and Git smart HTTP transport.</span></div>
          <div class="login-point"><b>AI repo health</b><span>Security, quality, DevOps and documentation checks in one score.</span></div>
          <div class="login-point"><b>Business ready</b><span>Organizations, roles, private repositories and auditable activity.</span></div>
        </div>
      </div>
    </section>`;
}

/**
 * The whole two-column frame, with `panel` in the right-hand column.
 *
 * One `<main>`, always. Two of them on a page means two modules are rendering
 * the same route — see `test/public-page-routes.test.mjs`, which counts them.
 */
export function signedOutPage(panel) {
  return `<main class="login-page">${heroHtml()}<section class="login-panel">${panel}</section></main>`;
}
