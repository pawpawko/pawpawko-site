# Security Policy

We take security seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not file a public GitHub issue for security vulnerabilities.**

Instead, email **pawpaw_plays@pawpawko.com** with:

- A description of the issue and its impact
- Steps to reproduce (or a minimal proof-of-concept)
- The affected URL or commit, if known
- Your contact info (optional — we're happy to credit researchers who want it)

We'll acknowledge your report within **3 business days**, and aim to provide a substantive response (fix, mitigation, or disclosure timeline) within **14 days**. Complex issues may take longer; we'll keep you informed.

## Scope

In scope:

- The live site at `pawpawko.com`
- This repository's source code (`pawpaw-ko/pawpawko-site`)
- The Supabase backend (auth, database, storage policies)

Out of scope:

- Denial-of-service attacks against the live site
- Social-engineering of Pawpaw Ko team members or users
- Physical attacks
- Issues in third-party services (Supabase, Cloudflare R2, Netlify) — please report those to the respective vendors

## Safe-harbor

If you make a good-faith effort to follow this policy, we will not pursue or support any legal action against you related to your research. We ask that you:

- Only test against your own account / data
- Do not access, modify, or destroy data belonging to other users
- Do not exfiltrate more data than necessary to demonstrate the vulnerability
- Give us a reasonable window to remediate before public disclosure

Thank you for helping keep Pawpaw Ko and its community safe.
