# Project structure and repository boundary

The repository is organized by responsibility instead of by deployment instance.

| Path | Purpose | Public Git |
| --- | --- | --- |
| `cmd/` | CLI commands | Yes |
| `internal/` | Application-only Go packages | Yes |
| `pkg/` | Reusable Go packages | Yes |
| `frontend/` | Browser workbench and tests | Yes |
| `docs/` | Documentation source and static documentation assets | Yes |
| `scripts/` | Source-controlled maintenance and bridge tools | Yes |
| `tests/` | Python regression tests | Yes |
| `build/`, `docker/` | Reproducible build definitions | Yes |
| `dist/` | Compiled binaries and release archives | No |
| `config.yaml`, `.env*` | Machine and account configuration | No |
| `runtime/`, `workdir/`, `cache/` | Process state and caches | No |
| Databases, logs, downloads, media | User/runtime data | No |
| `AGENTS.md`, handoff and integration notes | Local operational context | No |

## Rules for new files

1. Put reusable code beside the subsystem it belongs to.
2. Put tests near the code for Go and JavaScript, or under `tests/` for the Python launcher helpers.
3. Put reusable documentation in `docs/`; keep machine-specific paths and production state in ignored local notes.
4. Never add a real configuration file as an example. Document fields with placeholders instead.
5. Never copy a production database, session, credential, log, downloaded reference, or media file into this tree.
6. Build into `dist/` and treat it as disposable output.

Before a commit, run:

```sh
python scripts/check_public_tree.py
```

The audit uses Git's ignore rules, so ignored local files may remain available to the operator without becoming part of the public repository.
