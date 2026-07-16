# Interest profile (example)

Copy this to `interest-profile.md` and describe what YOU care about. The scorer (`pnpm score`)
reads this to judge how relevant each non-mutual you follow is to you, so the more specific and
honest you are, the better the keep/drop calls.

Write in plain prose. A few paragraphs is plenty. Cover things like:

- **What I build / work on** — e.g. "AI agents, browser automation, developer tools."
- **Topics I want in my feed** — e.g. "systems eng, startups/YC, applied ML research, design."
- **People I always want to keep** — founders/researchers/friends whose posts I never want to miss.
- **What's noise to me** — e.g. "crypto price talk, engagement-bait threads, generic hustle content."

The scorer combines this relevance signal with a notability signal, keeps your mutuals + anyone on
`data/allowlist.txt`, then marks the lowest-scoring non-mutuals as DROP until your following count
would hit `TARGET_FOLLOWING`.
