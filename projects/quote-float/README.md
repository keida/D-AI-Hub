# Quote Float

## Purpose

Quote Float is a lightweight Windows desktop widget that keeps the quota windows returned by the local Codex Desktop session visible.

## Scope

The active product track is the native WPF R1 implementation. It includes the accepted Civic Full and Orb surfaces and their Windows interaction foundation. The legacy WinForms implementation remains protected and is not the active UI baseline.

## Architecture

- `wpf/` in the source repository contains the .NET 8 WPF application.
- `docs/wpf-r1/` owns ticket scope and implementation specifications.
- `output/wpf-r1/` contains runtime, visual, and Boss acceptance evidence.
- This directory records durable project state only; it does not duplicate implementation logs or product artifacts.

## Repositories / Environments

- Source repository: `https://github.com/keida/codex-quota-float`
- Runtime target: Windows desktop, WPF, .NET 8
- D-AI runtime project identity: `codex-quota-float` (derived from the canonical remote repository)
- Human-facing project name: `Quote Float`

## Current continuation entry point

Read `STATUS.md` first, then `DECISIONS.md`, `BUGS.md`, `ROADMAP.md`, and `REFERENCES.md`.
