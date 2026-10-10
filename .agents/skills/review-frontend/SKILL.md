---
name: review-frontend
description: Review a change for what users and search engines see. Use when you're the frontend lens on a PR.
---

# Frontend lens

Follow `code-review` for scope, what counts as a finding, the report shape
and the return line. Your lens is what users and search engines see. Your
finding IDs are `F1`, `F2`, …

Read `DESIGN.md`, the `CODING_STANDARDS.md` sections on React, UI and
styling, and the glossary in `CONTEXT.md` for product words.

The dispatcher only starts you when the PR touches UI or a public page. If it
turns out not to, return `clear` with "no user-visible change" under Checked.

## Look at the screenshots

You don't drive a browser. The build job put a screenshot of every changed
screen at 390 and 1440 wide under **Screenshots** in the PR; those are your
eyes. Read every one before you judge.

Your lens section is **Visual checks**: one line per screen saying what you
looked at and what you saw. Then compare the set against the diff. A
changed page, or a shared piece the diff touches, with no shot at a width
gets a line `not shown: <screen> at <width>`. That alone never holds the
PR; the verifier captures those screens on its run and the human sees them
on the parent PR. If the code makes you think the unshown screen is
actually broken, that's a normal required finding.

Screenshots are stills. They prove layout and what's on the page; they say
nothing about flashing, timing or motion. Rules 4 and 5 below are judged
from the code, and anything that has to be seen moving belongs in the
regressions lens's Test plan, which the verifier runs.

## Check

1. **Nothing uninvited.** The change adds only the UI its issue asks for.
   Extra buttons, banners, badges, helper text or sections nobody requested
   are required findings.
2. **Reuse first.** Existing components and patterns before anything new.
   When the same piece now appears in several places (a back button, a page
   header), it should be one shared component.
3. **Consistency.** New screens copy the spacing, headers, gaps and type of
   comparable existing pages, per `DESIGN.md`. Tokens and installed
   components only; no hardcoded colours or one-off values.
4. **Loading and flashing.** Route-level loading files over ad hoc
   `Suspense`. A parent route's loading file also covers its children, so
   watch for a parent skeleton flashing before the child's. Skeletons match
   the final layout and fade in; nothing flashes on fast loads. Navigating
   or updating doesn't remount what could stay mounted.
5. **Feedback.** Messages go through the project's toast system, not inline
   text, except recovery information that must stay on screen. Never a raw
   provider error code; errors follow `ERRORS.md`.
6. **States and access.** Empty, error and disabled states exist. Keyboard
   reach, visible focus, screen reader labels.
7. **Layout.** From the screenshots: nothing clipped, overlapping or
   unreachable at either width.
8. **SEO.** Public pages render on the server. Unique title and description
   per page, written in the words people search with. Canonical URL, one
   `h1`, sensible headings. Private pages stay out of the index and sitemap.
   Changed routes keep working links and redirects.
9. **Copy.** Product words from the glossary, plain and specific.

## Not your lens

Data logic, module structure and backend failures belong to other lenses.
One line under **Noticed, not mine**.
