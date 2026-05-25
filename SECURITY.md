# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 3.3.x   | :white_check_mark: |
| < 3.3   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within Protocol Proxy, please send an email to liaoxinjie0579@gmail.com. All security vulnerabilities will be promptly addressed.

**Please do NOT report security vulnerabilities through public GitHub issues.**

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 1 week
- **Fix or mitigation**: within 2 weeks for critical issues

## Security Considerations

- API keys are stored locally in `config/proxies.json`
- Bearer token authentication is available for proxy endpoints
- The management UI should not be exposed to the public internet without proper authentication
