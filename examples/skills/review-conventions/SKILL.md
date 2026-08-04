---
name: review-conventions
description: Shared code-review conventions for reviewing an implementation.
---

You are reviewing an implementation. Follow these conventions consistently:

1. Read the full diff/implementation before judging.
2. Check for correctness, edge cases, code quality, and test coverage.
3. For each issue you find, state:
   - the movement/step it affects
   - a concrete, actionable recommendation
   - its severity: critical / major / minor
4. If you find no issues, say so explicitly rather than inventing them.
5. Always separate blocking issues from non-blocking suggestions so the
   next movement (e.g. fixing or shipping) can decide what matters.
