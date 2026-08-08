# Contributing to Hive

Thank you for your interest in contributing to Hive! This document outlines the process and guidelines for contributing.

## Ways to Contribute

- **Code**: Bug fixes, features, performance improvements
- **Documentation**: README, SPEC.md, API docs, tutorials
- **Testing**: Unit tests, integration tests, fuzzing
- **Design**: Architecture discussions, UX for CLI
- **Community**: Answering questions, triaging issues, reviewing PRs

## Getting Started

### Prerequisites

- Node.js 22+
- npm 10+
- bare-runtime (installed via `npm install`)

### Development Setup

```bash
# Clone and install
git clone https://github.com/proximata/hive.git
cd hive
npm install

# Run tests
npm test

# Start relay for manual testing
npm start

# Build binary
npm run make
```

### Project Structure

```
bin.mjs · app.js · workers/main.js     hello-pear-bare shape
packages/
  hive-core       zero-I/O: kinds, verify, filters
  hive-store      SQLite store, search, audit
  hive-auth       NIP-42, NIP-98, scopes, rate limit
  hive-relay      protocol, pipeline, transports
  hive-sdk        typed event builders
  hive-cli        JSON CLI (buzz-cli compatible)
  hive-agent      personas, mention loop, QVAC
  hive-workflow   YAML workflows, approval gates
```

## Development Workflow

1. **Pick an issue** or create a new one
2. **Fork** the repository
3. **Create a branch**: `git checkout -b feat/your-feature-name`
4. **Make changes** following the guidelines below
5. **Test thoroughly**: `npm test && npm run lint`
6. **Commit** with conventional messages
7. **Push** and open a PR

## Code Style

- **JavaScript**: CommonJS, 2-space indent, semicolons
- **Conventional commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- **No lint errors**: `npm run lint` must pass
- **Tests required** for new functionality

## Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`, `revert`

Examples:
```
feat(relay): add NIP-50 search support
fix(store): handle concurrent writes correctly
docs(readme): add quick start section
test(core): add filter matching edge cases
```

## Pull Request Process

1. **Title**: Clear, follows conventional commits
2. **Description**: What, why, and how
3. **Related issue**: `Fixes #123` or `Relates to #123`
4. **Tests**: All pass, new tests for new features
5. **Documentation**: Updated if user-facing changes
6. **SPEC.md**: Updated if protocol/behavior changes
7. **Review**: Address feedback, maintain linear history

## Testing Guidelines

### Unit Tests
- Test file: `test/<package>.js`
- Use `brittle` test framework
- Mock external dependencies
- Test edge cases and error paths

### Integration Tests
- Test file: `test/integration.js`
- Test full relay + client flows
- Test p2p transport

### Running Tests
```bash
npm test              # All tests
npm test -- --grep "filter"  # Filter by name
```

## Architecture Principles

1. **Zero I/O in hive-core** — Pure functions, easy to test
2. **Kinds are the dispatch switch** — Unknown kinds ignored
3. **Agents = keypairs** — No special roles, same auth as humans
4. **Local inference** — QVAC optional, mock provider for tests
5. **Reachable without infra** — Hyperswarm dial by pubkey
6. **Audit everything** — Hash chain on every write

## Adding a New Kind

1. Add constant to `packages/hive-core/lib/kinds.js`
2. Add verification logic if needed
3. Add filter matching in `packages/hive-core/lib/filters.js`
4. Add store handling in `packages/hive-store/lib/handlers.js`
5. Add CLI command in `packages/hive-cli/lib/`
6. Add tests
7. Update SPEC.md

## Adding a New NIP

1. Implement in relevant package(s)
2. Add to supported NIPs list in README.md
3. Add tests
4. Update SPEC.md

## QVAC Integration

- `@qvac/sdk` is **optional peer dependency**
- Real provider behind `QVAC_PROVIDER=real` env
- Mock provider is default (zero deps, deterministic)
- Test with mock, document real usage

## Release Process

Maintainers only:

```bash
# 1. Version bump
npm version patch|minor|major

# 2. Build binaries
npm run make

# 3. Release
git push origin main --tags
# GitHub Release UI: attach binaries
```

## Getting Help

- **Questions**: Open a GitHub Discussion
- **Bugs**: Open an issue with the bug template
- **Features**: Open an issue with the feature template
- **Security**: Email security@proximata.com

## Recognition

Contributors are recognized in:
- GitHub contributors graph
- Release notes
- Hall of fame (for significant contributions)

Thank you for contributing to Hive! 🐝