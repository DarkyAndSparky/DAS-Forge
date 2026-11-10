# Security policy

## Supported versions

DAS-Forge core is developed in small steps; only the **latest published release** of `@das-forge/core` receives security fixes. Before the first release (0.2.0) the current development build is the only supported one.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

1. Preferred: use GitHub's private reporting: *Security → Report a vulnerability* in this repository.
2. Otherwise write to **thedasforgeproject@gmail.com** with the subject `DAS-Forge security`.

Include: the affected version, what you did, what you expected and what happened, and a minimal way to reproduce it. A proof of concept is welcome; please do not test against systems you do not own.

## What to expect

| Step | Target |
|---|---|
| Acknowledgement of your report | 3 working days |
| First assessment (confirmed or not, severity) | 10 working days |
| Fix or mitigation for a confirmed high/critical issue | 30 days |
| Public advisory and credit (if you wish) | with the fix release |

This is a one-person project: the targets are goals, not a contract. If a deadline is missed you will be told why.

## Scope

In scope: the code in `packages/core`, the application template (`templates/app`), the Docker image built from this repository and the release workflow.

Out of scope: vulnerabilities in third-party packages that are already public (report them upstream; the core's dependency check and Dependabot follow them), findings that need a compromised server or administrator account, missing hardening that is documented as the operator's job (`docs/guide/10-operations.md`), denial of service by sheer traffic volume.

## Safe harbour

Good-faith research that follows this policy will not be pursued. Please give a reasonable time to fix before disclosing details.
