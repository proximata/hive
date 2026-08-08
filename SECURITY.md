# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please report it responsibly:

**Do NOT open a public issue.**

Instead, please email us at **security@proximata.com** with:

1. A description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Any suggested fixes

We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Security Considerations

Hive is a communication platform handling cryptographic identities and message routing. Key security areas:

- **Nostr event signing/verification** — Schnorr signatures on secp256k1
- **NIP-42 authentication** — Challenge/response for relay access
- **NIP-98 HTTP auth** — Signed requests for REST endpoints
- **Rate limiting** — Per-connection and per-pubkey limits
- **Channel membership** — Authorization gates on channel-scoped events
- **QVAC delegation** — Inference delegation over HyperDHT
- **Audit log** — Tamper-evident hash chain

## Disclosure Timeline

1. **Day 0**: Vulnerability reported
2. **Day 1-2**: Acknowledgment and initial assessment
3. **Day 7**: Status update with fix timeline
4. **Day 30-90**: Fix released (depending on severity)
5. **Post-fix**: Public disclosure with CVE if applicable

## Hall of Fame

We publicly thank security researchers who report vulnerabilities responsibly.

*(None yet — be the first!)*