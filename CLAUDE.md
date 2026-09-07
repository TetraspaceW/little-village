# Working here

Notes for whoever — person or model — is working in this repository. README.md
says what the game is, DESIGN.md says why it is that; this says how to avoid
making a mess of the repository they live in.

## A merge has a direction, and the request usually doesn't say which

"Merge in mistress" was said about an open pull request. It has two readings —
merge the PR into `mistress`, or merge `mistress` into the PR's branch to clear
its conflicts — and they are close to opposites. The PR got merged. Clearing the
conflicts was what was wanted.

So: when asked to merge and the direction is not spelled out, say which way you
are about to go and wait to be told. It costs one sentence. Guessing costs
everything below.

## Merging a pull request cannot be undone

Not by reverting, not by force-pushing the merge commit away. Once GitHub has
set `merged_at`:

- **The PR cannot be reopened.** The API refuses — *"state cannot be changed. The
  pull request cannot be reopened"* — and so does the button.
- **Its review thread is frozen.** The comments stay readable at the PR's URL
  forever, and nobody can ever add another one.
- **Maintainer push access to the contributor's fork branch is revoked**, so the
  merge that should have happened — theirs ← `mistress` — is no longer yours to
  do. It goes back to being the contributor's to make.

Taking the merge commit back out of `mistress` afterwards changes none of that.
All it decides is whether a *new* PR from that branch would show a diff — and a
plain `git revert -m 1` does not even manage that much, because the branch's
commits stay ancestors of `mistress` and the next PR from it comes up empty.

Whether the code was right is a different question from whether to merge it.
Merging is something done to somebody's pull request, and that call is theirs.

## `mistress` is the default branch

Work on a branch, push that, and leave the button for someone else. Pushing
straight to `mistress` — a merge commit or anything else — has to have been
asked for, that time, in so many words. A green test suite is not permission.
