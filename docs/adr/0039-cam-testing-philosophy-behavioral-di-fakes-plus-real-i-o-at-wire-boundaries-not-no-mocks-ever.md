# ADR 0039: cam testing philosophy: behavioral DI-fakes plus real-I/O at wire boundaries, not no-mocks-ever

## Context

CAM-62 codifies test-quality rules into the reviewer, sourced from warren's CONSTITUTION Art. IV and sibling projects' 'no mocks' CONTRIBUTING rules. But cam-cli's own test suite uses behavioral dependency-injected fakes pervasively (119 of 252 files) and zero module-mocking; a verbatim 'no mocks / FAIL any new fake' rule would flag nearly half the suite and contradict the project's documented, correct convention (patterns.md: inject fake reader/writer shapes). Separately, the CAM-55 fakes-lie incident shipped two tmux bugs past 925 unit tests and 3 CLEAN reviews because the fakes encoded the output the buggy code expected.

## Decision

Adopt a nuanced rule rather than warren's verbatim one: (1) ban only tautological 'the mock was called' assertions; (2) mandate at least one real-I/O integration test at each wire boundary (git/tmux/gh/filesystem); (3) explicitly allow behavioral DI-fakes that reproduce a real dependency's output. The reviewer enforces this by judgment (Layer B); a deterministic setTimeout/sleep gate is split to a follow-up.

## Consequences

cam deliberately diverges from the no-mocks-ever stance of the projects that inspired the issue: fast fake-based unit tests stay the bulk of the suite, backed by a deliberately thin real-I/O tier (test/integration/, 29 files) at the boundaries where fakes have historically lied. Reversing to no-mocks-ever would invalidate ~119 test files, so the choice is costly to unwind. The rule prevents both gamed/tautological tests and the fakes-lie class without banning the project's core testing idiom.
