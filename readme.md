# Claude Usage Uploader — Public Releases

This repository is the public distribution channel for Claude Usage Uploader, a cross-platform operations utility that collects approved local usage summaries and reliably synchronizes them for team reporting.

> This repository contains release binaries, checksums, and recovery tools only. Application source code, organization configuration, private infrastructure, credentials, and telemetry records are not published here.

[Download the latest stable release](https://github.com/Nishantjha1997/claude-uploader-releases/releases/latest) · [View every release](https://github.com/Nishantjha1997/claude-uploader-releases/releases)

## Why it exists

The uploader was designed for an operational environment where connectivity, machine restarts, concurrent writes, and fleet-wide updates cannot be treated as happy-path exceptions. Its reliability model includes:

- An offline-first durable outbox for work that cannot be delivered immediately.
- Idempotent synchronization, bounded retries, and replay-safe requests.
- Background health monitoring and repair-oriented update handover.
- Deterministic upload staggering so a fleet does not write at the same instant.
- Cross-platform packaging and checksum verification.
- Smoke-gated release publication.

Separating write streams reduced Apps Script lock collisions by 95% in the operating workflow this utility was built to support.

## Supported platforms

The latest stable release provides standalone builds for:

| Platform | Release asset |
| --- | --- |
| Windows x64 | `ClaudeUsageUploader_v2.0.5-win-x64.exe` |
| Linux x64 | `ClaudeUsageUploader_v2.0.5-linux-x64` |
| macOS Intel | `ClaudeUsageUploader_v2.0.5-macos-x64` |
| macOS Apple Silicon | `ClaudeUsageUploader_v2.0.5-macos-arm64` |

Windows recovery assets and `SHA256SUMS.txt` are included with the stable release.

## Installation and verification

1. Open the [latest stable release](https://github.com/Nishantjha1997/claude-uploader-releases/releases/latest).
2. Download the binary for the target operating system and `SHA256SUMS.txt`.
3. Verify the file checksum before running it.
4. Follow the organization-specific onboarding instructions supplied by the system administrator.

The executable alone is not an invitation to connect to a private deployment. Valid organization configuration is distributed separately and should never be posted in issues, logs, screenshots, or pull requests.

## High-level architecture

```text
Local usage source
        |
        v
Collector and normalizer
        |
        v
Durable local outbox ----> retry and recovery controls
        |
        v
Authenticated, idempotent sync
        |
        v
Operational reporting and health visibility
```

This diagram intentionally omits private endpoints, payloads, organization identifiers, credentials, and infrastructure details.

## Release reliability

Stable releases are packaged for every supported platform and include checksums. The release workflow verifies that critical artifacts start successfully before they are published. Current releases also include safer side-by-side Windows updates, background worker health checks, and recovery tooling for supported managed installations.

## Privacy and security

- Do not attach organization configuration, credentials, usage records, or diagnostic logs containing employee information to a public issue.
- Verify downloaded files against the published checksums.
- Use only releases from this repository's [GitHub Releases](https://github.com/Nishantjha1997/claude-uploader-releases/releases) page.
- Operational data ownership, retention, and access are governed by the organization running the private deployment.

## Troubleshooting

- Confirm that the correct platform and CPU architecture were downloaded.
- Re-check the SHA-256 checksum before retrying installation.
- On a managed Windows installation, use the recovery package supplied with the matching stable release only when directed by the administrator.
- For configuration, connectivity, or account issues, contact the administrator responsible for the private deployment. Do not share private configuration in this public repository.

## Portfolio case study

The product and reliability decisions behind this utility are described in a sanitized public case study at [nishant.top/work/claude-usage-uploader](https://nishant.top/work/claude-usage-uploader). The case study does not expose private source code or organizational data.
