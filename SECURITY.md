# Security Policy

## Do not publish runtime data

This repository must not contain real credentials or runtime data. In particular, never commit:

- API tokens, cookies, authorization headers, account sessions, signing material, or generated private keys;
- `config.yaml`, `.env*`, `master.json`, databases, logs, caches, downloads, or content archives;
- screenshots or diagnostics that expose account identifiers, local paths, private content, or request headers.

The repository does not contain a private key. `go generate ./pkg/certificate` creates an ignored, clone-local development certificate pair. Never reuse that development pair as a user-specific or production certificate.

Run `python scripts/check_public_tree.py` before committing. The script inspects the Git candidate set and rejects common runtime/credential paths, private-key material, machine-specific absolute paths, and oversized artifacts.

## Reporting a vulnerability

Do not open a public Issue containing exploit details, tokens, logs, databases, or private media. Contact the repository owner privately through the security-reporting channel configured on the GitHub repository. Include only the minimum redacted reproduction needed to understand the problem.

If a credential may have been exposed, revoke or rotate it first. Removing it from a later commit does not remove it from Git history.
