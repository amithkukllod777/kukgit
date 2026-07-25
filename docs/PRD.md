# KukGit Product Requirements Document

## Product statement

KukGit is an AI-first developer operating system that allows individuals and organizations to host source code, collaborate, automate quality, deploy software and manage the engineering lifecycle from one Kuklabs product.

## Problem

Modern engineering teams combine GitHub/GitLab, Jira, Confluence, CI vendors, package registries, security scanners, cloud dashboards, monitoring products and AI coding tools. This creates fragmented identity, cost, permissions, data and workflow.

## Target customers

1. Individual developers and students
2. Startups and small software teams
3. Indian and GCC businesses building internal software
4. Agencies managing repositories for multiple clients
5. Enterprises needing private or self-hosted developer infrastructure
6. Kuklabs product engineering teams

## Core jobs to be done

- create or import a repository
- securely clone and push code
- organize users, teams and permissions
- review branch changes before merge
- track bugs and engineering work
- understand security and technical debt
- run tests and builds
- publish packages and containers
- deploy and observe applications
- retain an auditable engineering record

## Product principles

- AI-first, not AI decoration
- secure tenant isolation
- Git compatible
- simple enough for small teams
- scalable enough for enterprise
- Kuklabs Account everywhere
- no forced lock-in: export repositories and data
- clear billing and usage visibility

## v0.1.0 acceptance criteria

- a signed-in organization owner can create a repository
- a public repository can be cloned with standard Git
- an authenticated user can push with the development token
- a user can inspect branches, commits, folders and files
- a developer can create branches and commits in the browser
- a developer can create issues and pull requests
- a maintainer can merge a conflict-free pull request
- a developer can run a repository health analysis
- material actions appear in the audit log

## Public beta acceptance criteria

- production SSO/MFA and invitations
- scoped PAT and SSH authentication
- PostgreSQL and object storage
- webhooks and notifications
- Git LFS
- CI runners and build logs
- billing and quotas
- abuse, malware and secret controls
- backups, restore tests and observability
- support and legal policies

## North-star metric

Weekly active organizations that complete a full loop:

```text
push code → open/review PR → pass automation → merge/deploy
```
